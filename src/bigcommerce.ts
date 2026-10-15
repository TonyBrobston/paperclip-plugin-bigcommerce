/**
 * BigCommerce REST client and the read-only tool catalog.
 *
 * Every branch in {@link executeTool} builds its own path and query from
 * validated input. No branch accepts a caller-supplied path, URL, HTTP method
 * or pass-through body, and {@link call} only ever issues a GET — so an agent
 * cannot reach an endpoint this plugin does not document, and cannot reach a
 * documented one with a verb that would change something. The tool list is the
 * whole reachable surface.
 */

import {
  CATEGORY_TREE_FAN_OUT_MAX,
  DEFAULT_API_ORIGIN,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  PAGE_MAX,
  REQUEST_TIMEOUT_MS,
  RESPONSE_LIMIT_BYTES,
  TOOL_NAMES,
} from "./constants.js";
import {
  asRecord,
  InvalidParameterError,
  optionalBoolean,
  optionalId,
  optionalIdList,
  optionalInteger,
  optionalNumber,
  optionalString,
  optionalTimestamp,
  rejectUnknownKeys,
  requiredId,
  storeHash as validateStoreHash,
} from "./validate.js";

export class BigCommerceError extends Error {}

/** Injectable for tests; defaults to the runtime's own fetch. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  storeHash: string;
  accessToken: string;
  /** Defaults to {@link DEFAULT_API_ORIGIN}. */
  apiOrigin?: string;
  fetchImpl?: FetchLike;
}

/**
 * Normalize and vet the API origin.
 *
 * Plain HTTP is accepted only for loopback. The store access token is a
 * long-lived credential that BigCommerce cannot revoke on demand, so sending
 * it unencrypted across a network is not a trade-off worth offering — but a
 * loopback mock never leaves the machine, and refusing that would make the
 * plugin untestable without the real API.
 */
export function bigCommerceApiOrigin(origin?: string): string {
  const raw = (origin ?? "").trim();
  if (raw === "") return DEFAULT_API_ORIGIN;

  const trimmed = raw.replace(/\/+$/, "");
  // `new URL("api.bigcommerce.com")` throws, but `new URL("api:8443")` parses
  // as the scheme `api:` with an opaque path, so an origin that lost its
  // scheme has to be rejected explicitly rather than left to build a nonsense
  // request later.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BigCommerceError(
      "The API origin must be a full URL such as https://api.bigcommerce.com.",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BigCommerceError("The API origin must start with https://");
  }
  if (parsed.username || parsed.password) {
    throw new BigCommerceError("The API origin must not contain credentials.");
  }
  if (parsed.search || parsed.hash) {
    throw new BigCommerceError(
      "The API origin must not contain a query string or fragment.",
    );
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    throw new BigCommerceError(
      "The API origin must not contain a path — the plugin appends /stores/<hash> itself.",
    );
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new BigCommerceError(
      "The API origin must use https. Plain http is accepted only for a loopback address.",
    );
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * Build a store API URL.
 *
 * `path` is always a literal from this module. The store hash is re-validated
 * on every call because it is a path segment: config read back from the
 * database has not necessarily passed through the settings form.
 */
export function bigCommerceUrl(
  options: ClientOptions,
  path: string,
  query?: Record<string, string>,
): URL {
  const origin = bigCommerceApiOrigin(options.apiOrigin);
  const hash = validateStoreHash(options.storeHash);
  const url = new URL(`${origin}/stores/${hash}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url;
}

/**
 * Read a response body with a ceiling, so one unfiltered catalog call cannot
 * exhaust the worker's memory.
 */
async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > RESPONSE_LIMIT_BYTES) {
        throw new BigCommerceError(
          "BigCommerce returned more data than this plugin will read in one call. Narrow the request with a filter or a smaller limit.",
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface RawResponse {
  status: number;
  body: string;
}

/**
 * Issue one GET against the store API.
 *
 * There is no `method` parameter on purpose. See the module comment.
 */
async function call(
  options: ClientOptions,
  path: string,
  query?: Record<string, string>,
): Promise<RawResponse> {
  const url = bigCommerceUrl(options, path, query);
  const init: RequestInit = {
    method: "GET",
    // A redirect off api.bigcommerce.com would carry the access token with it.
    redirect: "error",
    headers: {
      "X-Auth-Token": options.accessToken,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url.toString(), init);
  } catch (error) {
    // The store hash and token are operator configuration. Never echo the
    // attempted URL or the underlying error text back to the agent.
    if (error instanceof BigCommerceError) throw error;
    throw new BigCommerceError(
      "BigCommerce could not be reached. The store may be unavailable, or the configured API origin may be wrong.",
    );
  }

  if (!response.ok) {
    const retryAfterMs = rateLimitResetMs(response);
    await response.body?.cancel().catch(() => {});
    throw statusError(response.status, retryAfterMs);
  }

  // v2 collection endpoints answer an empty result with 204 and no body
  // rather than with `[]`, so the parse layer has to be told the difference
  // between "nothing matched" and "unparseable".
  if (response.status === 204) {
    await response.body?.cancel().catch(() => {});
    return { status: 204, body: "" };
  }

  return { status: response.status, body: await readBounded(response) };
}

/**
 * BigCommerce advertises the remaining window on a 429. Header names are
 * case-insensitive and `Headers.get` already handles that.
 */
function rateLimitResetMs(response: Response): number | undefined {
  const raw = response.headers?.get?.("X-Rate-Limit-Time-Reset-Ms");
  if (!raw) return undefined;
  const ms = Number.parseInt(raw, 10);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

function statusError(status: number, retryAfterMs?: number): BigCommerceError {
  if (status === 401) {
    return new BigCommerceError(
      "BigCommerce rejected the access token. Check the token and the store hash in the plugin settings — a token from a different store fails the same way.",
    );
  }
  if (status === 403) {
    // Distinct from 401 on purpose: the credential is good and the scope is
    // missing, which an operator fixes in a different place. This is also the
    // expected answer when a token was issued without order or customer
    // scopes deliberately — see README "Scope is the access control".
    return new BigCommerceError(
      "The BigCommerce API account does not have the OAuth scope this endpoint needs. Grant the matching read-only scope to the store API account, or treat this data as intentionally out of reach.",
    );
  }
  if (status === 404) {
    return new BigCommerceError("BigCommerce has no such record.");
  }
  if (status === 429) {
    const wait =
      retryAfterMs === undefined
        ? "Wait a few seconds and try again."
        : `Wait ${Math.ceil(retryAfterMs / 1000)}s and try again.`;
    return new BigCommerceError(`BigCommerce rate-limited this request. ${wait}`);
  }
  if (status >= 500) {
    return new BigCommerceError(
      `BigCommerce returned a server error (${status}). This is on their side; retrying later is the only fix.`,
    );
  }
  return new BigCommerceError(`BigCommerce request failed (${status}).`);
}

function parseJson(raw: RawResponse): unknown {
  if (raw.status === 204 || raw.body === "") return null;
  try {
    return JSON.parse(raw.body);
  } catch {
    throw new BigCommerceError(
      "BigCommerce returned a response this plugin could not parse as JSON.",
    );
  }
}

type Row = Record<string, unknown>;

function asRow(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
}

/** Normalized pagination, so every v3 tool reports paging the same way. */
interface Pagination {
  page: number;
  limit: number;
  returned: number;
  total: number | null;
  totalPages: number | null;
  hasMore: boolean;
}

function v3Pagination(meta: unknown, returned: number, page: number, limit: number): Pagination {
  const pagination = asRow(asRow(meta).pagination);
  const total = typeof pagination.total === "number" ? pagination.total : null;
  const totalPages =
    typeof pagination.total_pages === "number" ? pagination.total_pages : null;
  return {
    page,
    limit,
    returned,
    total,
    totalPages,
    hasMore: totalPages !== null ? page < totalPages : returned === limit,
  };
}

/** A v3 collection: `{ data, meta }`. */
async function v3List(
  options: ClientOptions,
  path: string,
  query: Record<string, string>,
  page: number,
  limit: number,
): Promise<{ rows: Row[]; pagination: Pagination }> {
  const parsed = asRow(parseJson(await call(options, path, query)));
  const data = Array.isArray(parsed.data) ? (parsed.data as unknown[]) : [];
  const rows = data.map(asRow);
  return { rows, pagination: v3Pagination(parsed.meta, rows.length, page, limit) };
}

/**
 * A v2 collection: a bare array, or 204 for "nothing matched".
 *
 * v2 sends no pagination metadata at all, so `hasMore` is inferred from a full
 * page. Reporting a guessed total instead would be worse than reporting none.
 */
async function v2List(
  options: ClientOptions,
  path: string,
  query: Record<string, string>,
  page: number,
  limit: number,
): Promise<{ rows: Row[]; pagination: Omit<Pagination, "total" | "totalPages"> }> {
  const parsed = parseJson(await call(options, path, query));
  const rows = Array.isArray(parsed) ? (parsed as unknown[]).map(asRow) : [];
  return {
    rows,
    pagination: { page, limit, returned: rows.length, hasMore: rows.length === limit },
  };
}

function paging(params: Record<string, unknown>): { page: number; limit: number } {
  return {
    page: optionalInteger(params, "page", 1, PAGE_MAX) ?? 1,
    limit: optionalInteger(params, "limit", 1, PAGE_LIMIT_MAX) ?? PAGE_LIMIT_DEFAULT,
  };
}

function pageQuery(page: number, limit: number): Record<string, string> {
  return { page: String(page), limit: String(limit) };
}

/**
 * Drop keys whose value is `undefined`, so an unset filter never reaches the
 * query string as the literal text "undefined".
 */
function withFilters(
  base: Record<string, string>,
  filters: Record<string, string | undefined>,
): Record<string, string> {
  const query = { ...base };
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) query[key] = value;
  }
  return query;
}

/**
 * The compact row shapes.
 *
 * A BigCommerce product carries its full HTML description, its SEO fields and
 * every option; an order carries three addresses and a dozen money fields. A
 * list of those is mostly payload the run will not read, and it crowds out the
 * context the run needs. Lists return the identifying and decision-making
 * fields; the full record stays behind the matching `get_*` tool.
 */
function summarizeProduct(product: Row): Row {
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    type: product.type,
    price: product.price,
    salePrice: product.sale_price ?? null,
    inventoryLevel: product.inventory_level ?? null,
    inventoryTracking: product.inventory_tracking ?? null,
    isVisible: product.is_visible,
    brandId: product.brand_id ?? null,
    categories: product.categories ?? null,
    dateModified: product.date_modified ?? null,
  };
}

const PRODUCT_LIST_FIELDS = [
  "name",
  "sku",
  "type",
  "price",
  "sale_price",
  "inventory_level",
  "inventory_tracking",
  "is_visible",
  "brand_id",
  "categories",
  "date_modified",
].join(",");

function summarizeOrder(order: Row): Row {
  return {
    id: order.id,
    status: order.status,
    statusId: order.status_id,
    dateCreated: order.date_created,
    dateModified: order.date_modified ?? null,
    customerId: order.customer_id,
    billingEmail: asRow(order.billing_address).email ?? null,
    itemsTotal: order.items_total ?? null,
    totalIncTax: order.total_inc_tax ?? null,
    currencyCode: order.currency_code ?? null,
    paymentMethod: order.payment_method ?? null,
    paymentStatus: order.payment_status ?? null,
  };
}

function summarizeCustomer(customer: Row): Row {
  return {
    id: customer.id,
    email: customer.email,
    firstName: customer.first_name ?? null,
    lastName: customer.last_name ?? null,
    company: customer.company ?? null,
    phone: customer.phone ?? null,
    customerGroupId: customer.customer_group_id ?? null,
    dateCreated: customer.date_created ?? null,
  };
}

function summarizeCategory(category: Row, treeId: unknown): Row {
  return {
    id: category.category_id ?? category.id,
    treeId,
    parentId: category.parent_id ?? null,
    name: category.name,
    isVisible: category.is_visible ?? null,
    sortOrder: category.sort_order ?? null,
  };
}

/**
 * A liveness probe that reads the least.
 *
 * `/v2/store` needs only the store-information scope and returns no catalog,
 * order or customer data, so a success proves the store hash resolves and the
 * token is accepted without reading anything about the business.
 */
export async function probe(options: ClientOptions): Promise<Row> {
  return asRow(parseJson(await call(options, "/v2/store")));
}

export async function executeTool(
  options: ClientOptions,
  toolName: string,
  parameters: unknown,
): Promise<unknown> {
  const params = asRecord(parameters);

  switch (toolName) {
    case TOOL_NAMES.getStoreInfo: {
      rejectUnknownKeys(params, []);
      const store = asRow(parseJson(await call(options, "/v2/store")));
      return {
        id: store.id,
        name: store.name,
        domain: store.domain,
        secureUrl: store.secure_url ?? null,
        status: store.status ?? null,
        currency: store.currency,
        currencySymbol: store.currency_symbol ?? null,
        weightUnits: store.weight_units ?? null,
        dimensionUnits: store.dimension_units ?? null,
        timezone: asRow(store.timezone).name ?? null,
        language: store.language ?? null,
        plan: store.plan_name ?? null,
        storeHash: store.store_hash ?? null,
        features: store.features ?? null,
      };
    }

    case TOOL_NAMES.getCatalogSummary: {
      rejectUnknownKeys(params, []);
      const summary = asRow(asRow(parseJson(await call(options, "/v3/catalog/summary"))).data);
      return {
        inventoryCount: summary.inventory_count ?? null,
        inventoryValue: summary.inventory_value ?? null,
        variantCount: summary.variant_count ?? null,
        primaryCategoryId: summary.primary_category_id ?? null,
        primaryCategoryName: summary.primary_category_name ?? null,
        lowestVariantPrice: summary.lowest_variant_price ?? null,
        highestVariantPrice: summary.highest_variant_price ?? null,
        averageVariantPrice: summary.average_variant_price ?? null,
        oldestVariantDate: summary.oldest_variant_date ?? null,
        newestVariantDate: summary.newest_variant_date ?? null,
      };
    }

    case TOOL_NAMES.listProducts: {
      rejectUnknownKeys(params, [
        "keyword",
        "sku",
        "name",
        "productIds",
        "categoryId",
        "brandId",
        "isVisible",
        "minInventory",
        "maxInventory",
        "modifiedSince",
        "sort",
        "page",
        "limit",
      ]);
      const { page, limit } = paging(params);
      const sort = optionalString(params, "sort", 32);
      if (
        sort !== undefined &&
        !["id", "name", "sku", "price", "date_modified", "inventory_level", "total_sold"].includes(
          sort,
        )
      ) {
        throw new InvalidParameterError(
          '"sort" must be one of id, name, sku, price, date_modified, inventory_level, total_sold.',
        );
      }
      const isVisible = optionalBoolean(params, "isVisible");
      const { rows, pagination } = await v3List(
        options,
        "/v3/catalog/products",
        withFilters(pageQuery(page, limit), {
          include_fields: PRODUCT_LIST_FIELDS,
          keyword: optionalString(params, "keyword", 200),
          sku: optionalString(params, "sku", 255),
          name: optionalString(params, "name", 255),
          "id:in": optionalIdList(params, "productIds", 100),
          "categories:in": formatId(optionalId(params, "categoryId")),
          brand_id: formatId(optionalId(params, "brandId")),
          is_visible: isVisible === undefined ? undefined : String(isVisible),
          "inventory_level:min": formatNumber(optionalNumber(params, "minInventory")),
          "inventory_level:max": formatNumber(optionalNumber(params, "maxInventory")),
          "date_modified:min": optionalTimestamp(params, "modifiedSince"),
          sort,
        }),
        page,
        limit,
      );
      return { pagination, products: rows.map(summarizeProduct) };
    }

    case TOOL_NAMES.getProduct: {
      rejectUnknownKeys(params, ["productId", "include"]);
      const productId = requiredId(params, "productId");
      const include = includeList(params, [
        "variants",
        "images",
        "custom_fields",
        "bulk_pricing_rules",
        "modifiers",
        "options",
        "videos",
      ]);
      const response = asRow(
        parseJson(
          await call(
            options,
            `/v3/catalog/products/${productId}`,
            include === undefined ? undefined : { include },
          ),
        ),
      );
      return asRow(response.data);
    }

    case TOOL_NAMES.listProductVariants: {
      rejectUnknownKeys(params, ["productId", "page", "limit"]);
      const productId = requiredId(params, "productId");
      const { page, limit } = paging(params);
      const { rows, pagination } = await v3List(
        options,
        `/v3/catalog/products/${productId}/variants`,
        pageQuery(page, limit),
        page,
        limit,
      );
      return { productId, pagination, variants: rows };
    }

    case TOOL_NAMES.listCategories: {
      rejectUnknownKeys(params, ["treeId", "keyword", "parentId", "page", "limit"]);
      const { page, limit } = paging(params);
      const requestedTree = optionalId(params, "treeId");
      const filters = withFilters(pageQuery(page, limit), {
        keyword: optionalString(params, "keyword", 200),
        parent_id: formatId(optionalId(params, "parentId")),
      });

      // A store has one category tree per storefront channel. Asking for
      // categories without naming a tree is the common case, so the tool
      // discovers the trees rather than making the agent chain two calls — and
      // reports which tree each category came from, because the same category
      // name can exist in several.
      // `/v3/catalog/trees` documents only `id:in` and `channel_id:in`, so it
      // is called with no query at all rather than with paging parameters it
      // never promised to accept. Trees are few; the cap is applied here.
      const trees: Row[] =
        requestedTree === undefined
          ? (await v3List(options, "/v3/catalog/trees", {}, 1, CATEGORY_TREE_FAN_OUT_MAX)).rows
          : [{ id: requestedTree, name: null }];

      if (trees.length === 0) {
        return { trees: [], note: "This store has no category trees." };
      }

      const results = [];
      for (const tree of trees.slice(0, CATEGORY_TREE_FAN_OUT_MAX)) {
        const treeId = tree.id;
        if (typeof treeId !== "number") continue;
        const { rows, pagination } = await v3List(
          options,
          `/v3/catalog/trees/${treeId}/categories`,
          filters,
          page,
          limit,
        );
        results.push({
          treeId,
          treeName: tree.name ?? null,
          pagination,
          categories: rows.map((row) => summarizeCategory(row, treeId)),
        });
      }
      return { trees: results };
    }

    case TOOL_NAMES.listBrands: {
      rejectUnknownKeys(params, ["name", "page", "limit"]);
      const { page, limit } = paging(params);
      const { rows, pagination } = await v3List(
        options,
        "/v3/catalog/brands",
        withFilters(pageQuery(page, limit), {
          name: optionalString(params, "name", 255),
        }),
        page,
        limit,
      );
      return {
        pagination,
        brands: rows.map((brand) => ({
          id: brand.id,
          name: brand.name,
          customUrl: asRow(brand.custom_url).url ?? null,
        })),
      };
    }

    case TOOL_NAMES.listOrders: {
      rejectUnknownKeys(params, [
        "statusId",
        "customerId",
        "email",
        "minTotal",
        "maxTotal",
        "createdSince",
        "createdBefore",
        "modifiedSince",
        "sort",
        "page",
        "limit",
      ]);
      const { page, limit } = paging(params);
      const sort = optionalString(params, "sort", 32);
      if (
        sort !== undefined &&
        !["id:asc", "id:desc", "date_created:asc", "date_created:desc", "date_modified:asc", "date_modified:desc"].includes(
          sort,
        )
      ) {
        throw new InvalidParameterError(
          '"sort" must be one of id:asc, id:desc, date_created:asc, date_created:desc, date_modified:asc, date_modified:desc.',
        );
      }
      const { rows, pagination } = await v2List(
        options,
        "/v2/orders",
        withFilters(pageQuery(page, limit), {
          status_id: formatId(optionalId(params, "statusId")),
          customer_id: formatId(optionalId(params, "customerId")),
          email: optionalString(params, "email", 255),
          min_total: formatNumber(optionalNumber(params, "minTotal")),
          max_total: formatNumber(optionalNumber(params, "maxTotal")),
          min_date_created: optionalTimestamp(params, "createdSince"),
          max_date_created: optionalTimestamp(params, "createdBefore"),
          min_date_modified: optionalTimestamp(params, "modifiedSince"),
          sort,
        }),
        page,
        limit,
      );
      return { pagination, orders: rows.map(summarizeOrder) };
    }

    case TOOL_NAMES.getOrder: {
      rejectUnknownKeys(params, ["orderId"]);
      const orderId = requiredId(params, "orderId");
      const order = parseJson(await call(options, `/v2/orders/${orderId}`));
      if (order === null) throw new BigCommerceError("BigCommerce has no such record.");
      return order;
    }

    case TOOL_NAMES.listOrderProducts: {
      rejectUnknownKeys(params, ["orderId", "page", "limit"]);
      const orderId = requiredId(params, "orderId");
      const { page, limit } = paging(params);
      const { rows, pagination } = await v2List(
        options,
        `/v2/orders/${orderId}/products`,
        pageQuery(page, limit),
        page,
        limit,
      );
      return {
        orderId,
        pagination,
        lineItems: rows.map((item) => ({
          id: item.id,
          productId: item.product_id,
          variantId: item.variant_id ?? null,
          name: item.name,
          sku: item.sku ?? null,
          quantity: item.quantity,
          basePrice: item.base_price ?? null,
          priceIncTax: item.price_inc_tax ?? null,
          totalIncTax: item.total_inc_tax ?? null,
        })),
      };
    }

    case TOOL_NAMES.listCustomers: {
      rejectUnknownKeys(params, [
        "email",
        "name",
        "company",
        "customerIds",
        "customerGroupId",
        "createdSince",
        "page",
        "limit",
      ]);
      const { page, limit } = paging(params);
      const { rows, pagination } = await v3List(
        options,
        "/v3/customers",
        withFilters(pageQuery(page, limit), {
          "email:in": optionalString(params, "email", 255),
          "name:like": optionalString(params, "name", 255),
          "company:in": optionalString(params, "company", 255),
          "id:in": optionalIdList(params, "customerIds", 100),
          "customer_group_id:in": formatId(optionalId(params, "customerGroupId")),
          "date_created:min": optionalTimestamp(params, "createdSince"),
        }),
        page,
        limit,
      );
      return { pagination, customers: rows.map(summarizeCustomer) };
    }

    case TOOL_NAMES.listInventory: {
      rejectUnknownKeys(params, ["skus", "productIds", "variantIds", "locationIds", "page", "limit"]);
      const { page, limit } = paging(params);
      const { rows, pagination } = await v3List(
        options,
        "/v3/inventory/items",
        withFilters(pageQuery(page, limit), {
          "sku:in": skuList(params, "skus"),
          "product_id:in": optionalIdList(params, "productIds", 100),
          "variant_id:in": optionalIdList(params, "variantIds", 100),
          "location_id:in": optionalIdList(params, "locationIds", 50),
        }),
        page,
        limit,
      );
      return {
        pagination,
        items: rows.map((item) => ({
          sku: item.sku ?? null,
          productId: item.product_id ?? null,
          variantId: item.variant_id ?? null,
          locationId: item.location_id ?? null,
          availableToSell: item.available_to_sell ?? null,
          totalInventoryOnhand: item.total_inventory_onhand ?? null,
          safetyStock: item.settings === undefined ? null : asRow(item.settings).safety_stock ?? null,
          isInStockAlternate: item.is_in_stock_alternate ?? null,
        })),
      };
    }

    case TOOL_NAMES.listLocations: {
      rejectUnknownKeys(params, ["locationIds", "page", "limit"]);
      const { page, limit } = paging(params);
      const { rows, pagination } = await v3List(
        options,
        "/v3/inventory/locations",
        withFilters(pageQuery(page, limit), {
          "id:in": optionalIdList(params, "locationIds", 50),
        }),
        page,
        limit,
      );
      return {
        pagination,
        locations: rows.map((location) => ({
          id: location.id,
          code: location.code ?? null,
          label: location.label ?? null,
          typeId: location.type_id ?? null,
          enabled: location.enabled ?? null,
          timeZone: location.time_zone ?? null,
          city: asRow(location.address).city ?? null,
          countryCode: asRow(location.address).country_code ?? null,
        })),
      };
    }

    default:
      throw new BigCommerceError(`Unknown BigCommerce tool: ${toolName}`);
  }
}

function formatId(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function formatNumber(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

/**
 * SKUs are operator-chosen strings, so unlike IDs they cannot be validated by
 * shape. A comma would split one SKU into two filter values and silently widen
 * the query, so a SKU containing one is refused rather than reinterpreted.
 */
function skuList(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new InvalidParameterError(`"${key}" must be an array of SKUs.`);
  if (value.length === 0) return undefined;
  if (value.length > 100) {
    throw new InvalidParameterError(`"${key}" must contain at most 100 SKUs.`);
  }
  return value
    .map((entry) => {
      if (typeof entry !== "string" || entry.trim() === "") {
        throw new InvalidParameterError(`"${key}" must contain non-empty SKU strings.`);
      }
      if (entry.length > 255) {
        throw new InvalidParameterError(`"${key}" entries must be at most 255 characters.`);
      }
      if (entry.includes(",")) {
        throw new InvalidParameterError(
          `"${key}" entries cannot contain a comma — BigCommerce separates this filter's values with one.`,
        );
      }
      return entry;
    })
    .join(",");
}

/**
 * Validate an `include` list against the sub-resources the endpoint knows,
 * rather than forwarding whatever arrived. An unknown value makes BigCommerce
 * reject the whole request, which reads to the agent as a broken tool.
 */
function includeList(
  params: Record<string, unknown>,
  allowed: readonly string[],
): string | undefined {
  const value = params.include;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new InvalidParameterError('"include" must be an array of strings.');
  }
  if (value.length === 0) return undefined;
  const unknown = value.filter((entry) => typeof entry !== "string" || !allowed.includes(entry));
  if (unknown.length > 0) {
    throw new InvalidParameterError(
      `"include" accepts only: ${[...allowed].join(", ")}.`,
    );
  }
  return (value as string[]).join(",");
}

export { InvalidParameterError };
