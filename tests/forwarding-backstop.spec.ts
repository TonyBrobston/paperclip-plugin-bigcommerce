/**
 * The backstop that stops a future tool from breaking every agent that calls it.
 *
 * `worker.ts` passes every success through `structured()` before handing it to
 * the host, because the host forwards `ToolResult.data` straight into MCP
 * `structuredContent` and the client's schema requires a record there. Today
 * every tool in `bigcommerce.ts` returns an object, so the guard is unreachable
 * through the real endpoints — which is exactly why it needs a test that does
 * not depend on them. `executeTool` is replaced here so the shapes a later tool
 * could plausibly return (a bare v2 array, a scalar, a null) are driven through
 * the registered handler and the host's forwarding rule.
 *
 * Without the guard this file fails: an array `structuredContent` is rejected by
 * the client the same way `null` is, and the agent loses `content` with it.
 */
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOOL_NAMES } from "../src/constants.js";

const executeTool = vi.hoisted(() => vi.fn());

vi.mock("../src/bigcommerce.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/bigcommerce.js")>()),
  executeTool,
}));

const { default: manifest } = await import("../src/manifest.js");
const { default: plugin } = await import("../src/worker.js");

const CONFIG = {
  storeHash: "abc123",
  accessToken: { type: "secret_ref" as const, secretId: "secret-1" },
};

/** The client-side schema check that rejected every call from this plugin. */
function clientAcceptsStructuredContent(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

beforeEach(() => {
  executeTool.mockReset();
});

describe("structured() keeps a non-object result forwardable", () => {
  it.each([
    ["a bare array, the shape every v2 endpoint answers with", [{ id: 1 }]],
    ["an empty array", []],
    ["a scalar", 42],
    ["a string", "ok"],
    ["null, which a 204 parses to", null],
  ])("wraps %s", async (_label, returned) => {
    const harness = createTestHarness({ manifest, config: CONFIG });
    await plugin.definition.setup(harness.ctx);
    executeTool.mockResolvedValue(returned);

    const result = await harness.executeTool<{ content: string; data: unknown }>(
      TOOL_NAMES.listOrders,
      {},
    );

    // `data` is what the host forwards as `structuredContent`.
    expect(clientAcceptsStructuredContent(result.data)).toBe(true);
    // The payload is still reachable rather than discarded to make it a record.
    expect(JSON.stringify(result.data)).toContain(JSON.stringify(returned));
    // `content` is the agent-readable half and must agree with it.
    expect(JSON.parse(result.content)).toEqual(result.data);
  });

  it("leaves an object result exactly as the tool built it", async () => {
    const harness = createTestHarness({ manifest, config: CONFIG });
    await plugin.definition.setup(harness.ctx);
    const built = { pagination: { page: 1 }, orders: [] };
    executeTool.mockResolvedValue(built);

    const result = await harness.executeTool<{ data: unknown }>(TOOL_NAMES.listOrders, {});
    expect(result.data).toEqual(built);
  });
});
