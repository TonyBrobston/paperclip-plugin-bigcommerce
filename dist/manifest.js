// src/constants.ts
var PLUGIN_ID = "tbro.bigcommerce";
var PLUGIN_VERSION = "0.1.0";
var DEFAULT_API_ORIGIN = "https://api.bigcommerce.com";
var ORIGIN_HOST = "(?:[A-Za-z0-9._-]+|\\[[0-9A-Fa-f:]+\\])";
var ORIGIN_LOOPBACK = "(?:[Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt]|127(?:\\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])){3}|\\[::1\\])";
var ORIGIN_PORT = "(?::(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|65[0-5][0-9]|6553[0-5]))?";
var ORIGIN_HTTPS = "[Hh][Tt][Tt][Pp][Ss]";
var ORIGIN_HTTP = "[Hh][Tt][Tt][Pp]";
var API_ORIGIN_PATTERN = `^\\s*$|^\\s*${ORIGIN_HTTPS}://${ORIGIN_HOST}${ORIGIN_PORT}/*\\s*$|^\\s*${ORIGIN_HTTP}://${ORIGIN_LOOPBACK}${ORIGIN_PORT}/*\\s*$`;
var TOOL_NAMES = {
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
  listLocations: "list_locations"
};
var PAGE_LIMIT_MAX = 250;
var PAGE_LIMIT_DEFAULT = 50;
var PRODUCT_SORT_FIELDS = [
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
  "total_sold"
];
var SORT_DIRECTIONS = ["asc", "desc"];
var ORDER_SORT_FIELDS = [
  "channel_id",
  "customer_id",
  "date_created",
  "date_modified",
  "external_id",
  "id",
  "status_id"
];
var ORDER_SORT_VALUES = ORDER_SORT_FIELDS.flatMap(
  (field) => SORT_DIRECTIONS.map((direction) => `${field}:${direction}`)
);
var PAGE_MAX = 1e3;
var RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024;
var CONFIG_KEYS = {
  storeHash: "storeHash",
  accessToken: "accessToken",
  apiOrigin: "apiOrigin"
};

// src/tools.ts
var pageProperty = {
  type: "integer",
  minimum: 1,
  maximum: PAGE_MAX,
  description: "1-based page number (default 1)."
};
var limitProperty = {
  type: "integer",
  minimum: 1,
  maximum: PAGE_LIMIT_MAX,
  description: `Rows per page, up to ${PAGE_LIMIT_MAX} (default ${PAGE_LIMIT_DEFAULT}).`
};
var paging = { page: pageProperty, limit: limitProperty };
function idArray(description, maxItems = 100) {
  return {
    type: "array",
    items: { type: "integer", minimum: 1 },
    maxItems,
    description
  };
}
function object(properties, required = []) {
  return {
    type: "object",
    properties,
    ...required.length > 0 ? { required } : {},
    additionalProperties: false
  };
}
var TOOL_DECLARATIONS = [
  {
    name: TOOL_NAMES.getStoreInfo,
    displayName: "BigCommerce: get store info",
    description: "Get the store's identity and settings: store hash and numeric ID, name, domain, status, currency, weight and dimension units, time zone and plan. Start here to confirm which store this plugin is pointed at and what currency and units the other tools' numbers are in.",
    parametersSchema: object({})
  },
  {
    name: TOOL_NAMES.getCatalogSummary,
    displayName: "BigCommerce: get catalog summary",
    description: "Get catalog-wide totals in one call: product and variant counts, total inventory value, and the lowest, highest and average variant price. Use this before paging the catalog, to find out how big it is.",
    parametersSchema: object({})
  },
  {
    name: TOOL_NAMES.listProducts,
    displayName: "BigCommerce: list products",
    description: "Search and list catalog products, returning a compact row per product (ID, name, SKU, price, inventory, visibility). Use this to find a product ID or SKU instead of guessing it; use get_product for one product's full record.",
    parametersSchema: object({
      keyword: {
        type: "string",
        maxLength: 200,
        description: "Full-text search across name, SKU and description."
      },
      sku: { type: "string", maxLength: 255, description: "Exact SKU match." },
      name: { type: "string", maxLength: 255, description: "Exact product name match." },
      productIds: idArray("Return only these product IDs."),
      categoryId: { type: "integer", minimum: 1, description: "Only products in this category." },
      brandId: { type: "integer", minimum: 1, description: "Only products with this brand." },
      isVisible: {
        type: "boolean",
        description: "True for storefront-visible products only, false for hidden only."
      },
      minInventory: { type: "number", description: "Lowest inventory level to include." },
      maxInventory: {
        type: "number",
        description: "Highest inventory level to include. Use 0 to find out-of-stock products."
      },
      modifiedSince: {
        type: "string",
        description: "ISO 8601 instant; only products changed at or after it."
      },
      sort: {
        type: "string",
        enum: [...PRODUCT_SORT_FIELDS],
        description: "Field to sort by. calculated_price is the price a shopper would pay and available_to_sell is sellable stock, which are usually the two worth sorting on."
      },
      direction: {
        type: "string",
        enum: [...SORT_DIRECTIONS],
        description: "Sort direction (default asc). Use sort=date_modified with direction=desc for the most recently changed products."
      },
      ...paging
    })
  },
  {
    name: TOOL_NAMES.getProduct,
    displayName: "BigCommerce: get product",
    description: "Get one product's full record, including its description, pricing, SEO fields and inventory settings. Pass `include` to pull variants, images, custom fields, modifiers, options, videos or bulk pricing rules in the same call.",
    parametersSchema: object(
      {
        productId: { type: "integer", minimum: 1, description: "The product's ID." },
        include: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "variants",
              "images",
              "custom_fields",
              "bulk_pricing_rules",
              "modifiers",
              "options",
              "videos"
            ]
          },
          maxItems: 7,
          description: "Sub-resources to embed in the response."
        }
      },
      ["productId"]
    )
  },
  {
    name: TOOL_NAMES.listProductVariants,
    displayName: "BigCommerce: list product variants",
    description: "List one product's variants with their own SKUs, prices and inventory levels. Use this when a product is sold in sizes or colours and the question is about a specific one.",
    parametersSchema: object(
      {
        productId: { type: "integer", minimum: 1, description: "The product's ID." },
        ...paging
      },
      ["productId"]
    )
  },
  {
    name: TOOL_NAMES.listCategoryTrees,
    displayName: "BigCommerce: list category trees",
    description: "List the store's category trees with their IDs, names and the storefront channels each serves. A store has one tree per storefront, so this is how a storefront name becomes the `treeId` that list_categories filters on \u2014 and how an empty category list can be told apart from a tree ID that does not exist. `total` is how many trees matched and `complete` says whether every one of them is in `trees`; this endpoint has no paging, so treat `complete: false` as a reason to filter rather than as a full list.",
    parametersSchema: object({
      treeIds: idArray("Return only these tree IDs.", 50),
      channelIds: idArray("Return only the trees serving these storefront channel IDs.", 50)
    })
  },
  {
    name: TOOL_NAMES.listCategories,
    displayName: "BigCommerce: list categories",
    description: "List storefront categories \u2014 every level, not just the top \u2014 with their parent IDs, so the hierarchy can be reconstructed. Each row says which category tree it came from, because a multi-storefront store has one tree per storefront and the same category name can exist in several. A tree ID listed in `unresolvedTreeIds` is one whose name could not be looked up, so rows pointing at it have `treeName: null` for that reason and not because the tree is unnamed.",
    parametersSchema: object({
      treeId: {
        type: "integer",
        minimum: 1,
        description: "Restrict to one category tree. Omit to cover every tree."
      },
      keyword: {
        type: "string",
        maxLength: 200,
        description: "Search category names and descriptions."
      },
      parentId: {
        type: "integer",
        minimum: 0,
        description: "Only direct children of this category. Use 0 for the top-level categories of a tree."
      },
      ...paging
    })
  },
  {
    name: TOOL_NAMES.listBrands,
    displayName: "BigCommerce: list brands",
    description: "List catalog brands and their IDs. Use this to resolve a brand name into the `brandId` that list_products filters on.",
    parametersSchema: object({
      name: { type: "string", maxLength: 255, description: "Exact brand name match." },
      ...paging
    })
  },
  {
    name: TOOL_NAMES.listOrders,
    displayName: "BigCommerce: list orders",
    description: "Search and list orders, returning a compact row per order (ID, status, date, customer, total, payment method). Filter by status, customer, email, total or date range. Use get_order for one order's full record and list_order_products for what was in it.",
    parametersSchema: object({
      statusId: {
        type: "integer",
        minimum: 1,
        description: "BigCommerce order status ID \u2014 for example 1 Pending, 2 Shipped, 5 Cancelled, 11 Awaiting Fulfillment. Call get_order on a known order to see the status text that goes with an ID."
      },
      customerId: {
        type: "integer",
        minimum: 1,
        description: "Only this customer's orders. 0 is not accepted; guest orders have no customer."
      },
      email: { type: "string", maxLength: 255, description: "Billing email, exact match." },
      minTotal: { type: "number", description: "Lowest order total to include." },
      maxTotal: { type: "number", description: "Highest order total to include." },
      createdSince: {
        type: "string",
        description: "ISO 8601 instant; only orders created at or after it."
      },
      createdBefore: {
        type: "string",
        description: "ISO 8601 instant; only orders created at or before it."
      },
      modifiedSince: {
        type: "string",
        description: "ISO 8601 instant; only orders changed at or after it."
      },
      sort: {
        type: "string",
        enum: [...ORDER_SORT_VALUES],
        description: "Sort field and direction \u2014 this endpoint wants them as one `field:direction` value rather than as two parameters. Use date_created:desc for the newest orders."
      },
      ...paging
    })
  },
  {
    name: TOOL_NAMES.getOrder,
    displayName: "BigCommerce: get order",
    description: "Get one order's detail: status, dates, every money field, payment method and status, the shopper's order message, and the billing address. The shopper's IP address and the merchant's internal staff notes are deliberately not returned. Contains customer personal data \u2014 see the plugin README.",
    parametersSchema: object(
      { orderId: { type: "integer", minimum: 1, description: "The order's ID." } },
      ["orderId"]
    )
  },
  {
    name: TOOL_NAMES.listOrderProducts,
    displayName: "BigCommerce: list order line items",
    description: "List what was actually bought on one order: product and variant IDs, names, SKUs, quantities and line totals. This is the tool that answers 'what was in order 1042'.",
    parametersSchema: object(
      {
        orderId: { type: "integer", minimum: 1, description: "The order's ID." },
        ...paging
      },
      ["orderId"]
    )
  },
  {
    name: TOOL_NAMES.listCustomers,
    displayName: "BigCommerce: list customers",
    description: "Search and list customer accounts, returning a compact row per customer (ID, email, name, company, group, signup date). Use this to resolve an email into the `customerId` that list_orders filters on. Contains customer personal data \u2014 see the plugin README.",
    parametersSchema: object({
      email: {
        type: "string",
        maxLength: 255,
        description: "Email address, exact match. Comma-separate to match several."
      },
      name: {
        type: "string",
        maxLength: 255,
        description: "Substring match against first and last name."
      },
      company: { type: "string", maxLength: 255, description: "Company name, exact match." },
      customerIds: idArray("Return only these customer IDs."),
      customerGroupId: {
        type: "integer",
        minimum: 1,
        description: "Only customers in this customer group."
      },
      createdSince: {
        type: "string",
        description: "ISO 8601 instant; only customers created at or after it."
      },
      ...paging
    })
  },
  {
    name: TOOL_NAMES.listInventory,
    displayName: "BigCommerce: list inventory",
    description: "Read stock levels per location: available to sell, total on hand, quantity backordered, safety stock and in-stock status, filtered by SKU, product, variant or location. One row per SKU and location, so a SKU stocked in three warehouses returns three rows: `pagination.skusReturned` counts SKUs, which is what `limit`, `total` and `hasMore` are in, and `pagination.rowsReturned` counts rows. With `locationIds` set, every row whose `locationId` is non-null is for one of those locations; a row with a null `locationId` means that SKU has no inventory record in any location, so its quantities are unknown rather than zero at the locations you asked for. Use this rather than a product's single `inventoryLevel` when the store ships from more than one location.",
    parametersSchema: object({
      skus: {
        type: "array",
        items: { type: "string", maxLength: 255 },
        maxItems: 100,
        description: "Return only these SKUs."
      },
      productIds: idArray("Return only these product IDs."),
      variantIds: idArray("Return only these variant IDs."),
      locationIds: idArray("Return only these location IDs.", 50),
      ...paging
    })
  },
  {
    name: TOOL_NAMES.listLocations,
    displayName: "BigCommerce: list inventory locations",
    description: "List the store's inventory locations with their IDs, codes, labels, time zones and whether each is enabled. Use this to turn a location ID from list_inventory into a name a human recognizes.",
    parametersSchema: object({
      locationIds: idArray("Return only these location IDs.", 50),
      ...paging
    })
  }
];

// src/manifest.ts
var manifest = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "BigCommerce (read-only)",
  description: "Read-only access to a BigCommerce store: catalog products, variants, categories and brands, orders and their line items, customers, and per-location inventory. Lets an agent look up store data directly instead of asking an operator to export it.",
  author: "Tony Brobston",
  categories: ["connector"],
  capabilities: ["http.outbound", "secrets.read-ref", "agent.tools.register"],
  entrypoints: {
    worker: "./dist/worker.js"
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      [CONFIG_KEYS.storeHash]: {
        type: "string",
        title: "Store hash",
        description: "The short alphanumeric store identifier, not a URL. Find it in the API path BigCommerce shows for your store API account: in https://api.bigcommerce.com/stores/abc123xyz/v3/ the store hash is abc123xyz.",
        // Letters and digits only. This value becomes a path segment, so a
        // slash or a pasted full URL has to be refused at the form rather than
        // retargeting every request the plugin makes.
        pattern: "^[A-Za-z0-9]{1,64}$"
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
        description: "Create a store-level API account in your BigCommerce control panel under Settings \u2192 API \u2192 Store-level API accounts, grant it read-only scopes, then save its access token as a Paperclip secret and pick it here. A token pasted as raw text is refused rather than stored in this config.",
        properties: {
          type: { const: "secret_ref" },
          secretId: { type: "string", minLength: 1 }
          // `version` is deliberately unconstrained. The host's own binding
          // parser accepts "latest" or a positive integer, so a pinned version
          // arrives as a number, and over-constraining this field is what makes
          // the settings form impossible to save. The host parses and rejects a
          // bad binding after this schema runs.
        },
        required: ["type", "secretId"]
      },
      [CONFIG_KEYS.apiOrigin]: {
        type: "string",
        title: "API origin (optional)",
        description: `Leave blank for the BigCommerce API at ${DEFAULT_API_ORIGIN}. Set it only to send requests through a proxy or a mock. Must be https, with no path; plain http is accepted only for a loopback address, because the access token travels in a header on every request.`,
        // This pattern has to carry the https restriction itself, because it is
        // the only check a save runs. The host's `onValidateConfig` RPC is
        // called from exactly one place — the settings page's Test Connection
        // button — while `POST /api/plugins/:id/config` validates with Ajv
        // against this schema and nothing else. Without the restriction here,
        // `http://api.bigcommerce.com` saved green and then failed every tool
        // call at request time: a dead config rather than a refused one.
        //
        // The same constant is what `bigCommerceApiOrigin` enforces at request
        // time, so the form and the worker cannot disagree about what is
        // acceptable — see API_ORIGIN_PATTERN for the six ways they used to.
        pattern: API_ORIGIN_PATTERN
      }
    },
    required: [CONFIG_KEYS.storeHash, CONFIG_KEYS.accessToken]
  },
  tools: TOOL_DECLARATIONS.map((tool) => ({
    name: tool.name,
    displayName: tool.displayName,
    description: tool.description,
    parametersSchema: tool.parametersSchema
  }))
};
var manifest_default = manifest;
export {
  manifest_default as default
};
//# sourceMappingURL=manifest.js.map
