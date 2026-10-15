#!/usr/bin/env node
/**
 * Regenerate `tests/openapi-contract.json` from BigCommerce's published
 * OpenAPI specs.
 *
 * Why this exists: the first version of this plugin shipped three broken tools
 * behind a green test suite, because every fixture was written in the shape the
 * implementation expected. A fixture that agrees with the code proves nothing.
 * So the committed contract file is derived from BigCommerce's own machine-
 * readable specs, and `tests/openapi-contract.spec.ts` checks both the requests
 * this plugin builds and the fixtures the other tests use against it.
 *
 * The output is committed so the suite runs offline. Re-run this after
 * changing an endpoint or filter, and commit the diff:
 *
 *   npm run sync-contract
 *
 * A diff in the `sha256` of a spec means BigCommerce changed it; a diff in an
 * endpoint's parameters or properties is the part worth reading.
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SPEC_BASE = "https://docs.bigcommerce.com/openapi";

/**
 * Every endpoint this plugin calls, and the spec that documents it. Adding a
 * tool means adding its endpoint here; the contract test fails for a request
 * aimed at a path this file does not list, so the two cannot drift.
 */
const ENDPOINTS = [
  { path: "/v2/store", spec: "admin-management-store-information-v2" },
  { path: "/v3/catalog/summary", spec: "admin-catalog-products" },
  { path: "/v3/catalog/products", spec: "admin-catalog-products" },
  { path: "/v3/catalog/products/{product_id}", spec: "admin-catalog-products" },
  { path: "/v3/catalog/products/{product_id}/variants", spec: "admin-catalog-product-variants" },
  { path: "/v3/catalog/trees", spec: "admin-catalog-category-trees" },
  { path: "/v3/catalog/trees/categories", spec: "admin-catalog-category-trees" },
  { path: "/v3/catalog/brands", spec: "admin-catalog-brands" },
  { path: "/v2/orders", spec: "admin-management-orders" },
  { path: "/v2/orders/{order_id}", spec: "admin-management-orders" },
  { path: "/v2/orders/{order_id}/products", spec: "admin-management-orders" },
  { path: "/v3/customers", spec: "admin-management-customers-v3" },
  { path: "/v3/inventory/items", spec: "admin-management-inventory" },
  { path: "/v3/inventory/locations", spec: "admin-management-inventory" },
];

/** How deep response property names are recorded. Deeper nesting is unused. */
const MAX_DEPTH = 4;

async function loadSpec(name) {
  const url = `${SPEC_BASE}/${name}.json`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`);
  }
  const text = await response.text();
  return {
    url,
    sha256: createHash("sha256").update(text).digest("hex"),
    document: JSON.parse(text),
  };
}

function deref(document, node, seen = new Set()) {
  let current = node;
  while (current && typeof current === "object" && typeof current.$ref === "string") {
    if (seen.has(current.$ref)) return {};
    seen.add(current.$ref);
    const segments = current.$ref.replace(/^#\//, "").split("/");
    current = segments.reduce((value, segment) => value?.[segment], document);
  }
  return current ?? {};
}

/** Merge the branches of allOf/oneOf/anyOf, so a union documents every member. */
function variants(document, schema) {
  const resolved = deref(document, schema);
  const branches = [
    ...(resolved.allOf ?? []),
    ...(resolved.oneOf ?? []),
    ...(resolved.anyOf ?? []),
  ];
  if (branches.length === 0) return [resolved];
  return [resolved, ...branches.flatMap((branch) => variants(document, branch))];
}

/**
 * Flatten a response schema into `pointer -> property names`.
 *
 * `""` is the response root, `"data[]"` one row of a v3 collection,
 * `"data[].locations[].settings"` the nested object three levels in. The test
 * uses this to reject a fixture property BigCommerce does not document.
 */
function propertyMap(document, schema, pointer = "", into = {}, depth = 0) {
  if (depth > MAX_DEPTH) return into;
  for (const branch of variants(document, schema)) {
    if (branch.type === "array" || branch.items) {
      propertyMap(document, branch.items ?? {}, `${pointer}[]`, into, depth + 1);
      continue;
    }
    const properties = branch.properties;
    if (!properties || typeof properties !== "object") continue;
    const names = new Set(into[pointer] ?? []);
    for (const name of Object.keys(properties)) names.add(name);
    into[pointer] = [...names].sort();
    for (const [name, child] of Object.entries(properties)) {
      const childPointer = pointer === "" ? name : `${pointer}.${name}`;
      propertyMap(document, child, childPointer, into, depth + 1);
    }
  }
  return into;
}

function responseSchema(document, operation) {
  const ok = operation.responses?.["200"] ?? {};
  const resolved = deref(document, ok);
  const content = resolved.content ?? {};
  const json = content["application/json"] ?? Object.values(content)[0] ?? {};
  return json.schema ?? {};
}

function queryParameters(document, pathItem, operation) {
  const declared = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])];
  const query = {};
  for (const parameter of declared) {
    const resolved = deref(document, parameter);
    if (resolved.in !== "query" || typeof resolved.name !== "string") continue;
    const schema = deref(document, resolved.schema ?? {});
    query[resolved.name] =
      typeof schema.maximum === "number" ? { maximum: schema.maximum } : {};
  }
  return query;
}

const specs = {};
const endpoints = {};

for (const endpoint of ENDPOINTS) {
  specs[endpoint.spec] ??= await loadSpec(endpoint.spec);
  const { document } = specs[endpoint.spec];
  const specPath = `/stores/{store_hash}${endpoint.path}`;
  const pathItem = document.paths?.[specPath];
  if (!pathItem?.get) {
    throw new Error(`${endpoint.spec} documents no GET ${specPath}`);
  }
  endpoints[endpoint.path] = {
    spec: endpoint.spec,
    specPath,
    queryParameters: queryParameters(document, pathItem, pathItem.get),
    responseProperties: propertyMap(document, responseSchema(document, pathItem.get)),
  };
}

const contract = {
  note:
    "Generated by scripts/sync-openapi-contract.mjs from BigCommerce's published OpenAPI specs. Do not hand-edit — re-run `npm run sync-contract` and commit the diff.",
  generatedAt: new Date().toISOString().slice(0, 10),
  specs: Object.fromEntries(
    Object.entries(specs).map(([name, spec]) => [name, { url: spec.url, sha256: spec.sha256 }]),
  ),
  endpoints,
};

const target = fileURLToPath(new URL("../tests/openapi-contract.json", import.meta.url));
writeFileSync(target, `${JSON.stringify(contract, null, 2)}\n`);
console.log(`Wrote ${target}`);
for (const [name, spec] of Object.entries(specs)) {
  console.log(`  ${name} ${spec.sha256.slice(0, 12)}`);
}
