/**
 * End-to-end smoke test for the built plugin.
 *
 * Forks dist/worker.js the way the Paperclip host does (stdio pipes, NDJSON
 * JSON-RPC), plays the host side of the protocol — answering the worker's
 * config.get and secrets.resolve calls — and drives real tool calls against a
 * stub BigCommerce listening on 127.0.0.1.
 *
 * The loopback address is deliberate twice over: it is exactly the kind of
 * address the host's gated plugin fetch helper refuses, so a pass here
 * demonstrates the worker reaching a private endpoint through the runtime's
 * own fetch — and it is the one case where the plugin accepts plain http, so
 * the `apiOrigin` escape hatch is exercised rather than assumed.
 */
import { fork } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the package root from this file, so the script runs from anywhere.
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "bc-smoke-access-token";
const STORE_HASH = "smokehash1";

const seenAuth = [];
const seenPaths = [];

const store = createServer((req, res) => {
  seenAuth.push(req.headers["x-auth-token"] ?? "(none)");
  seenPaths.push(req.url);
  if (req.headers["x-auth-token"] !== TOKEN) {
    res.writeHead(401).end("unauthorized");
    return;
  }

  const json = (body) =>
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));

  const [pathname, search] = req.url.split("?");
  const params = new URLSearchParams(search ?? "");

  if (pathname === `/stores/${STORE_HASH}/v2/store`) {
    json({
      id: 1,
      name: "Smoke Supply Co",
      domain: "smoke.test",
      currency: "USD",
      weight_units: "LBS",
      timezone: { name: "America/Chicago" },
      plan_name: "Standard",
      store_hash: STORE_HASH,
    });
    return;
  }

  if (pathname === `/stores/${STORE_HASH}/v3/catalog/products`) {
    // Echo the keyword back through the data, so a pass proves the filter
    // reached the API rather than being dropped on the floor.
    const keyword = params.get("keyword");
    const products =
      keyword === null || keyword === "wrench"
        ? [
            {
              id: 42,
              name: "Pipe Wrench",
              sku: "PW-14",
              price: 24.99,
              inventory_level: 6,
              is_visible: true,
            },
          ]
        : [];
    json({
      data: products,
      meta: { pagination: { total: products.length, total_pages: 1, current_page: 1 } },
    });
    return;
  }

  // v2 collections answer "nothing matched" with 204 and no body. The worker
  // has to read that as an empty page rather than as a parse failure.
  if (pathname === `/stores/${STORE_HASH}/v2/orders`) {
    res.writeHead(204).end();
    return;
  }

  // Every scope-gated endpoint the plugin exposes can answer 403 on a token
  // that was deliberately issued without that scope.
  if (pathname === `/stores/${STORE_HASH}/v3/customers`) {
    res.writeHead(403, { "content-type": "application/json" }).end(
      JSON.stringify({ status: 403, title: "Insufficient scope" }),
    );
    return;
  }

  res.writeHead(404).end("not found");
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

const callTool = (toolName, parameters) =>
  send("executeTool", { toolName, parameters, runContext });

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

  const storeInfo = await callTool("get_store_info", {});
  if (storeInfo?.error) fail(`get_store_info returned an error: ${storeInfo.error}`);
  console.log("executeTool(get_store_info):", JSON.stringify(storeInfo.data));
  if (storeInfo.data?.name !== "Smoke Supply Co") fail("wrong store returned");
  if (storeInfo.data?.timezone !== "America/Chicago") fail("timezone was not flattened");

  const products = await callTool("list_products", { keyword: "wrench", limit: 10 });
  if (products?.error) fail(`list_products returned an error: ${products.error}`);
  console.log(
    `executeTool(list_products, keyword=wrench): returned=${products.data?.pagination?.returned} product=${JSON.stringify(products.data?.products?.[0])}`,
  );
  if (products.data?.products?.[0]?.sku !== "PW-14") fail("wrong product returned");
  if (products.data?.pagination?.hasMore !== false) fail("pagination was not normalized");

  // Prove the filter reached the API: an unmatched keyword must come back
  // empty rather than returning the same canned row.
  const noMatch = await callTool("list_products", { keyword: "anvil" });
  if (noMatch.data?.pagination?.returned !== 0) fail("the keyword filter never reached the API");
  console.log("executeTool(list_products, keyword=anvil): returned=0 (filter reached the API)");

  const orders = await callTool("list_orders", {});
  if (orders?.error) fail(`list_orders returned an error: ${orders.error}`);
  if (!Array.isArray(orders.data?.orders) || orders.data.orders.length !== 0) {
    fail("a v2 204 should read as an empty page");
  }
  console.log("executeTool(list_orders) -> 204 read as an empty page");

  const scoped = await callTool("list_customers", {});
  console.log("executeTool(list_customers, 403) ->", JSON.stringify(scoped?.error));
  if (!/OAuth scope/.test(scoped?.error ?? "")) {
    fail("a 403 should name the missing scope");
  }

  const badArgument = await callTool("get_product", { productId: "forty-two" });
  console.log("executeTool(get_product, bad id) ->", JSON.stringify(badArgument?.error));
  if (!/must be an integer/.test(badArgument?.error ?? "")) {
    fail("a bad argument should surface as a fixable tool error");
  }

  console.log("host calls made by worker:", [...new Set(hostCalls)].join(", "));
  console.log("stub store saw paths:", seenPaths.length);
  console.log(
    "stub store saw auth:",
    seenAuth[0] === TOKEN ? "X-Auth-Token: <resolved secret>" : seenAuth[0],
  );

  if (!hostCalls.includes("secrets.resolve")) fail("worker never resolved the secret ref");
  if (seenAuth[0] !== TOKEN) fail("token did not arrive as an X-Auth-Token header");
  if (seenAuth.some((value) => value !== TOKEN)) fail("some request went out unauthenticated");

  console.log(
    "\nPASS: forked worker spoke the protocol, resolved its secret, and read a loopback BigCommerce stub.",
  );
} catch (error) {
  fail(error.message);
}

child.kill();
store.close();
process.exit(0);
