/**
 * Identity, limits and tool names for the BigCommerce plugin.
 *
 * Kept dependency-free so the worker bundle stays small and the installed
 * package needs no `node_modules` at runtime (the bundler inlines the SDK).
 */

export const PLUGIN_ID = "tbro.bigcommerce";
export const PLUGIN_VERSION = "0.1.0";

/** Where a BigCommerce store API lives unless an operator points elsewhere. */
export const DEFAULT_API_ORIGIN = "https://api.bigcommerce.com";

/**
 * The one rule for what an operator may type into "API origin".
 *
 * It lives here because it has to be enforced in two places that cannot share
 * code: the manifest's `instanceConfigSchema`, which is the only check a *save*
 * runs, and {@link bigCommerceApiOrigin}, which is what every request goes
 * through. Those two drifted apart in both directions, and both directions are
 * bad in the same way — the operator cannot tell what is wrong:
 *
 *  - stricter at save than at runtime meant `  https://api.bigcommerce.com  `
 *    and `http://LOCALHOST:3000` were refused with the host's opaque
 *    "Configuration does not match the plugin's instanceConfigSchema", even
 *    though the worker trims and lowercases and would have accepted both. So
 *    this pattern tolerates surrounding whitespace and any letter case.
 *  - looser at save than at runtime meant `http://localhost:99999` saved green
 *    and then failed every tool call, because a port above 65535 makes `new
 *    URL` throw. So the port is bounded here, and the host part is a hostname
 *    or bracketed IPv6 address rather than "any run of non-space characters".
 *
 * Non-canonical loopback spellings — `http://127.1`, `http://2130706433`,
 * `http://[0:0:0:0:0:0:0:1]` — are refused by both layers. `new URL` happily
 * canonicalizes all three to loopback, so accepting them would be safe, but no
 * regex can enumerate them (that last one is an integer). Refusing them
 * consistently, with a message naming the three spellings that do work, beats
 * accepting them in one layer and not the other.
 */
const ORIGIN_HOST = "(?:[A-Za-z0-9._-]+|\\[[0-9A-Fa-f:]+\\])";
const ORIGIN_LOOPBACK =
  "(?:[Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt]|127(?:\\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])){3}|\\[::1\\])";
const ORIGIN_PORT =
  "(?::(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|65[0-5][0-9]|6553[0-5]))?";
const ORIGIN_HTTPS = "[Hh][Tt][Tt][Pp][Ss]";
const ORIGIN_HTTP = "[Hh][Tt][Tt][Pp]";

export const API_ORIGIN_PATTERN =
  `^\\s*$` +
  `|^\\s*${ORIGIN_HTTPS}://${ORIGIN_HOST}${ORIGIN_PORT}/*\\s*$` +
  `|^\\s*${ORIGIN_HTTP}://${ORIGIN_LOOPBACK}${ORIGIN_PORT}/*\\s*$`;

/** The loopback spellings {@link API_ORIGIN_PATTERN} accepts, for error text. */
export const LOOPBACK_SPELLINGS = ["localhost", "127.0.0.1", "[::1]"] as const;

/**
 * Bare tool names. The host namespaces these as `<PLUGIN_ID>:<name>` when it
 * publishes them to an agent, so `list_products` reaches a run as
 * `tbro.bigcommerce:list_products`.
 *
 * Every name here is a read, and that is not a stylistic choice: the host
 * infers a plugin tool's risk class from its name and cannot be told
 * otherwise. A name that reads as a mutation is classified `write` or
 * `destructive`; a name that mutates while reading as a read is classified
 * `read` and skips the gate it needed. Read names on read-only endpoints keep
 * the inference correct. See README "Why this plugin is read-only".
 */
export const TOOL_NAMES = {
  getStoreInfo: "get_store_info",
  getCatalogSummary: "get_catalog_summary",
  listProducts: "list_products",
  getProduct: "get_product",
  listProductVariants: "list_product_variants",
  listCategoryTrees: "list_category_trees",
  listCategories: "list_categories",
  listBrands: "list_brands",
  listOrders: "list_orders",
  getOrder: "get_order",
  listOrderProducts: "list_order_products",
  listCustomers: "list_customers",
  listInventory: "list_inventory",
  listLocations: "list_locations",
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

/**
 * BigCommerce caps `limit` at 250 across both API versions and defaults it to
 * 50. This plugin asks for 50 when the caller says nothing, because a page of
 * 250 products is mostly context the run will not read.
 */
export const PAGE_LIMIT_MAX = 250;
export const PAGE_LIMIT_DEFAULT = 50;

/**
 * The `sort` and `direction` values `/v3/catalog/products` documents.
 *
 * This is the endpoint's full published enum, not a selection from it. An
 * earlier hand-picked subset of seven left out `calculated_price` and
 * `available_to_sell` — the two an agent asking "what is selling" or "what can
 * I actually ship" would reach for — with nothing to notice the omission.
 * `openapi-contract.spec.ts` now asserts this list against the spec's enum, so
 * a value BigCommerce adds shows up as a failing test rather than as a filter
 * the plugin quietly refuses.
 */
export const PRODUCT_SORT_FIELDS = [
  "available_to_sell",
  "backorder_limit",
  "calculated_price",
  "date_last_imported",
  "date_modified",
  "id",
  "inventory_level",
  "is_visible",
  "name",
  "price",
  "qty_backordered",
  "sku",
  "total_sold",
] as const;

export const SORT_DIRECTIONS = ["asc", "desc"] as const;

/** Highest `page` this plugin will request. Deep paging means a filter is missing. */
export const PAGE_MAX = 1000;

/** Largest response body read from BigCommerce, before parsing. */
export const RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024;

/** Per-request timeout. BigCommerce is a remote API over the internet. */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Config keys on the instance settings page.
 *
 * `accessToken` holds a Paperclip secret reference, never raw credential
 * material.
 */
export const CONFIG_KEYS = {
  storeHash: "storeHash",
  accessToken: "accessToken",
  apiOrigin: "apiOrigin",
} as const;
