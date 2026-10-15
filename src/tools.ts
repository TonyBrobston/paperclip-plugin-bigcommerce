/**
 * The tool catalog, declared once.
 *
 * The manifest advertises these to the host and the worker registers handlers
 * for them. Both import this list, so a tool cannot be advertised without a
 * handler or registered without being declared.
 */

import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX, PAGE_MAX, TOOL_NAMES } from "./constants.js";

export interface ToolDeclaration {
  name: string;
  displayName: string;
  description: string;
  parametersSchema: Record<string, unknown>;
}

const pageProperty = {
  type: "integer",
  minimum: 1,
  maximum: PAGE_MAX,
  description: "1-based page number (default 1).",
} as const;

const limitProperty = {
  type: "integer",
  minimum: 1,
  maximum: PAGE_LIMIT_MAX,
  description: `Rows per page, up to ${PAGE_LIMIT_MAX} (default ${PAGE_LIMIT_DEFAULT}).`,
} as const;

const paging = { page: pageProperty, limit: limitProperty };

function idArray(description: string, maxItems = 100) {
  return {
    type: "array",
    items: { type: "integer", minimum: 1 },
    maxItems,
    description,
  } as const;
}

function object(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

export const TOOL_DECLARATIONS: readonly ToolDeclaration[] = [
  {
    name: TOOL_NAMES.getStoreInfo,
    displayName: "BigCommerce: get store info",
    description:
      "Get the store's identity and settings: name, domain, status, currency, weight and dimension units, time zone and plan. Start here to confirm which store this plugin is pointed at and what currency and units the other tools' numbers are in.",
    parametersSchema: object({}),
  },
  {
    name: TOOL_NAMES.getCatalogSummary,
    displayName: "BigCommerce: get catalog summary",
    description:
      "Get catalog-wide totals in one call: product and variant counts, total inventory value, and the lowest, highest and average variant price. Use this before paging the catalog, to find out how big it is.",
    parametersSchema: object({}),
  },
  {
    name: TOOL_NAMES.listProducts,
    displayName: "BigCommerce: list products",
    description:
      "Search and list catalog products, returning a compact row per product (ID, name, SKU, price, inventory, visibility). Use this to find a product ID or SKU instead of guessing it; use get_product for one product's full record.",
    parametersSchema: object({
      keyword: {
        type: "string",
        maxLength: 200,
        description: "Full-text search across name, SKU and description.",
      },
      sku: { type: "string", maxLength: 255, description: "Exact SKU match." },
      name: { type: "string", maxLength: 255, description: "Exact product name match." },
      productIds: idArray("Return only these product IDs."),
      categoryId: { type: "integer", minimum: 1, description: "Only products in this category." },
      brandId: { type: "integer", minimum: 1, description: "Only products with this brand." },
      isVisible: {
        type: "boolean",
        description: "True for storefront-visible products only, false for hidden only.",
      },
      minInventory: { type: "number", description: "Lowest inventory level to include." },
      maxInventory: {
        type: "number",
        description: "Highest inventory level to include. Use 0 to find out-of-stock products.",
      },
      modifiedSince: {
        type: "string",
        description: "ISO 8601 instant; only products changed at or after it.",
      },
      sort: {
        type: "string",
        enum: ["id", "name", "sku", "price", "date_modified", "inventory_level", "total_sold"],
        description: "Field to sort by.",
      },
      ...paging,
    }),
  },
  {
    name: TOOL_NAMES.getProduct,
    displayName: "BigCommerce: get product",
    description:
      "Get one product's full record, including its description, pricing, SEO fields and inventory settings. Pass `include` to pull variants, images, custom fields, modifiers, options, videos or bulk pricing rules in the same call.",
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
              "videos",
            ],
          },
          maxItems: 7,
          description: "Sub-resources to embed in the response.",
        },
      },
      ["productId"],
    ),
  },
  {
    name: TOOL_NAMES.listProductVariants,
    displayName: "BigCommerce: list product variants",
    description:
      "List one product's variants with their own SKUs, prices and inventory levels. Use this when a product is sold in sizes or colours and the question is about a specific one.",
    parametersSchema: object(
      {
        productId: { type: "integer", minimum: 1, description: "The product's ID." },
        ...paging,
      },
      ["productId"],
    ),
  },
  {
    name: TOOL_NAMES.listCategories,
    displayName: "BigCommerce: list categories",
    description:
      "List storefront categories with their parent IDs, so the category hierarchy can be reconstructed. With no tree ID it lists categories for every category tree in the store and tags each with the tree it came from.",
    parametersSchema: object({
      treeId: {
        type: "integer",
        minimum: 1,
        description: "Restrict to one category tree. Omit to cover every tree.",
      },
      keyword: {
        type: "string",
        maxLength: 200,
        description: "Search category names and descriptions.",
      },
      parentId: {
        type: "integer",
        minimum: 1,
        description: "Only direct children of this category.",
      },
      ...paging,
    }),
  },
  {
    name: TOOL_NAMES.listBrands,
    displayName: "BigCommerce: list brands",
    description:
      "List catalog brands and their IDs. Use this to resolve a brand name into the `brandId` that list_products filters on.",
    parametersSchema: object({
      name: { type: "string", maxLength: 255, description: "Exact brand name match." },
      ...paging,
    }),
  },
  {
    name: TOOL_NAMES.listOrders,
    displayName: "BigCommerce: list orders",
    description:
      "Search and list orders, returning a compact row per order (ID, status, date, customer, total, payment method). Filter by status, customer, email, total or date range. Use get_order for one order's full record and list_order_products for what was in it.",
    parametersSchema: object({
      statusId: {
        type: "integer",
        minimum: 1,
        description:
          "BigCommerce order status ID — for example 1 Pending, 2 Shipped, 5 Cancelled, 11 Awaiting Fulfillment. Call get_order on a known order to see the status text that goes with an ID.",
      },
      customerId: {
        type: "integer",
        minimum: 1,
        description: "Only this customer's orders. 0 is not accepted; guest orders have no customer.",
      },
      email: { type: "string", maxLength: 255, description: "Billing email, exact match." },
      minTotal: { type: "number", description: "Lowest order total to include." },
      maxTotal: { type: "number", description: "Highest order total to include." },
      createdSince: {
        type: "string",
        description: "ISO 8601 instant; only orders created at or after it.",
      },
      createdBefore: {
        type: "string",
        description: "ISO 8601 instant; only orders created at or before it.",
      },
      modifiedSince: {
        type: "string",
        description: "ISO 8601 instant; only orders changed at or after it.",
      },
      sort: {
        type: "string",
        enum: [
          "id:asc",
          "id:desc",
          "date_created:asc",
          "date_created:desc",
          "date_modified:asc",
          "date_modified:desc",
        ],
        description: "Sort field and direction. Use date_created:desc for the newest orders.",
      },
      ...paging,
    }),
  },
  {
    name: TOOL_NAMES.getOrder,
    displayName: "BigCommerce: get order",
    description:
      "Get one order's full record: status and status history fields, every money field, payment and shipping details, and the billing address. Contains customer personal data — see the plugin README.",
    parametersSchema: object(
      { orderId: { type: "integer", minimum: 1, description: "The order's ID." } },
      ["orderId"],
    ),
  },
  {
    name: TOOL_NAMES.listOrderProducts,
    displayName: "BigCommerce: list order line items",
    description:
      "List what was actually bought on one order: product and variant IDs, names, SKUs, quantities and line totals. This is the tool that answers 'what was in order 1042'.",
    parametersSchema: object(
      {
        orderId: { type: "integer", minimum: 1, description: "The order's ID." },
        ...paging,
      },
      ["orderId"],
    ),
  },
  {
    name: TOOL_NAMES.listCustomers,
    displayName: "BigCommerce: list customers",
    description:
      "Search and list customer accounts, returning a compact row per customer (ID, email, name, company, group). Use this to resolve an email into the `customerId` that list_orders filters on. Contains customer personal data — see the plugin README.",
    parametersSchema: object({
      email: {
        type: "string",
        maxLength: 255,
        description: "Email address, exact match. Comma-separate to match several.",
      },
      name: {
        type: "string",
        maxLength: 255,
        description: "Substring match against first and last name.",
      },
      company: { type: "string", maxLength: 255, description: "Company name, exact match." },
      customerIds: idArray("Return only these customer IDs."),
      customerGroupId: {
        type: "integer",
        minimum: 1,
        description: "Only customers in this customer group.",
      },
      createdSince: {
        type: "string",
        description: "ISO 8601 instant; only customers created at or after it.",
      },
      ...paging,
    }),
  },
  {
    name: TOOL_NAMES.listInventory,
    displayName: "BigCommerce: list inventory",
    description:
      "Read stock levels per location: available to sell, total on hand and safety stock, by SKU, product, variant or location. Use this rather than a product's single `inventoryLevel` when the store ships from more than one location.",
    parametersSchema: object({
      skus: {
        type: "array",
        items: { type: "string", maxLength: 255 },
        maxItems: 100,
        description: "Return only these SKUs.",
      },
      productIds: idArray("Return only these product IDs."),
      variantIds: idArray("Return only these variant IDs."),
      locationIds: idArray("Return only these location IDs.", 50),
      ...paging,
    }),
  },
  {
    name: TOOL_NAMES.listLocations,
    displayName: "BigCommerce: list inventory locations",
    description:
      "List the store's inventory locations with their IDs, codes, labels, time zones and whether each is enabled. Use this to turn a location ID from list_inventory into a name a human recognizes.",
    parametersSchema: object({
      locationIds: idArray("Return only these location IDs.", 50),
      ...paging,
    }),
  },
];
