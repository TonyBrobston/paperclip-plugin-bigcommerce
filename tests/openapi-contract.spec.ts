/**
 * The suite's backstop: check this plugin against BigCommerce's published
 * contract rather than against itself.
 *
 * The first version of this plugin shipped three broken tools behind 111 green
 * tests, because every fixture was written in the shape the implementation
 * expected — `list_inventory` read eight fields off the wrong nesting level and
 * the fixture obligingly put them there. A test like that asserts the code
 * against itself and can only ever pass.
 *
 * So these tests have one source of truth that the implementation cannot
 * influence: `openapi-contract.json`, generated from BigCommerce's own
 * machine-readable specs by `scripts/sync-openapi-contract.mjs`. Four things
 * are checked against it:
 *
 *  1. every query parameter this plugin sends is documented for the endpoint
 *     it is sent to, and every path it requests is an endpoint that exists;
 *  2. every property name in `openapi-fixtures.json` appears in the response
 *     schema it claims to come from, so a fixture cannot drift into the shape
 *     the code happens to want — including at nesting levels the generator
 *     records no properties for, which are a failure rather than a skip;
 *  3. where a parameter's documented values are authoritative, the allowlist
 *     this plugin enforces matches them;
 *  4. the paging ceiling this plugin enforces is within the documented one.
 *
 * Checks 1, 2 and 4 would all have failed on the original `list_categories`,
 * `list_inventory` and `list_locations`.
 *
 * What this guard still cannot see, so that nobody reads more into a green run
 * than it earned:
 *
 *  - whether a filter is *applied*. It checks that `location_id:in` is a
 *    documented parameter, not that the rows coming back are narrowed by it.
 *  - which field the code reads a value *from*. Reading `location_name` into
 *    `locationCode` satisfies every check here.
 *  - a property the response has and the plugin never maps.
 *  - semantics of any kind: units, currency, timezone, whether `total` counts
 *    SKUs or rows.
 *  - spec drift. A changed `sha256` is visible only when somebody re-runs
 *    `npm run sync-contract`; nothing prompts that.
 *
 * Parameter *values* are checked only where the spec's own enum is consistent
 * with its description — see `AUTHORITATIVE_ENUMS` for the counter-example
 * that stopped this being a blanket rule.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { executeTool, type ClientOptions } from "../src/bigcommerce.js";
import {
  PAGE_LIMIT_MAX,
  PRODUCT_SORT_FIELDS,
  SORT_DIRECTIONS,
  TOOL_NAMES,
} from "../src/constants.js";

interface Contract {
  specs: Record<string, { url: string; sha256: string }>;
  maxDepth: number;
  endpoints: Record<
    string,
    {
      spec: string;
      specPath: string;
      queryParameters: Record<string, { maximum?: number; enum?: string[] }>;
      responseProperties: Record<string, string[]>;
    }
  >;
}

interface Fixtures {
  endpoints: Record<string, { source: string; body: unknown }>;
}

function load<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8")) as T;
}

const contract = load<Contract>("./openapi-contract.json");
const fixtures = load<Fixtures>("./openapi-fixtures.json");

const STORE_HASH = "abc123";

/**
 * Turn a requested path back into its contract key: drop the store prefix and
 * replace every numeric path segment with the parameter it stands for.
 */
function contractKey(pathname: string): string | undefined {
  const requested = pathname.replace(`/stores/${STORE_HASH}`, "");
  const requestedSegments = requested.split("/");
  return Object.keys(contract.endpoints).find((candidate) => {
    const candidateSegments = candidate.split("/");
    if (candidateSegments.length !== requestedSegments.length) return false;
    return candidateSegments.every((segment, index) => {
      const actual = requestedSegments[index]!;
      return segment.startsWith("{") ? /^\d+$/.test(actual) : segment === actual;
    });
  });
}

/** Serve the spec-shaped fixture for whatever endpoint the plugin asks for. */
function recordingClient(): { options: ClientOptions; calls: URL[] } {
  const calls: URL[] = [];
  const options: ClientOptions = {
    storeHash: STORE_HASH,
    accessToken: "token-xyz",
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      calls.push(parsed);
      const key = contractKey(parsed.pathname);
      const body = key === undefined ? {} : fixtures.endpoints[key]?.body ?? {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return { options, calls };
}

/**
 * One invocation per tool, passing every filter the tool advertises — so the
 * parameter check below sees the widest query each endpoint can be sent.
 */
const INVOCATIONS: Array<{ tool: string; params: Record<string, unknown> }> = [
  { tool: TOOL_NAMES.getStoreInfo, params: {} },
  { tool: TOOL_NAMES.getCatalogSummary, params: {} },
  {
    tool: TOOL_NAMES.listProducts,
    params: {
      keyword: "wrench",
      sku: "PW-14",
      name: "Pipe Wrench",
      productIds: [42, 43],
      categoryId: 23,
      brandId: 3,
      isVisible: true,
      minInventory: 1,
      maxInventory: 10,
      modifiedSince: "2026-10-01T00:00:00Z",
      sort: "date_modified",
      direction: "desc",
      page: 2,
      limit: 25,
    },
  },
  {
    tool: TOOL_NAMES.getProduct,
    params: { productId: 42, include: ["variants", "images"] },
  },
  { tool: TOOL_NAMES.listProductVariants, params: { productId: 42, page: 1, limit: 10 } },
  { tool: TOOL_NAMES.listCategoryTrees, params: { treeIds: [1, 2], channelIds: [1] } },
  {
    tool: TOOL_NAMES.listCategories,
    params: { treeId: 1, parentId: 0, keyword: "wrench", page: 1, limit: 20 },
  },
  { tool: TOOL_NAMES.listBrands, params: { name: "Ridgid", page: 1, limit: 10 } },
  {
    tool: TOOL_NAMES.listOrders,
    params: {
      statusId: 2,
      customerId: 55,
      email: "buyer@example.test",
      minTotal: 10,
      maxTotal: 500,
      createdSince: "2026-10-01T00:00:00Z",
      createdBefore: "2026-10-31T00:00:00Z",
      modifiedSince: "2026-10-02T00:00:00Z",
      sort: "date_created:desc",
      page: 1,
      limit: 50,
    },
  },
  { tool: TOOL_NAMES.getOrder, params: { orderId: 1042 } },
  { tool: TOOL_NAMES.listOrderProducts, params: { orderId: 1042, page: 1, limit: 10 } },
  {
    tool: TOOL_NAMES.listCustomers,
    params: {
      email: "buyer@example.test",
      name: "Ada",
      company: "Analytical Engines",
      customerIds: [55],
      customerGroupId: 2,
      createdSince: "2026-01-01T00:00:00Z",
      page: 1,
      limit: 10,
    },
  },
  {
    tool: TOOL_NAMES.listInventory,
    params: {
      skus: ["PW-14-RED"],
      productIds: [42],
      variantIds: [77],
      locationIds: [1, 2],
      page: 1,
      limit: 10,
    },
  },
  { tool: TOOL_NAMES.listLocations, params: { locationIds: [1, 2], page: 1, limit: 10 } },
];

describe("the contract file itself", () => {
  it("records where every spec came from", () => {
    expect(Object.keys(contract.specs).length).toBeGreaterThan(0);
    for (const [name, spec] of Object.entries(contract.specs)) {
      expect(spec.url, name).toMatch(/^https:\/\/docs\.bigcommerce\.com\/openapi\//);
      expect(spec.sha256, name).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("covers every tool in the catalog", () => {
    expect(INVOCATIONS.map((invocation) => invocation.tool).sort()).toEqual(
      Object.values(TOOL_NAMES).sort(),
    );
  });
});

describe("requests match the published endpoints", () => {
  for (const { tool, params } of INVOCATIONS) {
    it(`${tool} sends only documented parameters to documented paths`, async () => {
      const { options, calls } = recordingClient();
      await executeTool(options, tool, params);
      expect(calls.length).toBeGreaterThan(0);

      for (const call of calls) {
        const key = contractKey(call.pathname);
        // An unlisted path means either a typo or an endpoint nobody checked
        // against the spec. Both are the bug this test exists to catch.
        expect(key, `${call.pathname} is not an endpoint in openapi-contract.json`).toBeDefined();
        const documented = contract.endpoints[key!]!.queryParameters;
        for (const name of call.searchParams.keys()) {
          expect(
            Object.keys(documented),
            `${name} is not a documented parameter of GET ${contract.endpoints[key!]!.specPath}`,
          ).toContain(name);
        }
      }
    });
  }

  /**
   * Where the plugin keeps its own allowlist of a parameter's values, that list
   * has to be the spec's enum — a hand-picked subset silently refuses filters
   * BigCommerce supports, which is how `list_products` came to offer 7 of 13
   * sort fields and omit the two an agent would reach for first.
   *
   * This is not applied to every enum in the contract, because the specs
   * contradict themselves in at least one place: `/v2/orders` lists bare field
   * names in its `sort` enum while the same parameter's description requires
   * the `:asc`/`:desc` suffix the plugin sends. Checking that one against its
   * enum would fail a request that is right. So the rule is opt-in, and each
   * entry here is a parameter whose enum was read and found consistent with its
   * own description.
   */
  const AUTHORITATIVE_ENUMS: Array<{
    path: string;
    parameter: string;
    allowed: readonly string[];
  }> = [
    { path: "/v3/catalog/products", parameter: "sort", allowed: PRODUCT_SORT_FIELDS },
    { path: "/v3/catalog/products", parameter: "direction", allowed: SORT_DIRECTIONS },
  ];

  for (const { path, parameter, allowed } of AUTHORITATIVE_ENUMS) {
    it(`accepts exactly the documented ${parameter} values for ${path}`, () => {
      const documented = contract.endpoints[path]?.queryParameters[parameter]?.enum;
      expect(documented, `${parameter} has no documented enum for ${path}`).toBeDefined();
      expect([...allowed].sort()).toEqual(documented);
    });
  }

  it("keeps its paging ceiling inside the documented one", () => {
    const documented = Object.entries(contract.endpoints).flatMap(([path, endpoint]) => {
      const maximum = endpoint.queryParameters.limit?.maximum;
      return maximum === undefined ? [] : [[path, maximum] as const];
    });
    expect(documented.length).toBeGreaterThan(0);
    for (const [path, maximum] of documented) {
      expect(PAGE_LIMIT_MAX, `limit cap for ${path}`).toBeLessThanOrEqual(maximum);
    }
  });
});

describe("fixtures match the published response schemas", () => {
  /** Walk a fixture body, checking each property name against the contract. */
  function check(
    value: unknown,
    pointer: string,
    properties: Record<string, string[]>,
    path: string,
    report: (message: string) => void,
  ): void {
    if (Array.isArray(value)) {
      for (const entry of value) check(entry, `${pointer}[]`, properties, path, report);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const documented = properties[pointer];
    // An undocumented *level* used to return here, which made the whole check
    // blind below `data[].locations[]` — the exact depth the `list_inventory`
    // defect lived at. A fixture could invent an object there and pass. So an
    // unrecorded level is now a failure in its own right: either BigCommerce
    // does not document that object, or the fixture nests deeper than
    // `maxDepth` records and the generator needs to reach further.
    if (documented === undefined) {
      report(
        `${path}: nothing is documented at "${pointer || "(root)"}", so its properties are unchecked`,
      );
      return;
    }
    for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
      if (!documented.includes(name)) {
        report(`${path}: "${name}" is not documented at "${pointer || "(root)"}"`);
        continue;
      }
      check(child, pointer === "" ? name : `${pointer}.${name}`, properties, path, report);
    }
  }

  for (const [path, fixture] of Object.entries(fixtures.endpoints)) {
    it(`${path} is shaped like ${fixture.source.split(" ")[0]}`, () => {
      const endpoint = contract.endpoints[path];
      expect(endpoint, `${path} is not in openapi-contract.json`).toBeDefined();
      const problems: string[] = [];
      check(fixture.body, "", endpoint!.responseProperties, path, (message) =>
        problems.push(message),
      );
      expect(problems).toEqual([]);
    });
  }

  it("has a fixture for every endpoint the plugin calls", () => {
    expect(Object.keys(fixtures.endpoints).sort()).toEqual(
      Object.keys(contract.endpoints).sort(),
    );
  });
});
