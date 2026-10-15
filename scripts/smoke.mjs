/**
 * End-to-end smoke test for the built plugin.
 *
 * Forks dist/worker.js the way the Paperclip host does (stdio pipes, NDJSON
 * JSON-RPC), plays the host side of the protocol — answering the worker's
 * config.get and secrets.resolve calls — and drives every tool in the catalog
 * against a stub BigCommerce listening on 127.0.0.1.
 *
 * The loopback address is deliberate twice over: it is exactly the kind of
 * address the host's gated plugin fetch helper refuses, so a pass here
 * demonstrates the worker reaching a private endpoint through the runtime's
 * own fetch — and it is the one case where the plugin accepts plain http, so
 * the `apiOrigin` escape hatch is exercised rather than assumed.
 *
 * The stub answers from `tests/openapi-fixtures.json`, the same spec-shaped
 * bodies the unit tests use, because the previous version of this script
 * hand-stubbed four endpoints and the three tools it never touched were
 * exactly the three that were broken. Every tool is called here now, and the
 * stub refuses any path the plugin is not supposed to request.
 */
import { fork } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the package root from this file, so the script runs from anywhere.
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "bc-smoke-access-token";
const STORE_HASH = "smokehash1";

const fixtures = JSON.parse(
  readFileSync(`${PLUGIN_DIR}/tests/openapi-fixtures.json`, "utf8"),
).endpoints;

/** Match a requested path to its fixture key, numeric segments standing in for IDs. */
function fixtureKey(pathname) {
  const requested = pathname.replace(`/stores/${STORE_HASH}`, "").split("/");
  return Object.keys(fixtures).find((candidate) => {
    const segments = candidate.split("/");
    if (segments.length !== requested.length) return false;
    return segments.every((segment, index) =>
      segment.startsWith("{") ? /^\d+$/.test(requested[index]) : segment === requested[index],
    );
  });
}

const seenAuth = [];
const seenRequests = [];

const store = createServer((req, res) => {
  seenAuth.push(req.headers["x-auth-token"] ?? "(none)");
  seenRequests.push(req.url);
  if (req.headers["x-auth-token"] !== TOKEN) {
    res.writeHead(401).end("unauthorized");
    return;
  }

  const json = (body) =>
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));

  const [pathname, search] = req.url.split("?");
  const params = new URLSearchParams(search ?? "");
  const key = fixtureKey(pathname);

  if (key === undefined) {
    res.writeHead(404).end("not found");
    return;
  }

  // Echo one filter back through the data per API version, so a pass proves
  // the filter reached the API rather than being dropped on the floor.
  if (key === "/v3/catalog/products" && params.get("keyword") === "anvil") {
    json({ data: [], meta: { pagination: { total: 0, total_pages: 0, current_page: 1 } } });
    return;
  }

  // v2 collections answer "nothing matched" with 204 and no body. The worker
  // has to read that as an empty page rather than as a parse failure.
  if (key === "/v2/orders" && params.get("status_id") === "99") {
    res.writeHead(204).end();
    return;
  }

  // Every scope-gated endpoint can answer 403 on a token that was deliberately
  // issued without that scope. Customers is the usual one to withhold.
  if (key === "/v3/customers" && params.get("email:in") === "denied@example.test") {
    res.writeHead(403, { "content-type": "application/json" }).end(
      JSON.stringify({ status: 403, title: "Insufficient scope" }),
    );
    return;
  }

  json(fixtures[key].body);
});

await new Promise((resolve) => store.listen(0, "127.0.0.1", resolve));
const apiOrigin = `http://127.0.0.1:${store.address().port}`;

const manifest = (await import(`${PLUGIN_DIR}/dist/manifest.js`)).default;

const child = fork(`${PLUGIN_DIR}/dist/worker.js`, [], {
  stdio: ["pipe", "pipe", "pipe", "ipc"],
  env: { PATH: process.env.PATH, NODE_ENV: "production", TZ: "UTC" },
});

const pending = new Map();
let nextId = 1;

function send(method, params) {
  const id = nextId++;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20000);
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return promise;
}

function reply(id, result) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

const hostCalls = [];

createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log("  [worker stdout non-JSON]", line.slice(0, 160));
    return;
  }

  // A response to something we sent.
  if (msg.id !== undefined && msg.method === undefined) {
    const waiter = pending.get(msg.id);
    if (waiter) {
      pending.delete(msg.id);
      msg.error ? waiter.reject(new Error(JSON.stringify(msg.error))) : waiter.resolve(msg.result);
    }
    return;
  }

  // An outbound host call from the worker — we are the host.
  if (msg.method) {
    hostCalls.push(msg.method);
    if (msg.method === "config.get") {
      reply(msg.id, {
        storeHash: STORE_HASH,
        accessToken: { type: "secret_ref", secretId: "secret-smoke" },
        apiOrigin,
      });
    } else if (msg.method === "secrets.resolve") {
      reply(msg.id, TOKEN);
    } else if (msg.id !== undefined) {
      reply(msg.id, null);
    }
  }
});

createInterface({ input: child.stderr }).on("line", (l) =>
  console.log("  [worker stderr]", l.slice(0, 200)),
);

const fail = (msg) => {
  console.log(`\nFAIL: ${msg}`);
  child.kill();
  store.close();
  process.exit(1);
};

const runContext = {
  agentId: "agent-smoke",
  runId: "run-smoke",
  companyId: "company-smoke",
  projectId: "project-smoke",
};

/** Every tool this run drove, so the "every tool" claim below is checked. */
const toolsCalled = new Set();

const callTool = (toolName, parameters) => {
  toolsCalled.add(toolName);
  return send("executeTool", { toolName, parameters, runContext });
};

/** Call one tool, fail on a tool error, and hand back its structured data. */
async function ok(toolName, parameters = {}) {
  const result = await callTool(toolName, parameters);
  if (result?.error) fail(`${toolName} returned an error: ${result.error}`);
  return result.data;
}

try {
  await send("initialize", {
    manifest,
    config: {},
    instanceInfo: {
      instanceId: "00000000-0000-0000-0000-000000000000",
      hostVersion: "0.0.0-smoke",
    },
    apiVersion: 1,
  });
  console.log("initialize: ok");

  const health = await send("health", {});
  console.log("health:", JSON.stringify(health));

  const storeInfo = await ok("get_store_info");
  console.log("get_store_info:", JSON.stringify(storeInfo));
  if (storeInfo?.name !== "Brobston Supply") fail("wrong store returned");
  if (storeInfo?.timezone !== "America/Chicago") fail("timezone was not flattened");
  // `/v2/store` keeps the hash in `id` and the numeric ID in `store_id`.
  if (storeInfo?.storeHash !== "abc123") fail("storeHash was not read from the store record's id");
  if (typeof storeInfo?.storeId !== "number") fail("the numeric store ID was dropped");

  const summary = await ok("get_catalog_summary");
  if (summary?.variantCount !== 980) fail("catalog summary was not unwrapped");
  console.log(`get_catalog_summary: variants=${summary.variantCount}`);

  const products = await ok("list_products", {
    keyword: "wrench",
    sort: "date_modified",
    direction: "desc",
    limit: 10,
  });
  if (products?.products?.[0]?.sku !== "PW-14") fail("wrong product returned");
  if (products?.pagination?.hasMore !== true) fail("pagination was not normalized");
  console.log(`list_products: returned=${products.pagination.returned} sku=${products.products[0].sku}`);

  // Prove the filter reached the API: an unmatched keyword must come back
  // empty rather than returning the same canned row.
  const noMatch = await ok("list_products", { keyword: "anvil" });
  if (noMatch?.pagination?.returned !== 0) fail("the keyword filter never reached the API");
  console.log("list_products(keyword=anvil): returned=0 (filter reached the API)");

  const product = await ok("get_product", { productId: 42, include: ["variants"] });
  if (product?.id !== 42) fail("get_product did not unwrap the v3 envelope");
  console.log(`get_product: id=${product.id} name=${JSON.stringify(product.name)}`);

  const variants = await ok("list_product_variants", { productId: 42 });
  if (variants?.variants?.[0]?.sku !== "PW-14-RED") fail("wrong variant returned");
  console.log(`list_product_variants: ${variants.variants.length} variant(s)`);

  // The trees themselves, which is how a storefront name becomes a treeId —
  // and how an empty category list is told apart from a tree that is not there.
  const trees = await ok("list_category_trees", {});
  if (trees?.trees?.length !== 2) fail("the category trees were not listed");
  if (trees.trees[0]?.name !== "Storefront") fail("tree names were not read");
  if (!Array.isArray(trees.trees[0]?.channelIds)) fail("storefront channels were dropped");
  console.log(`list_category_trees: ${JSON.stringify(trees.trees)}`);

  // The flat categories endpoint: every level of the hierarchy, each row
  // naming its tree. The nested endpoint returned the root level only.
  const categories = await ok("list_categories", {});
  const names = categories?.categories?.map((category) => category.name) ?? [];
  console.log(`list_categories: ${JSON.stringify(names)}`);
  if (!names.includes("Pipe Wrenches")) fail("subcategories were dropped");
  if (categories.categories.at(-1)?.treeName !== "Wholesale") fail("tree names were not resolved");
  if (categories.categories[1]?.sortOrder !== 2) fail("sortOrder came back null");

  const rootsOnly = await ok("list_categories", { treeId: 1, parentId: 0 });
  if (rootsOnly?.categories === undefined) fail("parentId 0 was refused");
  console.log("list_categories(parentId=0): accepted");

  const brands = await ok("list_brands", { name: "Ridgid" });
  if (brands?.brands?.[0]?.customUrl !== "/ridgid/") fail("brand custom_url was not lifted");
  console.log(`list_brands: ${JSON.stringify(brands.brands[0])}`);

  const orders = await ok("list_orders", { sort: "date_created:desc" });
  if (orders?.orders?.[0]?.billingEmail !== "buyer@example.test") {
    fail("the billing email was not lifted out of the address");
  }
  console.log(`list_orders: ${orders.orders.length} order(s), id=${orders.orders[0].id}`);

  const emptyOrders = await ok("list_orders", { statusId: 99 });
  if (emptyOrders?.orders?.length !== 0) fail("a v2 204 should read as an empty page");
  console.log("list_orders(statusId=99) -> 204 read as an empty page");

  const order = await ok("get_order", { orderId: 1042 });
  if (order?.billingAddress?.city !== "Dallas") fail("the billing address was not mapped");
  const orderText = JSON.stringify(order);
  if (orderText.includes("203.0.113.42") || orderText.includes("Called the customer")) {
    fail("get_order passed through a field the allowlist drops");
  }
  console.log(`get_order: total=${order.totalIncTax} ip/staff_notes withheld`);

  const lineItems = await ok("list_order_products", { orderId: 1042 });
  if (lineItems?.lineItems?.[0]?.quantity !== 2) fail("line items were not summarized");
  console.log(`list_order_products: ${lineItems.lineItems.length} line item(s)`);

  const customers = await ok("list_customers", { email: "buyer@example.test" });
  if (customers?.customers?.[0]?.id !== 55) fail("wrong customer returned");
  if (JSON.stringify(customers).includes("555-0100")) fail("the phone number was not dropped");
  console.log(`list_customers: id=${customers.customers[0].id}, phone withheld`);

  // Per-location stock, read from `{ identity, locations[] }` with safety
  // stock under `locations[].settings`. The old mapping returned all nulls.
  const inventory = await ok("list_inventory", { skus: ["PW-14-RED", "PW-18"] });
  console.log(`list_inventory: ${JSON.stringify(inventory.items)}`);
  if (inventory?.items?.length !== 3) fail("locations[] was not flat-mapped into rows");
  const dallas = inventory.items.find((item) => item.locationCode === "DAL");
  if (dallas?.availableToSell !== 4) fail("stock numbers came back null");
  if (dallas?.safetyStock !== 2) fail("safety stock was not read from settings");
  if (dallas?.isInStock !== true) fail("in-stock status was not read from settings");
  if (inventory?.pagination?.skusReturned !== 2) fail("skusReturned did not count SKUs");
  if (inventory?.pagination?.rowsReturned !== 3) fail("rowsReturned did not count rows");

  // The stub answers the same two-location body whatever `location_id:in` says,
  // which is the dangerous reading of that filter: it may select *items* rather
  // than prune each item's `locations[]`. Asking for Dallas and being handed an
  // Austin row is a wrong number an agent cannot see, so the rows are narrowed
  // locally too — and this is what proves it, since no amount of contract
  // checking can tell whether a filter was applied.
  const dallasOnly = await ok("list_inventory", { locationIds: [1] });
  if (dallasOnly.items.some((item) => item.locationId !== 1)) {
    fail(`locationIds did not narrow the rows: ${JSON.stringify(dallasOnly.items)}`);
  }
  // The stub serves the same three-row body, so the Austin row being gone is
  // this plugin's own narrowing and nothing else.
  if (dallasOnly.items.length !== 2) fail("the matching location rows were not all returned");
  if (dallasOnly.pagination?.rowsReturned !== 2) fail("rowsReturned did not follow the filter");
  console.log(
    `list_inventory(locationIds=[1]): ${dallasOnly.items.length} row(s), all location 1, Austin dropped`,
  );

  const locations = await ok("list_locations", { locationIds: [1, 2] });
  if (locations?.locations?.[0]?.label !== "Dallas Warehouse") fail("wrong location returned");
  const locationQuery = seenRequests.at(-1);
  if (!locationQuery.includes("location_id%3Ain") && !locationQuery.includes("location_id:in")) {
    fail(`list_locations sent an undocumented filter: ${locationQuery}`);
  }
  console.log(`list_locations: ${locations.locations.length} location(s), filtered by location_id:in`);

  const scoped = await callTool("list_customers", { email: "denied@example.test" });
  console.log("list_customers(403) ->", JSON.stringify(scoped?.error));
  if (!/OAuth scope/.test(scoped?.error ?? "")) fail("a 403 should name the missing scope");

  const badArgument = await callTool("get_product", { productId: "forty-two" });
  console.log("get_product(bad id) ->", JSON.stringify(badArgument?.error));
  if (!/must be an integer/.test(badArgument?.error ?? "")) {
    fail("a bad argument should surface as a fixable tool error");
  }

  console.log("host calls made by worker:", [...new Set(hostCalls)].join(", "));
  console.log("stub store saw requests:", seenRequests.length);
  console.log(
    "stub store saw auth:",
    seenAuth[0] === TOKEN ? "X-Auth-Token: <resolved secret>" : seenAuth[0],
  );

  // A 404 here would mean the plugin asked for a path the fixtures — and so
  // the published specs — do not cover.
  if (!hostCalls.includes("secrets.resolve")) fail("worker never resolved the secret ref");
  if (seenAuth[0] !== TOKEN) fail("token did not arrive as an X-Auth-Token header");
  if (seenAuth.some((value) => value !== TOKEN)) fail("some request went out unauthenticated");

  // "Drives every tool in the catalog" was a claim in this file's header that
  // nothing checked, and it had already gone stale once: a tool added to the
  // manifest was never called here. The three endpoint defects QA found all
  // lived in tools the old version of this script never touched, so the claim
  // is the whole point of the script and is now enforced rather than asserted.
  const declared = manifest.tools.map((tool) => tool.name);
  const untouched = declared.filter((name) => !toolsCalled.has(name));
  if (untouched.length > 0) fail(`tools never driven by this smoke test: ${untouched.join(", ")}`);
  const undeclared = [...toolsCalled].filter((name) => !declared.includes(name));
  if (undeclared.length > 0) fail(`smoke test called undeclared tools: ${undeclared.join(", ")}`);
  console.log(`tools driven: ${declared.length}/${declared.length} in the manifest`);

  console.log(
    "\nPASS: forked worker spoke the protocol, resolved its secret, and read every tool's endpoint off a loopback BigCommerce stub.",
  );
} catch (error) {
  fail(error.message);
}

child.kill();
store.close();
process.exit(0);
