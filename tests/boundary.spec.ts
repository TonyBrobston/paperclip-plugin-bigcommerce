/**
 * Boundary values, hostile input, and what an error message is allowed to say.
 *
 * These probes started as the QA screening of this plugin's first pull request
 * (BRO-131): they all passed by hand, which is exactly why they are worth
 * committing — a hand-verified property that nothing asserts is a property the
 * next change can quietly remove.
 *
 * The assertions are about edges rather than about the happy path: the limits a
 * caller can sit exactly on, the values that look falsy but mean something, and
 * the strings an agent could pass hoping to reach a second endpoint or to read
 * the store's credentials back out of an error.
 */
import { describe, expect, it } from "vitest";
import { bigCommerceApiOrigin, executeTool, type ClientOptions } from "../src/bigcommerce.js";
import { PAGE_LIMIT_MAX, PAGE_MAX, TOOL_NAMES } from "../src/constants.js";

let calls: URL[] = [];

function client(body: unknown = { data: [], meta: {} }, status = 200): ClientOptions {
  calls = [];
  return {
    storeHash: "abc123",
    accessToken: "token-xyz",
    fetchImpl: async (url) => {
      calls.push(new URL(url));
      if (status === 204) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

/** The thrown message, or a marker, so a probe can assert on either outcome. */
async function message(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "(did not throw)";
  } catch (error) {
    return (error as Error).message;
  }
}

const idList = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

describe("paging boundaries", () => {
  it("accepts the ends of the limit range and refuses either side of it", async () => {
    await executeTool(client(), TOOL_NAMES.listProducts, { limit: 1 });
    expect(calls[0]!.searchParams.get("limit")).toBe("1");
    await executeTool(client(), TOOL_NAMES.listProducts, { limit: PAGE_LIMIT_MAX });
    expect(calls[0]!.searchParams.get("limit")).toBe(String(PAGE_LIMIT_MAX));

    for (const limit of [0, PAGE_LIMIT_MAX + 1]) {
      expect(
        await message(executeTool(client(), TOOL_NAMES.listProducts, { limit })),
      ).toMatch(/between 1 and 250/);
    }
  });

  it("refuses page 0 and deep paging past its own ceiling", async () => {
    for (const page of [0, PAGE_MAX + 1]) {
      expect(await message(executeTool(client(), TOOL_NAMES.listProducts, { page }))).toMatch(
        /between 1 and 1000/,
      );
    }
  });

  it("caps an ID list at the length BigCommerce's filter accepts", async () => {
    expect(
      await message(executeTool(client(), TOOL_NAMES.listProducts, { productIds: idList(101) })),
    ).toMatch(/at most 100/);
    expect(
      await message(executeTool(client(), TOOL_NAMES.listLocations, { locationIds: idList(51) })),
    ).toMatch(/at most 50/);
  });
});

describe("values that look like nothing but mean something", () => {
  /** `maxInventory: 0` is the only way to ask for out-of-stock products. */
  it("sends maxInventory 0 rather than dropping it as falsy", async () => {
    await executeTool(client(), TOOL_NAMES.listProducts, { maxInventory: 0 });
    expect(calls[0]!.searchParams.get("inventory_level:max")).toBe("0");
  });

  /** An empty array is "I have no IDs to filter on", not "match nothing". */
  it("treats an empty filter array as no filter at all", async () => {
    await executeTool(client(), TOOL_NAMES.listProducts, { productIds: [] });
    expect(calls[0]!.searchParams.get("id:in")).toBeNull();
  });
});

describe("hostile input", () => {
  it("cannot be talked into a second parameter or a different path", async () => {
    await executeTool(client(), TOOL_NAMES.listProducts, {
      keyword: "x&limit=250&sort=id#/../../v2/orders",
    });
    expect(calls[0]!.pathname).toBe("/stores/abc123/v3/catalog/products");
    // The limit stayed the default, so the injected one never became a parameter.
    expect(calls[0]!.searchParams.get("limit")).toBe("50");
    expect(calls[0]!.searchParams.get("keyword")).toBe("x&limit=250&sort=id#/../../v2/orders");
  });

  it("keeps a unicode or emoji SKU intact", async () => {
    await executeTool(client(), TOOL_NAMES.listInventory, { skus: ["SKU-Ü-日本", "🔧-1"] });
    expect(calls[0]!.searchParams.get("sku:in")).toBe("SKU-Ü-日本,🔧-1");
  });

  it("refuses a stored store hash that would retarget every request", async () => {
    const options = {
      storeHash: "abc/../../v2",
      accessToken: "t",
      fetchImpl: async () => new Response("{}"),
    } as ClientOptions;
    expect(await message(executeTool(options, TOOL_NAMES.getStoreInfo, {}))).toMatch(
      /letters and digits only/,
    );
  });
});

describe("origin vetting", () => {
  it.each([
    ["plain http to a public host", "http://api.bigcommerce.com"],
    ["plain http to a LAN host", "http://10.0.0.5"],
    ["embedded credentials", "https://u:p@api.bigcommerce.com"],
    ["a path", "https://api.bigcommerce.com/v3"],
    ["a query string", "https://api.bigcommerce.com?x=1"],
    ["a fragment", "https://api.bigcommerce.com#f"],
    ["a bare host", "api.bigcommerce.com"],
    ["a host that only looks scheme-less", "api:8443"],
    ["a non-http scheme", "file:///etc/passwd"],
  ])("refuses %s", (_label, origin) => {
    expect(() => bigCommerceApiOrigin(origin)).toThrow();
  });

  it.each([
    ["an IPv4 loopback with a port", "http://127.0.0.1:9999", "http://127.0.0.1:9999"],
    ["localhost with a trailing slash", "http://localhost:1/", "http://localhost:1"],
    ["an IPv6 loopback", "http://[::1]:9999", "http://[::1]:9999"],
    ["an https proxy with doubled slashes", "https://proxy.test:8443//", "https://proxy.test:8443"],
  ])("accepts %s", (_label, origin, expected) => {
    expect(bigCommerceApiOrigin(origin)).toBe(expected);
  });
});

describe("error paths leak nothing", () => {
  const cases: Array<[number, RegExp]> = [
    [401, /rejected the access token/],
    [403, /OAuth scope/],
    [404, /no such record/],
    [429, /rate-limited/],
    [500, /server error \(500\)/],
    [418, /failed \(418\)/],
  ];

  for (const [status, expected] of cases) {
    it(`maps ${status} without quoting the store or the upstream body`, async () => {
      const upstream = { error: "store abc123 token s3cr3t-value" };
      const text = await message(
        executeTool(client(upstream, status), TOOL_NAMES.getStoreInfo, {}),
      );
      expect(text).toMatch(expected);
      expect(text).not.toMatch(/abc123|s3cr3t-value|bigcommerce\.com\/stores/);
    });
  }

  it("does not echo the body of an unparseable 200", async () => {
    const options = {
      storeHash: "abc123",
      accessToken: "token-xyz",
      fetchImpl: async () => new Response("<html>abc123 secret</html>", { status: 200 }),
    } as ClientOptions;
    const text = await message(executeTool(options, TOOL_NAMES.getStoreInfo, {}));
    expect(text).toMatch(/could not parse as JSON/);
    expect(text).not.toMatch(/abc123|secret/);
  });
});

describe("statelessness", () => {
  /**
   * The client holds no cursor and no cache, so the same arguments build the
   * same request — which is what makes a retry safe and a read repeatable.
   */
  it("builds an identical request when the same call is made twice", async () => {
    const seen: string[] = [];
    const options: ClientOptions = {
      storeHash: "abc123",
      accessToken: "t",
      fetchImpl: async (url) => {
        seen.push(url);
        return new Response(JSON.stringify({ data: [], meta: {} }), {
          headers: { "content-type": "application/json" },
        });
      },
    };
    await executeTool(options, TOOL_NAMES.listProducts, { keyword: "k", limit: 7 });
    await executeTool(options, TOOL_NAMES.listProducts, { keyword: "k", limit: 7 });
    expect(seen[0]).toBe(seen[1]);
  });
});
