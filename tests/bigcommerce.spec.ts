/**
 * Client-level tests: what goes on the wire, and what comes back out.
 *
 * These drive {@link executeTool} with an injected fetch, so every assertion
 * is about the request this plugin actually builds from a tool's arguments and
 * the shape it hands back to the agent — not about a mocked-out helper.
 *
 * Response fixtures come from `openapi-fixtures.json`, whose every property
 * name is checked against BigCommerce's published schemas by
 * `openapi-contract.spec.ts`. That indirection is the point: a fixture written
 * here by hand would be written in the shape this code expects, and the three
 * endpoint defects QA found in the first version of this plugin all hid behind
 * exactly that.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  bigCommerceApiOrigin,
  bigCommerceUrl,
  BigCommerceError,
  executeTool,
  InvalidParameterError,
  probe,
  type ClientOptions,
} from "../src/bigcommerce.js";
import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX, TOOL_NAMES } from "../src/constants.js";

interface Recorded {
  url: URL;
  init: RequestInit;
}

let calls: Recorded[] = [];

/** Queue one response per expected request, in order. */
function client(
  responses: Array<{ body?: unknown; status?: number; headers?: Record<string, string> }>,
): ClientOptions {
  const queue = [...responses];
  return {
    storeHash: "abc123",
    accessToken: "token-xyz",
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      const next = queue.shift() ?? { body: {} };
      const status = next.status ?? 200;
      if (status === 204) return new Response(null, { status: 204, headers: next.headers });
      return new Response(
        typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? {}),
        { status, headers: { "content-type": "application/json", ...next.headers } },
      );
    },
  };
}

/** A v3 collection envelope. */
function v3(data: unknown[], pagination?: Record<string, unknown>) {
  return { data, meta: { pagination: { total: data.length, total_pages: 1, ...pagination } } };
}

const FIXTURES = JSON.parse(
  readFileSync(new URL("./openapi-fixtures.json", import.meta.url), "utf8"),
) as { endpoints: Record<string, { source: string; body: unknown }> };

/** The spec-shaped response body for one endpoint. */
function fixture(path: string): unknown {
  const body = FIXTURES.endpoints[path]?.body;
  if (body === undefined) throw new Error(`No fixture for ${path}`);
  return structuredClone(body);
}

function query(index = 0): Record<string, string> {
  return Object.fromEntries(calls[index]!.url.searchParams.entries());
}

beforeEach(() => {
  calls = [];
});

describe("api origin", () => {
  it("defaults to the BigCommerce API", () => {
    expect(bigCommerceApiOrigin()).toBe("https://api.bigcommerce.com");
    expect(bigCommerceApiOrigin("")).toBe("https://api.bigcommerce.com");
    expect(bigCommerceApiOrigin("  ")).toBe("https://api.bigcommerce.com");
  });

  it("strips a trailing slash rather than refusing a pasted origin", () => {
    expect(bigCommerceApiOrigin("https://api.bigcommerce.com/")).toBe(
      "https://api.bigcommerce.com",
    );
  });

  it("refuses an origin that lost its scheme", () => {
    // `new URL("api.bigcommerce.com:443")` parses as an opaque path rather
    // than throwing, which is the case this guard exists for.
    expect(() => bigCommerceApiOrigin("api.bigcommerce.com")).toThrow(BigCommerceError);
    expect(() => bigCommerceApiOrigin("api.bigcommerce.com:443")).toThrow(/must start with https/);
  });

  it("refuses credentials, a query, a fragment and a path", () => {
    expect(() => bigCommerceApiOrigin("https://u:p@api.bigcommerce.com")).toThrow(/credentials/);
    expect(() => bigCommerceApiOrigin("https://api.bigcommerce.com?a=1")).toThrow(/query/);
    expect(() => bigCommerceApiOrigin("https://api.bigcommerce.com#x")).toThrow(/query/);
    expect(() => bigCommerceApiOrigin("https://api.bigcommerce.com/stores")).toThrow(/path/);
  });

  /**
   * The access token is a long-lived credential BigCommerce cannot revoke on
   * demand, so plaintext is only allowed where it cannot leave the machine.
   */
  it("allows plain http only for loopback", () => {
    expect(bigCommerceApiOrigin("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(bigCommerceApiOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(bigCommerceApiOrigin("http://[::1]:3000")).toBe("http://[::1]:3000");
    expect(() => bigCommerceApiOrigin("http://api.bigcommerce.com")).toThrow(/only for a loopback/);
    expect(() => bigCommerceApiOrigin("http://10.0.0.5")).toThrow(/only for a loopback/);
  });
});

describe("url building", () => {
  it("puts the store hash in the store path", () => {
    const url = bigCommerceUrl({ storeHash: "abc123", accessToken: "t" }, "/v3/catalog/products");
    expect(url.toString()).toBe("https://api.bigcommerce.com/stores/abc123/v3/catalog/products");
  });

  /**
   * The store hash is a path segment, and config read back from the database
   * has not necessarily passed through the settings form — so it is validated
   * on use, not only on save.
   */
  it("refuses a store hash that would retarget the request", () => {
    for (const hash of ["abc/../../v3", "abc 123", "https://evil.test/x", ""]) {
      expect(() =>
        bigCommerceUrl({ storeHash: hash, accessToken: "t" }, "/v3/catalog/products"),
      ).toThrow(InvalidParameterError);
    }
  });
});

describe("request shape", () => {
  it("authenticates with X-Auth-Token and never follows a redirect", async () => {
    const options = client([{ body: { name: "Shop" } }]);
    await executeTool(options, TOOL_NAMES.getStoreInfo, {});
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Auth-Token"]).toBe("token-xyz");
    // A redirect off api.bigcommerce.com would carry the token with it.
    expect(calls[0]!.init.redirect).toBe("error");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("only ever issues GET, for every tool in the catalog", async () => {
    // One request per tool, enough queued responses for the category fan-out.
    const perTool: Record<string, Record<string, unknown>> = {
      [TOOL_NAMES.getProduct]: { productId: 7 },
      [TOOL_NAMES.listProductVariants]: { productId: 7 },
      [TOOL_NAMES.getOrder]: { orderId: 11 },
      [TOOL_NAMES.listOrderProducts]: { orderId: 11 },
    };
    for (const name of Object.values(TOOL_NAMES)) {
      const options = client([
        { body: v3([{ id: 1, name: "Default" }]) },
        { body: v3([]) },
        { body: v3([]) },
      ]);
      await executeTool(options, name, perTool[name] ?? {});
    }
    expect(calls.length).toBeGreaterThanOrEqual(Object.keys(TOOL_NAMES).length);
    expect(calls.every((call) => call.init.method === "GET")).toBe(true);
  });
});

describe("status mapping", () => {
  const cases: Array<[number, RegExp]> = [
    [400, /request failed \(400\)/],
    [401, /rejected the access token/],
    [403, /does not have the OAuth scope/],
    [404, /no such record/],
    [500, /server error \(500\)/],
    [503, /server error \(503\)/],
  ];

  for (const [status, expected] of cases) {
    it(`maps ${status}`, async () => {
      const options = client([{ status }]);
      await expect(executeTool(options, TOOL_NAMES.getStoreInfo, {})).rejects.toThrow(expected);
    });
  }

  /**
   * 401 and 403 are split because they are fixed in different places: a bad
   * token or store hash versus a missing OAuth scope on a working token.
   */
  it("distinguishes a bad credential from a missing scope", async () => {
    await expect(
      executeTool(client([{ status: 401 }]), TOOL_NAMES.listOrders, {}),
    ).rejects.toThrow(/token/);
    await expect(
      executeTool(client([{ status: 403 }]), TOOL_NAMES.listOrders, {}),
    ).rejects.toThrow(/scope/);
  });

  it("quotes the advertised rate-limit window back to the caller", async () => {
    const options = client([
      { status: 429, headers: { "X-Rate-Limit-Time-Reset-Ms": "15000" } },
    ]);
    await expect(executeTool(options, TOOL_NAMES.getStoreInfo, {})).rejects.toThrow(
      /rate-limited this request\. Wait 15s/,
    );
  });

  it("still says something useful when the 429 carries no header", async () => {
    const options = client([{ status: 429 }]);
    await expect(executeTool(options, TOOL_NAMES.getStoreInfo, {})).rejects.toThrow(
      /Wait a few seconds/,
    );
  });

  it("never echoes the configured origin into a transport error", async () => {
    const options: ClientOptions = {
      storeHash: "abc123",
      accessToken: "t",
      apiOrigin: "https://proxy.internal.test",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED https://proxy.internal.test/stores/abc123/v2/store");
      },
    };
    await expect(executeTool(options, TOOL_NAMES.getStoreInfo, {})).rejects.toThrow(
      /could not be reached/,
    );
    await expect(executeTool(options, TOOL_NAMES.getStoreInfo, {})).rejects.not.toThrow(
      /proxy\.internal\.test/,
    );
  });

  it("reports an unparseable body as such", async () => {
    const options = client([{ body: "<html>maintenance</html>" }]);
    await expect(executeTool(options, TOOL_NAMES.getStoreInfo, {})).rejects.toThrow(
      /could not parse as JSON/,
    );
  });
});

describe("store info and catalog summary", () => {
  it("flattens the v2 store record into named fields", async () => {
    const options = client([{ body: fixture("/v2/store") }]);
    const result = await executeTool(options, TOOL_NAMES.getStoreInfo, {});
    expect(result).toMatchObject({
      name: "Brobston Supply",
      domain: "shop.example.test",
      currency: "USD",
      weightUnits: "LBS",
      timezone: "America/Chicago",
      plan: "Standard",
    });
    expect(calls[0]!.url.pathname).toBe("/stores/abc123/v2/store");
  });

  /**
   * `/v2/store` has no `store_hash` property: its `id` is the hash and
   * `store_id` is the numeric ID. Reading `store_hash` made the one tool whose
   * job is "say which store this is" answer `null`.
   */
  it("reads the hash from id and the numeric ID from store_id", async () => {
    const options = client([{ body: fixture("/v2/store") }]);
    const result = (await executeTool(options, TOOL_NAMES.getStoreInfo, {})) as Record<
      string,
      unknown
    >;
    expect(result.storeHash).toBe("abc123");
    expect(result.storeId).toBe(123456);
    // The ambiguous `id` is gone: one of these is a hash, the other a number.
    expect(result).not.toHaveProperty("id");
  });

  it("unwraps the v3 summary envelope", async () => {
    const options = client([{ body: fixture("/v3/catalog/summary") }]);
    expect(await executeTool(options, TOOL_NAMES.getCatalogSummary, {})).toMatchObject({
      inventoryCount: 412,
      variantCount: 980,
      inventoryValue: 51234.5,
      highestVariantPrice: 899,
      primaryCategoryName: "Shop All",
    });
  });
});

describe("list_products", () => {
  it("translates every filter into BigCommerce's query names", async () => {
    const options = client([{ body: v3([]) }]);
    await executeTool(options, TOOL_NAMES.listProducts, {
      keyword: "wrench",
      sku: "W-1",
      name: "Wrench",
      productIds: [4, 9],
      categoryId: 23,
      brandId: 5,
      isVisible: true,
      minInventory: 1,
      maxInventory: 10,
      modifiedSince: "2026-10-01T00:00:00Z",
      sort: "price",
      page: 2,
      limit: 25,
    });
    expect(query()).toMatchObject({
      keyword: "wrench",
      sku: "W-1",
      name: "Wrench",
      "id:in": "4,9",
      "categories:in": "23",
      brand_id: "5",
      is_visible: "true",
      "inventory_level:min": "1",
      "inventory_level:max": "10",
      "date_modified:min": "2026-10-01T00:00:00.000Z",
      sort: "price",
      page: "2",
      limit: "25",
    });
  });

  it("asks for only the fields the compact row needs", async () => {
    const options = client([{ body: v3([]) }]);
    await executeTool(options, TOOL_NAMES.listProducts, {});
    // A product carries its whole HTML description; a list of those is mostly
    // payload the run will not read.
    expect(query().include_fields).toContain("inventory_level");
    expect(query().include_fields).not.toContain("description");
  });

  it("defaults paging rather than taking BigCommerce's", async () => {
    const options = client([{ body: v3([]) }]);
    await executeTool(options, TOOL_NAMES.listProducts, {});
    expect(query()).toMatchObject({ page: "1", limit: String(PAGE_LIMIT_DEFAULT) });
  });

  it("leaves an unset filter out of the query entirely", async () => {
    const options = client([{ body: v3([]) }]);
    await executeTool(options, TOOL_NAMES.listProducts, { keyword: "wrench" });
    // The bug this guards against is an unset filter arriving as the literal
    // text "undefined" and quietly matching nothing.
    expect(Object.keys(query()).sort()).toEqual([
      "include_fields",
      "keyword",
      "limit",
      "page",
    ]);
  });

  it("returns compact rows and normalized pagination", async () => {
    const options = client([
      {
        body: v3(
          [
            {
              id: 42,
              name: "Pipe Wrench",
              sku: "PW-14",
              price: 24.99,
              sale_price: 19.99,
              inventory_level: 6,
              is_visible: true,
              brand_id: 3,
              categories: [23],
              date_modified: "2026-10-10T12:00:00Z",
            },
          ],
          { total: 60, total_pages: 2, current_page: 1 },
        ),
      },
    ]);
    const result = (await executeTool(options, TOOL_NAMES.listProducts, {})) as {
      pagination: Record<string, unknown>;
      products: Array<Record<string, unknown>>;
    };
    expect(result.products[0]).toEqual({
      id: 42,
      name: "Pipe Wrench",
      sku: "PW-14",
      type: undefined,
      price: 24.99,
      salePrice: 19.99,
      inventoryLevel: 6,
      inventoryTracking: null,
      isVisible: true,
      brandId: 3,
      categories: [23],
      dateModified: "2026-10-10T12:00:00Z",
    });
    expect(result.pagination).toEqual({
      page: 1,
      limit: PAGE_LIMIT_DEFAULT,
      returned: 1,
      total: 60,
      totalPages: 2,
      hasMore: true,
    });
  });

  it("rejects an unsupported sort instead of letting BigCommerce 422", async () => {
    const options = client([{ body: v3([]) }]);
    await expect(
      executeTool(options, TOOL_NAMES.listProducts, { sort: "total_revenue" }),
    ).rejects.toThrow(InvalidParameterError);
  });

  /**
   * `/v3/catalog/products` takes the direction as its own parameter, so
   * without it "the most recently changed products" is unreachable.
   */
  it("can sort descending", async () => {
    const options = client([{ body: v3([]) }]);
    await executeTool(options, TOOL_NAMES.listProducts, {
      sort: "date_modified",
      direction: "desc",
    });
    expect(query()).toMatchObject({ sort: "date_modified", direction: "desc" });
    await expect(
      executeTool(client([{ body: v3([]) }]), TOOL_NAMES.listProducts, { direction: "down" }),
    ).rejects.toThrow(/"direction" must be asc or desc/);
  });
});

describe("parameter validation", () => {
  it("rejects an unknown parameter rather than dropping it", async () => {
    const options = client([{ body: v3([]) }]);
    // Silently ignoring it would let the caller believe a filter had been
    // applied — a wrong answer that looks like a right one.
    await expect(
      executeTool(options, TOOL_NAMES.listProducts, { kyword: "wrench" }),
    ).rejects.toThrow(/Unsupported parameter: kyword/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a limit above the BigCommerce cap", async () => {
    const options = client([{ body: v3([]) }]);
    await expect(
      executeTool(options, TOOL_NAMES.listProducts, { limit: PAGE_LIMIT_MAX + 1 }),
    ).rejects.toThrow(/between 1 and 250/);
  });

  it("requires a path ID and refuses a non-integer one", async () => {
    const options = client([{ body: { data: {} } }]);
    await expect(executeTool(options, TOOL_NAMES.getProduct, {})).rejects.toThrow(
      /"productId" is required/,
    );
    await expect(
      executeTool(options, TOOL_NAMES.getProduct, { productId: "7" }),
    ).rejects.toThrow(/must be an integer/);
    await expect(
      executeTool(options, TOOL_NAMES.getProduct, { productId: 1.5 }),
    ).rejects.toThrow(/must be an integer/);
  });

  it("rejects an unparseable timestamp", async () => {
    const options = client([{ body: v3([]) }]);
    await expect(
      executeTool(options, TOOL_NAMES.listOrders, { createdSince: "last tuesday" }),
    ).rejects.toThrow(/ISO 8601/);
  });

  it("validates include against the sub-resources the endpoint knows", async () => {
    const options = client([{ body: { data: { id: 7 } } }]);
    await expect(
      executeTool(options, TOOL_NAMES.getProduct, { productId: 7, include: ["reviews"] }),
    ).rejects.toThrow(/"include" accepts only/);
    await executeTool(options, TOOL_NAMES.getProduct, {
      productId: 7,
      include: ["variants", "images"],
    });
    expect(query().include).toBe("variants,images");
  });

  /**
   * SKUs are operator-chosen strings, so a comma inside one would split it
   * into two filter values and silently widen the query.
   */
  it("refuses a SKU containing the filter's own separator", async () => {
    const options = client([{ body: v3([]) }]);
    await expect(
      executeTool(options, TOOL_NAMES.listInventory, { skus: ["A-1,B-2"] }),
    ).rejects.toThrow(/cannot contain a comma/);
  });

  it("rejects a non-integer in an ID list", async () => {
    const options = client([{ body: v3([]) }]);
    await expect(
      executeTool(options, TOOL_NAMES.listProducts, { productIds: [1, "2"] }),
    ).rejects.toThrow(/positive integers/);
  });

  it("treats an empty ID list as no filter at all", async () => {
    const options = client([{ body: v3([]) }]);
    await executeTool(options, TOOL_NAMES.listProducts, { productIds: [] });
    expect(query()["id:in"]).toBeUndefined();
  });

  it("rejects a non-object parameter bag", async () => {
    const options = client([{ body: v3([]) }]);
    await expect(executeTool(options, TOOL_NAMES.listProducts, [1, 2])).rejects.toThrow(
      /must be an object/,
    );
  });

  it("rejects an unknown tool name", async () => {
    await expect(executeTool(client([]), "delete_everything", {})).rejects.toThrow(
      /Unknown BigCommerce tool/,
    );
  });
});

describe("orders", () => {
  it("reads a v2 204 as an empty page, not as a parse failure", async () => {
    // v2 collection endpoints answer "nothing matched" with 204 and no body.
    const options = client([{ status: 204 }]);
    const result = (await executeTool(options, TOOL_NAMES.listOrders, {})) as {
      orders: unknown[];
      pagination: { returned: number; hasMore: boolean };
    };
    expect(result.orders).toEqual([]);
    expect(result.pagination).toMatchObject({ returned: 0, hasMore: false });
  });

  it("summarizes an order and lifts the billing email out of the address", async () => {
    const options = client([
      {
        body: [
          {
            id: 1042,
            status: "Shipped",
            status_id: 2,
            date_created: "Mon, 12 Oct 2026 10:00:00 +0000",
            customer_id: 55,
            items_total: 3,
            total_inc_tax: "128.4000",
            currency_code: "USD",
            payment_method: "Credit Card",
            payment_status: "captured",
            billing_address: { email: "buyer@example.test", city: "Dallas" },
          },
        ],
      },
    ]);
    const result = (await executeTool(options, TOOL_NAMES.listOrders, {})) as {
      orders: Array<Record<string, unknown>>;
    };
    expect(result.orders[0]).toMatchObject({
      id: 1042,
      status: "Shipped",
      customerId: 55,
      billingEmail: "buyer@example.test",
      totalIncTax: "128.4000",
    });
    // The rest of the address stays behind get_order.
    expect(result.orders[0]).not.toHaveProperty("city");
  });

  /** v2 sends no pagination metadata, so a full page is the only signal. */
  it("infers hasMore from a full v2 page", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({ id: index + 1 }));
    const options = client([{ body: rows }]);
    const result = (await executeTool(options, TOOL_NAMES.listOrders, { limit: 5 })) as {
      pagination: { hasMore: boolean; total?: unknown };
    };
    expect(result.pagination.hasMore).toBe(true);
    // Guessing a total would be worse than reporting none.
    expect(result.pagination.total).toBeUndefined();
  });

  it("maps order filters to the v2 query names", async () => {
    const options = client([{ status: 204 }]);
    await executeTool(options, TOOL_NAMES.listOrders, {
      statusId: 2,
      customerId: 55,
      email: "buyer@example.test",
      minTotal: 10,
      maxTotal: 500,
      createdSince: "2026-10-01T00:00:00Z",
      createdBefore: "2026-10-31T00:00:00Z",
      sort: "date_created:desc",
    });
    expect(query()).toMatchObject({
      status_id: "2",
      customer_id: "55",
      email: "buyer@example.test",
      min_total: "10",
      max_total: "500",
      min_date_created: "2026-10-01T00:00:00.000Z",
      max_date_created: "2026-10-31T00:00:00.000Z",
      sort: "date_created:desc",
    });
  });

  it("returns one order's detail, including the billing address", async () => {
    const options = client([{ body: fixture("/v2/orders/{order_id}") }]);
    const result = (await executeTool(options, TOOL_NAMES.getOrder, { orderId: 1042 })) as Record<
      string,
      unknown
    >;
    expect(calls[0]!.url.pathname).toBe("/stores/abc123/v2/orders/1042");
    expect(result).toMatchObject({
      id: 1042,
      status: "Shipped",
      statusId: 2,
      customerId: 55,
      customerMessage: "Please leave at the loading dock.",
      totalIncTax: "128.4000",
      paymentStatus: "captured",
      shippingAddressCount: 1,
    });
    expect(result.billingAddress).toEqual({
      firstName: "Ada",
      lastName: "Byron",
      company: "Analytical Engines",
      street1: "1 Analytical Way",
      street2: "Suite 2",
      city: "Dallas",
      state: "Texas",
      zip: "75201",
      country: "United States",
      countryIso2: "US",
      email: "buyer@example.test",
      phone: "555-0100",
    });
  });

  /**
   * Every other tool returns an allowlisted row. This one used to return the
   * upstream record whole, which made its PII surface whatever BigCommerce
   * sends — the shopper's IP address included — and whatever they add next.
   */
  it("allowlists the order record rather than passing it through", async () => {
    const options = client([{ body: fixture("/v2/orders/{order_id}") }]);
    const result = await executeTool(options, TOOL_NAMES.getOrder, { orderId: 1042 });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("203.0.113.42");
    expect(serialized).not.toContain("2001:db8::2a");
    // Internal notes and the raw sub-resource links stay upstream too.
    expect(serialized).not.toContain("Called the customer");
    expect(result).not.toHaveProperty("products");
    expect(result).not.toHaveProperty("payment_provider_id");
  });

  it("treats a 204 on a single order as not found", async () => {
    const options = client([{ status: 204 }]);
    await expect(executeTool(options, TOOL_NAMES.getOrder, { orderId: 9 })).rejects.toThrow(
      /no such record/,
    );
  });

  it("summarizes order line items", async () => {
    const options = client([
      {
        body: [
          {
            id: 1,
            product_id: 42,
            variant_id: 77,
            name: "Pipe Wrench",
            sku: "PW-14",
            quantity: 2,
            base_price: "24.9900",
            total_inc_tax: "53.9800",
          },
        ],
      },
    ]);
    const result = (await executeTool(options, TOOL_NAMES.listOrderProducts, {
      orderId: 1042,
    })) as { lineItems: Array<Record<string, unknown>> };
    expect(result.lineItems[0]).toMatchObject({
      productId: 42,
      variantId: 77,
      sku: "PW-14",
      quantity: 2,
      totalIncTax: "53.9800",
    });
    expect(calls[0]!.url.pathname).toBe("/stores/abc123/v2/orders/1042/products");
  });
});

/**
 * The tool that exists so "no such tree" and "empty tree" stop looking
 * identical.
 *
 * `list_categories` names a tree it finds categories in, but an empty page
 * skips the trees call entirely — so a mistyped `treeId` and a real tree with
 * nothing in it both answer `{ categories: [] }`. Nothing else exposes
 * `/v3/catalog/trees`, so there was no way to tell them apart or to turn a
 * storefront name into the `treeId` the filter wants.
 */
describe("category trees", () => {
  it("returns each tree's ID, name and storefront channels", async () => {
    const options = client([{ body: fixture("/v3/catalog/trees") }]);
    const result = (await executeTool(options, TOOL_NAMES.listCategoryTrees, {})) as {
      trees: Array<Record<string, unknown>>;
    };
    expect(calls[0]!.url.pathname).toBe("/stores/abc123/v3/catalog/trees");
    expect(result.trees).toEqual([
      { id: 1, name: "Storefront", channelIds: [1] },
      { id: 2, name: "Wholesale", channelIds: [2] },
    ]);
  });

  it("translates its filters into the endpoint's query names", async () => {
    const options = client([{ body: fixture("/v3/catalog/trees") }]);
    await executeTool(options, TOOL_NAMES.listCategoryTrees, { treeIds: [1, 2], channelIds: [1] });
    expect(query()).toEqual({ "id:in": "1,2", "channel_id:in": "1" });
  });

  /**
   * `/v3/catalog/trees` documents `id:in` and `channel_id:in` and nothing else.
   * Sending `page`/`limit` to an endpoint that never promised them is how the
   * old `list_categories` came to report a `hasMore` it had invented.
   */
  it("sends no paging parameters, and reports no pagination it did not get", async () => {
    const options = client([{ body: fixture("/v3/catalog/trees") }]);
    const result = await executeTool(options, TOOL_NAMES.listCategoryTrees, {});
    expect([...calls[0]!.url.searchParams.keys()]).toEqual([]);
    expect(result).not.toHaveProperty("pagination");
  });

  /** An existing tree with nothing in it is a row here; a missing one is not. */
  it("tells an empty tree apart from a tree ID that does not exist", async () => {
    const empty = client([{ body: v3([{ id: 7, name: "Outlet", channels: [] }]) }]);
    const found = (await executeTool(empty, TOOL_NAMES.listCategoryTrees, { treeIds: [7] })) as {
      trees: unknown[];
    };
    expect(found.trees).toEqual([{ id: 7, name: "Outlet", channelIds: [] }]);

    const missing = client([{ body: v3([]) }]);
    const none = (await executeTool(missing, TOOL_NAMES.listCategoryTrees, {
      treeIds: [999],
    })) as { trees: unknown[] };
    expect(none.trees).toEqual([]);
  });

  it("rejects an unknown parameter rather than dropping it", async () => {
    const options = client([{ body: fixture("/v3/catalog/trees") }]);
    await expect(
      executeTool(options, TOOL_NAMES.listCategoryTrees, { page: 1 }),
    ).rejects.toBeInstanceOf(InvalidParameterError);
  });
});

describe("categories", () => {
  /** The flat endpoint, then one call to name the trees. */
  function categoryClient() {
    return client([
      { body: fixture("/v3/catalog/trees/categories") },
      { body: fixture("/v3/catalog/trees") },
    ]);
  }

  /**
   * The nested endpoint `/v3/catalog/trees/{tree_id}/categories` returns a
   * `CategoryNode` tree: every subcategory lives in a `children[]` array the
   * mapper never walked, so reading it returned the root level only and called
   * that the store's categories.
   */
  it("returns every level of the hierarchy, not just the roots", async () => {
    const result = (await executeTool(categoryClient(), TOOL_NAMES.listCategories, {})) as {
      categories: Array<Record<string, unknown>>;
    };
    expect(calls[0]!.url.pathname).toBe("/stores/abc123/v3/catalog/trees/categories");
    expect(result.categories.map((category) => category.name)).toEqual([
      "Tools",
      "Wrenches",
      "Pipe Wrenches",
      "Bulk",
    ]);
    // parentId on each row is what makes the hierarchy reconstructable.
    expect(result.categories.map((category) => category.parentId)).toEqual([0, 23, 31, 0]);
  });

  it("reads the flat endpoint's own field names, including sort order", async () => {
    const result = (await executeTool(categoryClient(), TOOL_NAMES.listCategories, {})) as {
      categories: Array<Record<string, unknown>>;
    };
    expect(result.categories[1]).toEqual({
      id: 31,
      treeId: 1,
      treeName: "Storefront",
      parentId: 23,
      name: "Wrenches",
      isVisible: true,
      sortOrder: 2,
    });
  });

  /** The same category name exists in several trees on a multi-storefront store. */
  it("names the tree each category belongs to", async () => {
    const result = (await executeTool(categoryClient(), TOOL_NAMES.listCategories, {})) as {
      categories: Array<Record<string, unknown>>;
    };
    expect(calls[1]!.url.pathname).toBe("/stores/abc123/v3/catalog/trees");
    expect(result.categories.at(-1)).toMatchObject({ treeId: 2, treeName: "Wholesale" });
  });

  /**
   * `/v3/catalog/trees` documents only `id:in` and `channel_id:in` — no paging
   * at all — so asking for "all the trees" and taking what arrives let
   * `treeName` come back null on a store with more trees than one response
   * holds. It asks for exactly the trees this page of categories mentions.
   */
  it("asks the trees endpoint for this page's trees by ID, and sends no paging", async () => {
    await executeTool(categoryClient(), TOOL_NAMES.listCategories, {});
    expect([...calls[1]!.url.searchParams.keys()]).toEqual(["id:in"]);
    // The fixture's categories sit in trees 1 and 2, each asked for once.
    expect(calls[1]!.url.searchParams.get("id:in")).toBe("1,2");
  });

  it("translates its filters into the flat endpoint's query names", async () => {
    const options = categoryClient();
    await executeTool(options, TOOL_NAMES.listCategories, {
      treeId: 2,
      keyword: "wrench",
      parentId: 23,
      limit: 25,
    });
    expect(query()).toMatchObject({
      "tree_id:in": "2",
      "parent_id:in": "23",
      keyword: "wrench",
      page: "1",
      limit: "25",
    });
  });

  /** The top level of a tree is `parent_id` 0, so this filter has to allow it. */
  it("accepts parentId 0 for the top-level categories", async () => {
    await executeTool(categoryClient(), TOOL_NAMES.listCategories, { parentId: 0 });
    expect(query()["parent_id:in"]).toBe("0");
  });

  it("reports the API's real pagination instead of inferring it", async () => {
    const options = client([
      { body: v3([{ category_id: 1, tree_id: 1, name: "One" }], { total: 9, total_pages: 3 }) },
      { body: fixture("/v3/catalog/trees") },
    ]);
    const result = (await executeTool(options, TOOL_NAMES.listCategories, { limit: 1 })) as {
      pagination: Record<string, unknown>;
    };
    // The nested endpoint carries no pagination at all, which is what made
    // hasMore say "true" forever while `page` was ignored.
    expect(result.pagination).toEqual({
      page: 1,
      limit: 1,
      returned: 1,
      total: 9,
      totalPages: 3,
      hasMore: true,
    });
  });

  it("does not ask for tree names when there are no categories to name", async () => {
    const options = client([{ body: v3([]) }]);
    const result = (await executeTool(options, TOOL_NAMES.listCategories, {
      keyword: "nothing",
    })) as { categories: unknown[] };
    expect(result.categories).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe("customers and inventory", () => {
  it("maps customer filters and returns compact rows", async () => {
    const options = client([{ body: fixture("/v3/customers") }]);
    const result = (await executeTool(options, TOOL_NAMES.listCustomers, {
      email: "buyer@example.test",
      name: "Ada",
      customerIds: [55],
      customerGroupId: 2,
      createdSince: "2026-01-01T00:00:00Z",
    })) as { customers: Array<Record<string, unknown>> };
    expect(query()).toMatchObject({
      "email:in": "buyer@example.test",
      "name:like": "Ada",
      "id:in": "55",
      "customer_group_id:in": "2",
      "date_created:min": "2026-01-01T00:00:00.000Z",
    });
    expect(result.customers[0]).toEqual({
      id: 55,
      email: "buyer@example.test",
      firstName: "Ada",
      lastName: "Byron",
      company: "Analytical Engines",
      customerGroupId: 2,
      dateCreated: "2026-01-02T00:00:00Z",
    });
  });

  /**
   * The job is resolving an email to a customer ID. Everything an agent reads
   * lands in a run transcript, so the row carries no contact detail the job
   * does not need — and the upstream record's notes and IP stay upstream.
   */
  it("leaves the phone number, notes and registration IP behind", async () => {
    const options = client([{ body: fixture("/v3/customers") }]);
    const result = (await executeTool(options, TOOL_NAMES.listCustomers, {})) as {
      customers: Array<Record<string, unknown>>;
    };
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("555-0100");
    expect(serialized).not.toContain("203.0.113.42");
    expect(serialized).not.toContain("Net 30");
  });

  /**
   * `/v3/inventory/items` answers `{ identity, locations[] }`, and the stock
   * numbers live on each location with safety stock under `settings`. Reading
   * them off the top-level object returned one row per item in which every
   * value was null.
   */
  it("flat-maps each item's locations into rows with real numbers", async () => {
    const options = client([{ body: fixture("/v3/inventory/items") }]);
    const result = (await executeTool(options, TOOL_NAMES.listInventory, {
      skus: ["PW-14-RED"],
      locationIds: [1, 2],
    })) as {
      items: Array<Record<string, unknown>>;
      pagination: { skusReturned: number; rowsReturned: number };
    };
    expect(query()).toMatchObject({ "sku:in": "PW-14-RED", "location_id:in": "1,2" });
    expect(result.items[0]).toEqual({
      sku: "PW-14-RED",
      productId: 42,
      variantId: 77,
      locationId: 1,
      locationCode: "DAL",
      locationName: "Dallas Warehouse",
      availableToSell: 4,
      totalInventoryOnhand: 6,
      qtyBackordered: 0,
      locationEnabled: true,
      safetyStock: 2,
      isInStock: true,
    });
    // Two SKUs, three SKU/location pairs. Both counts are reported by name,
    // because `returned` alone reads as "rows" in every other list tool and
    // here it was the SKU count — so comparing it to `limit` said "last page"
    // on a page that had more rows than the limit.
    expect(result.items).toHaveLength(3);
    expect(result.pagination.skusReturned).toBe(2);
    expect(result.pagination.rowsReturned).toBe(3);
    expect(result.pagination).not.toHaveProperty("returned");
    expect(result.items[1]).toMatchObject({
      sku: "PW-14-RED",
      locationId: 2,
      availableToSell: 0,
      qtyBackordered: 3,
      isInStock: false,
    });
    expect(result.items[2]).toMatchObject({ sku: "PW-18", locationId: 1, availableToSell: 11 });
  });

  /**
   * `location_id:in` reaches the API, but BigCommerce's spec never says whether
   * it selects items or prunes each item's `locations[]`, and the endpoint
   * summary leans toward selecting items. If it selects, the Austin row arrives
   * attached to a SKU asked for in Dallas, and "how many in Dallas" is answered
   * with the Austin number — a wrong figure with nothing in the output to
   * reveal it. So the rows are narrowed here too, which is right either way.
   */
  it("returns only rows for the locations asked for", async () => {
    const options = client([{ body: fixture("/v3/inventory/items") }]);
    const result = (await executeTool(options, TOOL_NAMES.listInventory, {
      locationIds: [2],
    })) as {
      items: Array<Record<string, unknown>>;
      pagination: { skusReturned: number; rowsReturned: number };
    };
    expect(query()["location_id:in"]).toBe("2");
    expect(result.items.map((item) => item.locationId)).toEqual([2]);
    // The SKU stocked only in location 1 is not part of the answer, and the
    // row count says so while the SKU count still reports what the API paged.
    expect(result.pagination.rowsReturned).toBe(1);
    expect(result.pagination.skusReturned).toBe(2);
  });

  it("keeps every location when none was asked for", async () => {
    const options = client([{ body: fixture("/v3/inventory/items") }]);
    const result = (await executeTool(options, TOOL_NAMES.listInventory, {})) as {
      items: Array<Record<string, unknown>>;
    };
    expect(result.items.map((item) => item.locationId)).toEqual([1, 2, 1]);
  });

  /** `is_in_stock_alternate` exists nowhere in BigCommerce's schema. */
  it("reports in-stock status from the location's settings", async () => {
    const options = client([{ body: fixture("/v3/inventory/items") }]);
    const result = (await executeTool(options, TOOL_NAMES.listInventory, {})) as {
      items: Array<Record<string, unknown>>;
    };
    expect(result.items[0]).not.toHaveProperty("isInStockAlternate");
    expect(result.items[0]!.isInStock).toBe(true);
  });

  it("keeps a SKU that has no location row at all", async () => {
    const options = client([
      { body: v3([{ identity: { sku: "GHOST-1", product_id: 9 }, locations: [] }]) },
    ]);
    const result = (await executeTool(options, TOOL_NAMES.listInventory, {})) as {
      items: Array<Record<string, unknown>>;
    };
    // Dropping it would make "which SKUs have no stock record" unanswerable.
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      sku: "GHOST-1",
      locationId: null,
      availableToSell: null,
    });
  });

  it("names locations so an ID can be turned back into a place", async () => {
    const options = client([{ body: fixture("/v3/inventory/locations") }]);
    const result = (await executeTool(options, TOOL_NAMES.listLocations, {
      locationIds: [1, 2],
    })) as { locations: Array<Record<string, unknown>> };
    // `/v3/inventory/locations` documents `location_id:in`; there is no bare
    // `id:in`, so the old filter either widened the query or 422'd.
    expect(query()["location_id:in"]).toBe("1,2");
    expect(query()["id:in"]).toBeUndefined();
    expect(result.locations[0]).toMatchObject({
      id: 1,
      code: "DAL",
      label: "Dallas Warehouse",
      enabled: true,
      timeZone: "America/Chicago",
      city: "Dallas",
      countryCode: "USA",
    });
  });

  it("lists brands with their storefront URL", async () => {
    const options = client([{ body: fixture("/v3/catalog/brands") }]);
    const result = (await executeTool(options, TOOL_NAMES.listBrands, { name: "Ridgid" })) as {
      brands: Array<Record<string, unknown>>;
    };
    expect(query().name).toBe("Ridgid");
    expect(result.brands[0]).toEqual({ id: 3, name: "Ridgid", customUrl: "/ridgid/" });
  });

  it("returns variants under the product they belong to", async () => {
    const options = client([{ body: fixture("/v3/catalog/products/{product_id}/variants") }]);
    const result = (await executeTool(options, TOOL_NAMES.listProductVariants, {
      productId: 42,
    })) as { productId: number; variants: Array<Record<string, unknown>> };
    expect(calls[0]!.url.pathname).toBe("/stores/abc123/v3/catalog/products/42/variants");
    expect(result.productId).toBe(42);
    expect(result.variants[0]).toMatchObject({ id: 77, sku: "PW-14-RED", price: 26 });
  });
});

describe("probe", () => {
  /**
   * The liveness read is `/v2/store` because it needs only the
   * store-information scope and returns nothing about the catalog, orders or
   * customers.
   */
  it("reads the store record and nothing else", async () => {
    const options = client([{ body: { name: "Shop", store_hash: "abc123" } }]);
    expect(await probe(options)).toMatchObject({ name: "Shop" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe("/stores/abc123/v2/store");
  });
});
