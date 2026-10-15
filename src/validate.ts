/**
 * Small dependency-free parameter validation.
 *
 * A schema library would be the obvious choice, but every runtime dependency
 * has to be inlined into the worker bundle, and these shapes are simple enough
 * that hand-rolled checks stay readable. The important property is the same as
 * a schema library's: unknown keys are rejected rather than ignored, so a
 * caller cannot smuggle an extra field into a request.
 */

export class InvalidParameterError extends Error {}

function fail(message: string): never {
  throw new InvalidParameterError(message);
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    fail("Parameters must be an object.");
  }
  return value as Record<string, unknown>;
}

/**
 * Reject keys the tool does not declare.
 *
 * Silently dropping them would let a caller believe an unsupported filter had
 * been applied — a wrong answer that looks like a right one.
 */
export function rejectUnknownKeys(
  params: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(params).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    fail(
      `Unsupported parameter${unknown.length > 1 ? "s" : ""}: ${unknown.sort().join(", ")}. Supported: ${[...allowed].sort().join(", ")}.`,
    );
  }
}

export function optionalString(
  params: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail(`"${key}" must be a string.`);
  if (value.length > maxLength) {
    fail(`"${key}" must be at most ${maxLength} characters.`);
  }
  return value;
}

export function optionalBoolean(
  params: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") fail(`"${key}" must be true or false.`);
  return value;
}

export function optionalInteger(
  params: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`"${key}" must be an integer.`);
  }
  if (value < min || value > max) {
    fail(`"${key}" must be between ${min} and ${max}.`);
  }
  return value;
}

export function optionalNumber(
  params: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`"${key}" must be a number.`);
  }
  return value;
}

/**
 * A BigCommerce resource ID. These go into the request *path*, so an
 * unvalidated value would build a request against a different endpoint.
 * `Number.MAX_SAFE_INTEGER` is the ceiling because the IDs are JSON numbers.
 */
export function requiredId(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  if (value === undefined || value === null) fail(`"${key}" is required.`);
  const id = optionalInteger(params, key, 1, Number.MAX_SAFE_INTEGER);
  if (id === undefined) fail(`"${key}" is required.`);
  return id;
}

export function optionalId(
  params: Record<string, unknown>,
  key: string,
): number | undefined {
  return optionalInteger(params, key, 1, Number.MAX_SAFE_INTEGER);
}

/**
 * An ISO 8601 instant. BigCommerce accepts RFC-2822 and ISO-8601 in its v2
 * date filters; this plugin normalizes to ISO-8601 so one format reaches the
 * API regardless of what the agent typed.
 */
export function optionalTimestamp(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = optionalString(params, key, 64);
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    fail(`"${key}" must be an ISO 8601 date-time, such as 2026-10-01T00:00:00Z.`);
  }
  return new Date(parsed).toISOString();
}

/**
 * A comma-separated ID list for BigCommerce's `:in` filters.
 *
 * Accepts an array of integers from the agent and emits the wire format, so a
 * caller never has to assemble the query string itself — and cannot inject
 * anything into it.
 */
export function optionalIdList(
  params: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) fail(`"${key}" must be an array of integers.`);
  if (value.length === 0) return undefined;
  if (value.length > maxLength) {
    fail(`"${key}" must contain at most ${maxLength} IDs.`);
  }
  return value
    .map((entry) => {
      if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 1) {
        fail(`"${key}" must contain positive integers.`);
      }
      return String(entry);
    })
    .join(",");
}

/**
 * A store hash: the opaque identifier in the store's API path.
 *
 * It is taken from config rather than from a tool argument, but it is still
 * validated on every use. Stored config can be older than the settings field
 * that accepted it, or hand-edited in the database, and this value is a path
 * segment — a slash in it would retarget every request the plugin makes.
 */
export function storeHash(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9]{1,64}$/.test(trimmed)) {
    throw new InvalidParameterError(
      "The store hash must be the short alphanumeric identifier from your store's API path — letters and digits only, no slashes and no full URL.",
    );
  }
  return trimmed;
}
