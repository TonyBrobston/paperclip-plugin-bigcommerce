/**
 * The host validates `configJson` against `instanceConfigSchema` with Ajv
 * before it will save a settings form, and it reports a failure as
 * "Configuration does not match the plugin's instanceConfigSchema" with no
 * mention of which value or which rule. So a schema that is stricter than the
 * worker does not produce a correction, it produces an operator who believes
 * the plugin is broken.
 *
 * These tests drive the real manifest schema through the same validator the
 * server builds — Ajv with formats and the host's permissive `secret-ref`
 * format — so the accepted set is asserted against the thing that actually
 * gates the save, not against a regex copied out of the manifest.
 */
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { bigCommerceApiOrigin, bigCommerceUrl } from "../src/bigcommerce.js";
import manifest from "../src/manifest.js";

/**
 * The shape the host's settings form actually submits for a `secret-ref`
 * field: `SecretRefField` in `JsonSchemaForm.tsx` emits this object when a
 * secret is chosen from the dropdown.
 */
const TOKEN_REF = {
  type: "secret_ref",
  secretId: "11111111-1111-4111-8111-111111111111",
  version: "latest",
};

/**
 * Mirrors `validateInstanceConfig` in the host's plugin-config-validator,
 * including its interop dance: under ESM both packages expose the real export
 * on `.default`, which is why the host reaches for it the same way.
 */
function validateConfig(config: Record<string, unknown>): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const AjvCtor = (Ajv as any).default ?? Ajv;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const applyFormats = (addFormats as any).default ?? addFormats;
  const ajv = new AjvCtor({ allErrors: true });
  applyFormats(ajv);
  // A UI hint on the host side; it never rejects a value.
  ajv.addFormat("secret-ref", { validate: () => true });
  const validate = ajv.compile(manifest.instanceConfigSchema!);
  return validate(config) as boolean;
}

const withStoreHash = (storeHash: unknown) =>
  validateConfig({ storeHash, accessToken: TOKEN_REF });

const withOrigin = (apiOrigin: unknown) =>
  validateConfig({ storeHash: "abc123", accessToken: TOKEN_REF, apiOrigin });

describe("instance config schema", () => {
  /**
   * The host parses the manifest with this schema before it will install or
   * activate the plugin, so a manifest edit that violates it does not produce
   * a failing tool — it produces a plugin that will not load at all. Asserted
   * against the published `@paperclipai/shared`, not a local copy of it.
   */
  it("keeps the manifest valid against the host's published schema", () => {
    const result = pluginManifestV1Schema.safeParse(manifest);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("requires the store hash and the token", () => {
    expect(validateConfig({ storeHash: "abc123" })).toBe(false);
    expect(validateConfig({ accessToken: TOKEN_REF })).toBe(false);
    expect(validateConfig({ storeHash: "abc123", accessToken: TOKEN_REF })).toBe(true);
  });

  describe("store hash field", () => {
    it.each([
      ["a lowercase hash", "abc123xyz"],
      ["a mixed-case hash", "Abc123XYZ"],
      ["a digits-only hash", "1234567890"],
    ])("accepts %s", (_label, hash) => {
      expect(withStoreHash(hash)).toBe(true);
    });

    /**
     * The store hash becomes a path segment. The common operator mistake is
     * pasting the whole API URL into the field, and that has to be refused at
     * the form rather than retargeting every request the plugin makes.
     */
    it.each([
      ["a pasted API URL", "https://api.bigcommerce.com/stores/abc123/v3/"],
      ["a path traversal", "abc/../../v3"],
      ["a leading slash", "/abc123"],
      ["a hash with a space", "abc 123"],
      ["a hash with a hyphen", "abc-123"],
      ["an empty string", ""],
      ["a number", 123],
      ["null", null],
    ])("rejects %s", (_label, hash) => {
      expect(withStoreHash(hash)).toBe(false);
    });
  });

  /**
   * The token field is the one the operator cannot work around: there is no
   * way to put a different shape in it, because the picker produces this one.
   * A schema that rejects it blocks the save outright.
   */
  describe("access token field", () => {
    const withToken = (accessToken: unknown) =>
      validateConfig({ storeHash: "abc123", accessToken });

    it("accepts the binding object the secret picker submits", () => {
      expect(withToken(TOKEN_REF)).toBe(true);
    });

    it("accepts a binding with no explicit version", () => {
      expect(withToken({ type: "secret_ref", secretId: TOKEN_REF.secretId })).toBe(true);
    });

    /**
     * The host's `parseSecretRefBindingObject` accepts "latest" or a positive
     * integer, so a pinned secret version reaches this schema as a number.
     * Over-constraining `version` is the mistake that makes the save
     * impossible.
     */
    it("accepts a binding pinned to a numbered version", () => {
      expect(withToken({ type: "secret_ref", secretId: TOKEN_REF.secretId, version: 3 })).toBe(
        true,
      );
    });

    /**
     * The picker also allows typing a value straight into the field. Saving
     * that would persist a long-lived store credential as plaintext in plugin
     * config — and the worker requires a binding, so every tool call would
     * fail afterwards anyway. Refusing the save is the honest outcome.
     */
    it("refuses a raw pasted token rather than storing it as text", () => {
      expect(withToken("a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6")).toBe(false);
    });

    it.each([
      ["a different binding kind", { type: "user_secret_ref", secretId: TOKEN_REF.secretId }],
      ["a binding with no secret id", { type: "secret_ref" }],
      ["a binding with an empty secret id", { type: "secret_ref", secretId: "" }],
      ["an empty object", {}],
      ["null", null],
    ])("rejects %s", (_label, token) => {
      expect(withToken(token)).toBe(false);
    });
  });

  describe("api origin field", () => {
    it("is optional, and blank means the default", () => {
      expect(validateConfig({ storeHash: "abc123", accessToken: TOKEN_REF })).toBe(true);
      expect(withOrigin("")).toBe(true);
    });

    /**
     * `[input, what the request builder makes of it]`.
     *
     * The last three are here because the form used to be *stricter* than the
     * worker, and the host reports that as the opaque "Configuration does not
     * match the plugin's instanceConfigSchema". Pasting a value with a trailing
     * space, or typing a scheme or hostname in capitals, is ordinary; the worker
     * trims and `new URL` lowercases both, so refusing them at the form was a
     * dead end with no explanation attached.
     */
    const ACCEPTED = [
      ["the default origin", "https://api.bigcommerce.com", "https://api.bigcommerce.com"],
      [
        "an origin pasted with a trailing slash",
        "https://api.bigcommerce.com/",
        "https://api.bigcommerce.com",
      ],
      ["an IPv4 loopback mock", "http://127.0.0.1:8080", "http://127.0.0.1:8080"],
      ["a localhost mock", "http://localhost:3000", "http://localhost:3000"],
      ["an IPv6 loopback mock", "http://[::1]:3000", "http://[::1]:3000"],
      [
        "an origin pasted with surrounding whitespace",
        "  https://api.bigcommerce.com  ",
        "https://api.bigcommerce.com",
      ],
      ["an uppercase hostname", "http://LOCALHOST:3000", "http://localhost:3000"],
      ["an uppercase scheme", "HTTPS://api.bigcommerce.com", "https://api.bigcommerce.com"],
    ] as const;

    it.each(ACCEPTED)("accepts %s", (_label, origin) => {
      expect(withOrigin(origin)).toBe(true);
    });

    it.each([
      ["no scheme", "api.bigcommerce.com"],
      ["a path", "https://api.bigcommerce.com/stores"],
      ["embedded credentials", "https://u:p@api.bigcommerce.com"],
      ["a query string", "https://api.bigcommerce.com?x=1"],
    ])("rejects %s", (_label, origin) => {
      expect(withOrigin(origin)).toBe(false);
    });

    /**
     * The other direction of the same drift: these used to save green and then
     * fail every tool call, because the pattern was looser than the worker.
     *
     * `http://localhost:99999` is the clearest case — above 65535 `new URL`
     * throws, so the stored config was dead and the error said "must be a full
     * URL" without mentioning the port. The two non-canonical loopback
     * spellings are the opposite: `new URL` canonicalizes both to loopback and
     * the worker accepted them, but no pattern can enumerate every spelling of
     * 127.0.0.1 (`http://2130706433` is one), so both layers now refuse them
     * and the worker's message names the three that work.
     */
    it.each([
      ["a port above 65535", "http://localhost:99999"],
      ["IPv4 loopback shorthand", "http://127.1"],
      ["loopback as an integer", "http://2130706433"],
      ["uncompressed IPv6 loopback", "http://[0:0:0:0:0:0:0:1]"],
    ])("rejects %s at the form and at request time alike", (_label, origin) => {
      expect(withOrigin(origin)).toBe(false);
      expect(() => bigCommerceApiOrigin(origin)).toThrow();
    });

    /**
     * This pattern has to carry the https restriction itself. The worker's
     * `onValidateConfig` rejects plaintext too, but the host calls that from
     * one place only — the settings page's Test Connection button. A save runs
     * Ajv against this schema and nothing else, so without the restriction here
     * `http://api.bigcommerce.com` saved green and then failed every tool call:
     * a dead config rather than a refused one.
     */
    it.each([
      ["plain http to the real API", "http://api.bigcommerce.com"],
      ["plain http to a LAN host", "http://10.0.0.5"],
      ["plain http to a hostname that merely starts with localhost", "http://localhost.evil.test"],
      ["plain http to a non-loopback 127-lookalike", "http://127.0.0.1.evil.test"],
    ])("rejects %s at save, not at request time", (_label, origin) => {
      expect(withOrigin(origin)).toBe(false);
    });

    /**
     * The schema and the request builder are separate guards on the same value,
     * and the builder is the one that runs on stored config that may predate
     * the field. They have to agree in both directions: anything the form
     * accepts must survive the builder, and anything the builder refuses must
     * never have been savable. Both layers now test the same pattern constant,
     * so the remaining job of this test is the normalization: what the builder
     * turns each accepted value into.
     */
    it.each(ACCEPTED)("agrees with the request builder about %s", (_label, origin, canonical) => {
      expect(bigCommerceApiOrigin(origin)).toBe(canonical);
    });
  });

  it("accepts only configuration the request builder can use", () => {
    for (const storeHash of ["abc123xyz", "Abc123XYZ", "1234567890"]) {
      expect(withStoreHash(storeHash)).toBe(true);
      expect(bigCommerceUrl({ storeHash, accessToken: "t" }, "/v2/store").pathname).toBe(
        `/stores/${storeHash}/v2/store`,
      );
    }
  });
});
