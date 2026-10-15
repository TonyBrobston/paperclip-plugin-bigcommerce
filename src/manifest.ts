import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { CONFIG_KEYS, DEFAULT_API_ORIGIN, PLUGIN_ID, PLUGIN_VERSION } from "./constants.js";
import { TOOL_DECLARATIONS } from "./tools.js";

/**
 * BigCommerce, as a read-only Paperclip plugin.
 *
 * Capabilities are deliberately minimal. The plugin reads its own config and
 * resolves one secret ref; it asks for nothing about companies, projects,
 * issues or agents, because none of those are needed to answer "how many of
 * SKU-1234 are left in the Dallas warehouse".
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "BigCommerce (read-only)",
  description:
    "Read-only access to a BigCommerce store: catalog products, variants, categories and brands, orders and their line items, customers, and per-location inventory. Lets an agent look up store data directly instead of asking an operator to export it.",
  author: "Tony Brobston",
  categories: ["connector"],
  capabilities: ["http.outbound", "secrets.read-ref", "agent.tools.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      [CONFIG_KEYS.storeHash]: {
        type: "string",
        title: "Store hash",
        description:
          "The short alphanumeric store identifier, not a URL. Find it in the API path BigCommerce shows for your store API account: in https://api.bigcommerce.com/stores/abc123xyz/v3/ the store hash is abc123xyz.",
        // Letters and digits only. This value becomes a path segment, so a
        // slash or a pasted full URL has to be refused at the form rather than
        // retargeting every request the plugin makes.
        pattern: "^[A-Za-z0-9]{1,64}$",
      },
      [CONFIG_KEYS.accessToken]: {
        // `format: "secret-ref"` is what makes the settings form render a
        // secret picker, and the picker writes a binding *object* — not a
        // string. The host validates this schema with Ajv before it looks for
        // secret bindings, so declaring `type: "string"` here would reject the
        // only value the form can produce, with "/accessToken must be string".
        // The field has to be typed as the object it receives.
        //
        // Ajv's strict mode logs that `format` expects a string or number
        // type; it is a log, not an error, and the keyword is a host-side UI
        // hint that never validates a value.
        type: "object",
        format: "secret-ref",
        title: "API access token",
        description:
          "Create a store-level API account in your BigCommerce control panel under Settings → API → Store-level API accounts, grant it read-only scopes, then save its access token as a Paperclip secret and pick it here. A token pasted as raw text is refused rather than stored in this config.",
        properties: {
          type: { const: "secret_ref" },
          secretId: { type: "string", minLength: 1 },
          // `version` is deliberately unconstrained. The host's own binding
          // parser accepts "latest" or a positive integer, so a pinned version
          // arrives as a number, and over-constraining this field is what makes
          // the settings form impossible to save. The host parses and rejects a
          // bad binding after this schema runs.
        },
        required: ["type", "secretId"],
      },
      [CONFIG_KEYS.apiOrigin]: {
        type: "string",
        title: "API origin (optional)",
        description: `Leave blank for the BigCommerce API at ${DEFAULT_API_ORIGIN}. Set it only to send requests through a proxy or a mock. Must be https, with no path; plain http is accepted only for a loopback address, because the access token travels in a header on every request.`,
        pattern: "^$|^https?://[^\\s/?#@]+/*$",
      },
    },
    required: [CONFIG_KEYS.storeHash, CONFIG_KEYS.accessToken],
  },
  tools: TOOL_DECLARATIONS.map((tool) => ({
    name: tool.name,
    displayName: tool.displayName,
    description: tool.description,
    parametersSchema: tool.parametersSchema,
  })),
};

export default manifest;
