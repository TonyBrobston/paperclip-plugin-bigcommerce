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
