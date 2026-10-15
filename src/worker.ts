import {
  definePlugin,
  runWorker,
  type EnvSecretRefBinding,
  type PluginConfigValidationResult,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  bigCommerceApiOrigin,
  BigCommerceError,
  executeTool,
  InvalidParameterError,
  type ClientOptions,
} from "./bigcommerce.js";
import { CONFIG_KEYS, DEFAULT_API_ORIGIN } from "./constants.js";
import { TOOL_DECLARATIONS } from "./tools.js";
import { storeHash as validateStoreHash } from "./validate.js";

function isSecretRefBinding(value: unknown): value is EnvSecretRefBinding {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "secret_ref" &&
    typeof (value as { secretId?: unknown }).secretId === "string"
  );
}

const SETTINGS_PATH = "Settings → Plugins → BigCommerce";

/**
 * Read the per-company config and resolve the access token.
 *
 * The token is resolved on every call rather than cached. A worker is spawned
 * once per plugin and serves every company, so a cached credential would be
 * the wrong credential as soon as a second company configured the plugin — and
 * rotating the secret in Paperclip would not take effect until a restart.
 */
async function resolveClientOptions(
  ctx: PluginContext,
  companyId: string,
): Promise<ClientOptions> {
  const config = await ctx.config.get(companyId);

  const storeHash = config[CONFIG_KEYS.storeHash];
  if (typeof storeHash !== "string" || storeHash.trim() === "") {
    throw new BigCommerceError(
      `This plugin has no BigCommerce store hash configured. Set it in ${SETTINGS_PATH}.`,
    );
  }

  const tokenRef = config[CONFIG_KEYS.accessToken];
  if (!isSecretRefBinding(tokenRef)) {
    throw new BigCommerceError(
      `This plugin has no BigCommerce access token configured. Add a store API account token in ${SETTINGS_PATH}.`,
    );
  }

  const accessToken = await ctx.secrets.resolve(tokenRef, {
    companyId,
    configPath: CONFIG_KEYS.accessToken,
  });
  if (!accessToken) {
    throw new BigCommerceError(
      "The configured BigCommerce access token secret resolved to an empty value.",
    );
  }

  const apiOrigin = config[CONFIG_KEYS.apiOrigin];
  return {
    storeHash,
    accessToken,
    ...(typeof apiOrigin === "string" && apiOrigin.trim() !== "" ? { apiOrigin } : {}),
  };
}

/**
 * Turn a thrown error into a tool result.
 *
 * Returning `{ error }` rather than throwing keeps the message useful to the
 * agent — a bad product ID should read as "fix the argument", not as a plugin
 * crash. Only messages this plugin wrote are passed through; anything else is
 * replaced, because an arbitrary runtime error can carry the store hash or
 * request detail in its text.
 */
function toolError(error: unknown): ToolResult {
  if (error instanceof InvalidParameterError || error instanceof BigCommerceError) {
    return { error: error.message };
  }
  return { error: "The BigCommerce request failed." };
}

const plugin = definePlugin({
  async setup(ctx: PluginContext): Promise<void> {
    for (const declaration of TOOL_DECLARATIONS) {
      ctx.tools.register(
        declaration.name,
        {
          displayName: declaration.displayName,
          description: declaration.description,
          parametersSchema: declaration.parametersSchema,
        },
        async (params: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
          try {
            const options = await resolveClientOptions(ctx, runCtx.companyId);
            const data = await executeTool(options, declaration.name, params);
            return {
              // The agent reads `content`; `data` keeps the structured form
              // for anything that consumes the result programmatically.
              content: JSON.stringify(data, null, 2),
              data: data as Record<string, unknown>,
            };
          } catch (error) {
            return toolError(error);
          }
        },
      );
    }
  },

  /**
   * Shape-only validation, and the "only" is deliberate.
   *
   * The host calls this on start, on save, and behind the settings page's Test
   * Connection button — but it passes the config without a company ID, and
   * resolving the token ref requires one. So this cannot make a live request.
   * It checks what it can and says plainly what it did not check, rather than
   * reporting a green "connected" that was never tested.
   */
  async onValidateConfig(
    config: Record<string, unknown>,
  ): Promise<PluginConfigValidationResult> {
    const errors: string[] = [];

    const storeHash = config[CONFIG_KEYS.storeHash];
    if (typeof storeHash !== "string" || storeHash.trim() === "") {
      errors.push("Enter your BigCommerce store hash.");
    } else {
      try {
        validateStoreHash(storeHash);
      } catch (error) {
        errors.push(
          error instanceof Error
            ? error.message
            : "The store hash could not be validated.",
        );
      }
    }

    if (!isSecretRefBinding(config[CONFIG_KEYS.accessToken])) {
      errors.push("Select a secret holding a BigCommerce store API access token.");
    }

    const apiOrigin = config[CONFIG_KEYS.apiOrigin];
    if (apiOrigin !== undefined && apiOrigin !== null && apiOrigin !== "") {
      if (typeof apiOrigin !== "string") {
        errors.push("The API origin must be a string, or left blank.");
      } else {
        try {
          bigCommerceApiOrigin(apiOrigin);
        } catch (error) {
          errors.push(
            error instanceof BigCommerceError
              ? error.message
              : "The API origin could not be parsed.",
          );
        }
      }
    }

    if (errors.length > 0) return { ok: false, errors };

    const origin =
      typeof apiOrigin === "string" && apiOrigin.trim() !== ""
        ? bigCommerceApiOrigin(apiOrigin)
        : DEFAULT_API_ORIGIN;
    return {
      ok: true,
      warnings: [
        `Store hash and token reference look valid, and requests will go to ${origin}. This check does not contact BigCommerce — ask an agent to run get_store_info to confirm the store resolves and the token is accepted.`,
      ],
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
