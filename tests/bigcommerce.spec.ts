/**
 * Client-level tests: what goes on the wire, and what comes back out.
 *
 * These drive {@link executeTool} with an injected fetch, so every assertion
 * is about the request this plugin actually builds from a tool's arguments and
 * the shape it hands back to the agent — not about a mocked-out helper.
 */
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
    const options = client([
      {
        body: {
          id: 1,
          name: "Brobston Supply",
          domain: "shop.test",
          secure_url: "https://shop.test",
          currency: "USD",
          currency_symbol: "$",
          weight_units: "LBS",
          dimension_units: "Inches",
          timezone: { name: "America/Chicago", raw_offset: -21600 },
          plan_name: "Standard",
          store_hash: "abc123",
        },
      },
    ]);
    const result = await executeTool(options, TOOL_NAMES.getStoreInfo, {});
    expect(result).toMatchObject({
      name: "Brobston Supply",
      domain: "shop.test",
      currency: "USD",
      weightUnits: "LBS",
      timezone: "America/Chicago",
      plan: "Standard",
    });
    expect(calls[0]!.url.pathname).toBe("/stores/abc123/v2/store");
  });

  it("unwraps the v3 summary envelope", async () => {
    const options = client([
      {
        body: {
          data: {
            inventory_count: 412,
            variant_count: 980,
            inventory_value: 51234.5,
            lowest_variant_price: 3.5,
            highest_variant_price: 899,
            primary_category_name: "Shop All",
          },
        },
      },
    ]);
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

  it("returns the full record for one order", async () => {
    const options = client([{ body: { id: 1042, billing_address: { city: "Dallas" } } }]);
    expect(await executeTool(options, TOOL_NAMES.getOrder, { orderId: 1042 })).toMatchObject({
      id: 1042,
    });
    expect(calls[0]!.url.pathname).toBe("/stores/abc123/v2/orders/1042");
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

describe("categories", () => {
  it("discovers the trees when none is named and tags each category", async () => {
    const options = client([
      { body: v3([{ id: 1, name: "Storefront" }, { id: 2, name: "Wholesale" }]) },
      { body: v3([{ category_id: 23, parent_id: 0, name: "Tools", is_visible: true }]) },
      { body: v3([{ category_id: 31, parent_id: 0, name: "Bulk", is_visible: false }]) },
    ]);
    const result = (await executeTool(options, TOOL_NAMES.listCategories, {})) as {
      trees: Array<{ treeId: number; treeName: string; categories: Array<Record<string, unknown>> }>;
    };
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/stores/abc123/v3/catalog/trees",
      "/stores/abc123/v3/catalog/trees/1/categories",
      "/stores/abc123/v3/catalog/trees/2/categories",
    ]);
    expect(result.trees.map((tree) => tree.treeName)).toEqual(["Storefront", "Wholesale"]);
    // The same category name can exist in several trees, so each row says
    // which tree it came from.
    expect(result.trees[0]!.categories[0]).toMatchObject({ id: 23, treeId: 1, name: "Tools" });
    expect(result.trees[1]!.categories[0]).toMatchObject({ id: 31, treeId: 2 });
  });

  it("sends no paging parameters to the trees endpoint", async () => {
    // `/v3/catalog/trees` documents only `id:in` and `channel_id:in`.
    const options = client([{ body: v3([]) }]);
    await executeTool(options, TOOL_NAMES.listCategories, {});
    expect([...calls[0]!.url.searchParams.keys()]).toEqual([]);
  });

  it("skips tree discovery when a tree is named", async () => {
    const options = client([{ body: v3([{ category_id: 23, name: "Tools" }]) }]);
    await executeTool(options, TOOL_NAMES.listCategories, {
      treeId: 2,
      keyword: "tool",
      parentId: 5,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe("/stores/abc123/v3/catalog/trees/2/categories");
    expect(query()).toMatchObject({ keyword: "tool", parent_id: "5" });
  });

  it("says so plainly when the store has no trees", async () => {
    const options = client([{ body: v3([]) }]);
    expect(await executeTool(options, TOOL_NAMES.listCategories, {})).toMatchObject({
      trees: [],
      note: expect.stringContaining("no category trees"),
    });
  });
});

describe("customers and inventory", () => {
  it("maps customer filters and returns compact rows", async () => {
    const options = client([
      {
        body: v3([
          {
            id: 55,
            email: "buyer@example.test",
            first_name: "Ada",
            last_name: "Byron",
            company: "Analytical",
            phone: "555-0100",
            customer_group_id: 2,
            date_created: "2026-01-02T00:00:00Z",
          },
        ]),
      },
    ]);
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
    expect(result.customers[0]).toMatchObject({ id: 55, email: "buyer@example.test", company: "Analytical" });
  });

  it("reads per-location stock, including safety stock from settings", async () => {
    const options = client([
      {
        body: v3([
          {
            sku: "PW-14",
            product_id: 42,
            variant_id: 77,
            location_id: 1,
            available_to_sell: 4,
            total_inventory_onhand: 6,
            settings: { safety_stock: 2 },
          },
        ]),
      },
    ]);
    const result = (await executeTool(options, TOOL_NAMES.listInventory, {
      skus: ["PW-14"],
      locationIds: [1],
    })) as { items: Array<Record<string, unknown>> };
    expect(query()).toMatchObject({ "sku:in": "PW-14", "location_id:in": "1" });
    expect(result.items[0]).toMatchObject({
      sku: "PW-14",
      availableToSell: 4,
      totalInventoryOnhand: 6,
      safetyStock: 2,
    });
  });

  it("names locations so an ID can be turned back into a place", async () => {
    const options = client([
      {
        body: v3([
          {
            id: 1,
            code: "DAL",
            label: "Dallas Warehouse",
            enabled: true,
            time_zone: "America/Chicago",
            address: { city: "Dallas", country_code: "US" },
          },
        ]),
      },
    ]);
    const result = (await executeTool(options, TOOL_NAMES.listLocations, {})) as {
      locations: Array<Record<string, unknown>>;
    };
    expect(result.locations[0]).toMatchObject({
      id: 1,
      code: "DAL",
      label: "Dallas Warehouse",
      city: "Dallas",
    });
  });

  it("lists brands with their storefront URL", async () => {
    const options = client([
      { body: v3([{ id: 3, name: "Ridgid", custom_url: { url: "/ridgid/" } }]) },
    ]);
    const result = (await executeTool(options, TOOL_NAMES.listBrands, { name: "Ridgid" })) as {
      brands: Array<Record<string, unknown>>;
    };
    expect(query().name).toBe("Ridgid");
    expect(result.brands[0]).toEqual({ id: 3, name: "Ridgid", customUrl: "/ridgid/" });
  });

  it("returns variants under the product they belong to", async () => {
    const options = client([{ body: v3([{ id: 77, sku: "PW-14-RED", price: 26 }]) }]);
    const result = (await executeTool(options, TOOL_NAMES.listProductVariants, {
      productId: 42,
    })) as { productId: number; variants: unknown[] };
    expect(calls[0]!.url.pathname).toBe("/stores/abc123/v3/catalog/products/42/variants");
    expect(result.productId).toBe(42);
    expect(result.variants).toHaveLength(1);
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
