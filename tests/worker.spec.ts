/**
 * Worker-level tests: the plugin as the host drives it.
 *
 * These go through the SDK's in-memory host harness, so registration, config
 * reads, secret resolution and the error contract are exercised through the
 * same calls the real host makes rather than through direct imports.
 */
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_NAMES } from "../src/constants.js";
import manifest from "../src/manifest.js";
import { TOOL_DECLARATIONS } from "../src/tools.js";
import plugin from "../src/worker.js";

const TOKEN_REF = { type: "secret_ref" as const, secretId: "secret-1" };
const CONFIG = { storeHash: "abc123", accessToken: TOKEN_REF };

async function harnessWith(config: Record<string, unknown>) {
  const harness = createTestHarness({ manifest, config });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

function stubFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

/** Enough of a response to satisfy whichever tool is being smoke-registered. */
function defaultParamsFor(name: string): Record<string, unknown> {
  if (name === TOOL_NAMES.getProduct || name === TOOL_NAMES.listProductVariants) {
    return { productId: 1 };
  }
  if (name === TOOL_NAMES.getOrder || name === TOOL_NAMES.listOrderProducts) {
    return { orderId: 1 };
  }
  if (name === TOOL_NAMES.listCategories) return { treeId: 1 };
  return {};
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("manifest and registration", () => {
  it("declares and registers the same tools", async () => {
    const harness = await harnessWith(CONFIG);
    const declared = manifest.tools?.map((tool) => tool.name).sort() ?? [];
    expect(declared).toEqual(TOOL_DECLARATIONS.map((tool) => tool.name).sort());

    // A declared tool with no handler would publish an action to agents that
    // always fails, so prove each one is actually wired.
    for (const tool of TOOL_DECLARATIONS) {
      stubFetch({ data: [], meta: {} });
      await expect(
        harness.executeTool(tool.name, defaultParamsFor(tool.name)),
      ).resolves.toBeDefined();
    }
  });

  it("asks for no capability beyond what it uses", () => {
    expect([...manifest.capabilities].sort()).toEqual([
      "agent.tools.register",
      "http.outbound",
      "secrets.read-ref",
    ]);
  });

  it("declares no UI entrypoint, so the host renders the settings form", () => {
    expect(manifest.entrypoints.ui).toBeUndefined();
    expect(manifest.instanceConfigSchema).toBeDefined();
  });

  it("marks the token field as a secret reference rather than text", () => {
    const properties = (
      manifest.instanceConfigSchema as {
        properties: Record<string, { format?: string; type?: string }>;
      }
    ).properties;
    expect(properties.accessToken!.format).toBe("secret-ref");
    // The settings form's secret picker writes an object, and the host runs
    // Ajv over this schema before it looks for bindings — so `type: "string"`
    // here would make the form impossible to save.
    expect(properties.accessToken!.type).toBe("object");
  });

  it("gives every tool a description an agent can choose from", () => {
    for (const tool of TOOL_DECLARATIONS) {
      expect(tool.displayName, tool.name).toMatch(/^BigCommerce: /);
      expect(tool.description.length, tool.name).toBeGreaterThan(80);
      // `additionalProperties: false` is what makes an unknown argument a
      // visible error rather than a silently ignored filter.
      expect(tool.parametersSchema.additionalProperties, tool.name).toBe(false);
    }
  });
});

/**
 * The host classifies a plugin tool's risk by regex-matching its name and
 * cannot be told otherwise: the manifest tool schema has no risk field, and
 * `tool-gateway.ts` overwrites whatever the dispatcher reports with
 * `inferToolRisk(tool.name)`. This is that classifier, copied, so that adding a
 * tool whose name reads as a mutation fails here instead of silently shipping
 * an action that is auto-allowed or — if gated — cannot execute after approval.
 */
function inferToolRisk(toolName: string): "read" | "write" | "destructive" {
  const lower = toolName.toLowerCase();
  if (
    /\b(delete|destroy|remove|drop|truncate|wipe|purge)\b|(^|[:._-])(delete|destroy|remove|drop|truncate|wipe|purge)([:._-]|$)/.test(
      lower,
    )
  ) {
    return "destructive";
  }
  if (
    /\b(create|update|write|edit|patch|post|send|publish|merge|commit|apply)\b|(^|[:._-])(create|update|write|edit|patch|post|send|publish|merge|commit|apply)([:._-]|$)/.test(
      lower,
    )
  ) {
    return "write";
  }
  return "read";
}

describe("host risk classification", () => {
  it("classifies every tool as read, under its namespaced name", () => {
    for (const tool of TOOL_DECLARATIONS) {
      const namespacedName = `${manifest.id}:${tool.name}`;
      expect(inferToolRisk(namespacedName), namespacedName).toBe("read");
    }
  });
});

describe("tool execution", () => {
  it("sends the resolved secret as the X-Auth-Token header", async () => {
    const harness = await harnessWith(CONFIG);
    const calls = stubFetch({ name: "Shop" });
    await harness.executeTool(TOOL_NAMES.getStoreInfo, {});
    const headers = calls[0]!.init.headers as Record<string, string>;
    // The harness resolver echoes the ref, which proves the token came from
    // secret resolution rather than from config text.
    expect(headers["X-Auth-Token"]).toMatch(/^resolved:/);
    expect(calls[0]!.url).toBe("https://api.bigcommerce.com/stores/abc123/v2/store");
  });

  it("returns both agent-readable content and structured data", async () => {
    const harness = await harnessWith(CONFIG);
    stubFetch({ name: "Shop", currency: "USD" });
    const result = await harness.executeTool<{ content: string; data: unknown }>(
      TOOL_NAMES.getStoreInfo,
      {},
    );
    expect(JSON.parse(result.content)).toMatchObject({ name: "Shop", currency: "USD" });
    expect(result.data).toMatchObject({ name: "Shop" });
  });

  it("honours a configured API origin", async () => {
    const harness = await harnessWith({ ...CONFIG, apiOrigin: "http://127.0.0.1:9999" });
    const calls = stubFetch({ name: "Shop" });
    await harness.executeTool(TOOL_NAMES.getStoreInfo, {});
    expect(calls[0]!.url).toBe("http://127.0.0.1:9999/stores/abc123/v2/store");
  });

  it("ignores a blank API origin instead of failing to parse it", async () => {
    const harness = await harnessWith({ ...CONFIG, apiOrigin: "   " });
    const calls = stubFetch({ name: "Shop" });
    await harness.executeTool(TOOL_NAMES.getStoreInfo, {});
    expect(calls[0]!.url).toMatch(/^https:\/\/api\.bigcommerce\.com\//);
  });

  it("tells the operator where to fix a missing store hash", async () => {
    const harness = await harnessWith({ accessToken: TOKEN_REF });
    const result = await harness.executeTool<{ error: string }>(TOOL_NAMES.getStoreInfo, {});
    expect(result.error).toMatch(/no BigCommerce store hash configured/);
    expect(result.error).toMatch(/Settings → Plugins → BigCommerce/);
  });

  it("tells the operator where to fix a missing token", async () => {
    const harness = await harnessWith({ storeHash: "abc123" });
    const result = await harness.executeTool<{ error: string }>(TOOL_NAMES.getStoreInfo, {});
    expect(result.error).toMatch(/no BigCommerce access token configured/);
  });

  it("rejects a token stored as plain text instead of a secret reference", async () => {
    const harness = await harnessWith({ storeHash: "abc123", accessToken: "a-raw-token" });
    const result = await harness.executeTool<{ error: string }>(TOOL_NAMES.getStoreInfo, {});
    expect(result.error).toMatch(/no BigCommerce access token configured/);
  });

  it("returns a bad argument as a fixable error, not a crash", async () => {
    const harness = await harnessWith(CONFIG);
    stubFetch({});
    const result = await harness.executeTool<{ error: string }>(TOOL_NAMES.getProduct, {
      productId: "forty-two",
    });
    expect(result.error).toMatch(/"productId" must be an integer/);
  });

  it("replaces an unexpected runtime error rather than forwarding its text", async () => {
    const harness = await harnessWith({ ...CONFIG, apiOrigin: "https://proxy.internal.test" });
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED https://proxy.internal.test/stores/abc123/v2/store");
    });
    const result = await harness.executeTool<{ error: string }>(TOOL_NAMES.getStoreInfo, {});
    expect(result.error).toMatch(/could not be reached/);
    expect(result.error).not.toMatch(/proxy\.internal\.test/);
    expect(result.error).not.toMatch(/abc123/);
  });

  /**
   * A worker serves every company, so the token has to be resolved per call.
   * A cached one would be the wrong credential as soon as a second company
   * configured the plugin.
   */
  it("resolves the secret on every call rather than caching it", async () => {
    const harness = await harnessWith(CONFIG);
    stubFetch({ name: "Shop" });
    const resolve = vi.spyOn(harness.ctx.secrets, "resolve");
    await harness.executeTool(TOOL_NAMES.getStoreInfo, {});
    await harness.executeTool(TOOL_NAMES.getStoreInfo, {});
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("reads the config for the calling company", async () => {
    const harness = await harnessWith(CONFIG);
    stubFetch({ name: "Shop" });
    const get = vi.spyOn(harness.ctx.config, "get");
    await harness.executeTool(TOOL_NAMES.getStoreInfo, {}, { companyId: "company-9" });
    expect(get).toHaveBeenCalledWith("company-9");
  });
});

describe("onValidateConfig", () => {
  it("accepts a valid pair but says it did not contact BigCommerce", async () => {
    const result = await plugin.definition.onValidateConfig!(CONFIG);
    expect(result.ok).toBe(true);
    expect(result.warnings?.join(" ")).toMatch(/does not contact BigCommerce/);
    expect(result.warnings?.join(" ")).toMatch(/https:\/\/api\.bigcommerce\.com/);
  });

  it("names the configured origin in the warning, so a proxy is visible", async () => {
    const result = await plugin.definition.onValidateConfig!({
      ...CONFIG,
      apiOrigin: "https://proxy.test",
    });
    expect(result.ok).toBe(true);
    expect(result.warnings?.join(" ")).toMatch(/https:\/\/proxy\.test/);
  });

  it("rejects a store hash pasted as a URL", async () => {
    const result = await plugin.definition.onValidateConfig!({
      ...CONFIG,
      storeHash: "https://api.bigcommerce.com/stores/abc123/v3/",
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.join(" ")).toMatch(/letters and digits only/);
  });

  it("rejects a token that is not a secret reference", async () => {
    const result = await plugin.definition.onValidateConfig!({
      ...CONFIG,
      accessToken: "a-raw-token",
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.join(" ")).toMatch(/secret/);
  });

  it("rejects an http origin that is not loopback", async () => {
    const result = await plugin.definition.onValidateConfig!({
      ...CONFIG,
      apiOrigin: "http://api.bigcommerce.com",
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.join(" ")).toMatch(/loopback/);
  });

  it("accepts a blank origin as 'use the default'", async () => {
    const result = await plugin.definition.onValidateConfig!({ ...CONFIG, apiOrigin: "" });
    expect(result.ok).toBe(true);
  });

  it("reports both missing fields at once", async () => {
    const result = await plugin.definition.onValidateConfig!({});
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
  });
});
