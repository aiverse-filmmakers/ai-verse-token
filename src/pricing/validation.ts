import { URL } from "node:url";
import {
  PRICE_CONTEXT_BASES,
  PRICE_PROTOCOL_LIMITS,
  PRICE_PROTOCOL_VERSION,
  PRICE_RATE_FIELDS,
  PRICE_SOURCE_AUTHORITIES,
  PRICE_VERIFICATION_STATUSES,
  PRICE_WEEKDAYS
} from "./constants.js";
import type {
  MonetaryRate,
  PriceCacheTtlCondition,
  PriceConditions,
  PriceContextCondition,
  PriceEffectiveInterval,
  PriceIdentity,
  PriceRates,
  PriceSnapshot,
  PriceSourceProvenance,
  PriceVerification,
  UtcTimeWindow
} from "./types.js";

const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const UTC_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const DECIMAL_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export class PriceProtocolValidationError extends Error {
  readonly code = "PRICE_PROTOCOL_INVALID" as const;
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "PriceProtocolValidationError";
    this.path = path;
  }
}

function fail(path: string, message: string): never {
  throw new PriceProtocolValidationError(path, message);
}

function plainObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, "must be a plain object");
  }
  return value as Record<string, unknown>;
}

function keysOnly(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(`${path}.${key}`, "unknown field");
  }
}

function required(value: Record<string, unknown>, key: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${path}.${key}`, "is required");
  return value[key];
}

function boundedString(value: unknown, path: string, max: number, min = 1): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (value.length < min || value.length > max) fail(path, `length must be ${min}..${max}`);
  if (value.includes("\u0000")) fail(path, "must not contain NUL");
  return value;
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  max: number
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
  return boundedString(obj[key], `${path}.${key}`, max);
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(path, `must be one of: ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function isoDateTime(value: unknown, path: string): string {
  const result = boundedString(value, path, 64);
  if (!ISO_DATETIME_RE.test(result) || Number.isNaN(Date.parse(result))) {
    fail(path, "must be an ISO 8601 date-time with timezone");
  }
  return result;
}

function optionalDateTime(
  obj: Record<string, unknown>,
  key: string,
  path: string
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
  return isoDateTime(obj[key], `${path}.${key}`);
}

function nonNegativeSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(path, "must be a non-negative safe integer");
  }
  return value as number;
}

function optionalNonNegativeSafeInteger(
  obj: Record<string, unknown>,
  key: string,
  path: string
): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
  return nonNegativeSafeInteger(obj[key], `${path}.${key}`);
}

function positiveSafeInteger(value: unknown, path: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    fail(path, `must be a safe integer in 1..${max}`);
  }
  return value as number;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

function validateDecimalMoney(value: unknown, path: string): string {
  const result = boundedString(value, path, 80);
  if (!DECIMAL_RE.test(result)) {
    fail(path, "must be a non-negative base-10 decimal string without exponent notation");
  }
  const [integerPart = "", fractionPart = ""] = result.split(".");
  if (integerPart.length > PRICE_PROTOCOL_LIMITS.maxDecimalIntegerDigits) {
    fail(path, `integer part exceeds ${PRICE_PROTOCOL_LIMITS.maxDecimalIntegerDigits} digits`);
  }
  if (fractionPart.length > PRICE_PROTOCOL_LIMITS.maxDecimalFractionDigits) {
    fail(path, `fractional part exceeds ${PRICE_PROTOCOL_LIMITS.maxDecimalFractionDigits} digits`);
  }
  return result;
}

function validateRate(value: unknown, path: string): MonetaryRate {
  const obj = plainObject(value, path);
  keysOnly(obj, ["amount", "per"], path);
  return {
    amount: validateDecimalMoney(required(obj, "amount", path), `${path}.amount`),
    per: positiveSafeInteger(required(obj, "per", path), `${path}.per`, PRICE_PROTOCOL_LIMITS.maxRateScale)
  };
}

function validateIdentity(value: unknown, path: string): PriceIdentity {
  const obj = plainObject(value, path);
  keysOnly(obj, [
    "billing_platform",
    "resolved_model",
    "inference_provider",
    "provider_model_id",
    "service_tier",
    "region",
    "billing_mode"
  ], path);

  return compact({
    billing_platform: boundedString(
      required(obj, "billing_platform", path),
      `${path}.billing_platform`,
      PRICE_PROTOCOL_LIMITS.maxShortTextLength
    ),
    resolved_model: boundedString(
      required(obj, "resolved_model", path),
      `${path}.resolved_model`,
      PRICE_PROTOCOL_LIMITS.maxModelLength
    ),
    inference_provider: optionalString(obj, "inference_provider", path, PRICE_PROTOCOL_LIMITS.maxShortTextLength),
    provider_model_id: optionalString(obj, "provider_model_id", path, PRICE_PROTOCOL_LIMITS.maxModelLength),
    service_tier: optionalString(obj, "service_tier", path, PRICE_PROTOCOL_LIMITS.maxShortTextLength),
    region: optionalString(obj, "region", path, PRICE_PROTOCOL_LIMITS.maxShortTextLength),
    billing_mode: optionalString(obj, "billing_mode", path, PRICE_PROTOCOL_LIMITS.maxShortTextLength)
  }) as PriceIdentity;
}

function timeToSeconds(value: string): number {
  const [hours = "0", minutes = "0", seconds = "0"] = value.split(":");
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

function validateUtcTimeWindow(value: unknown, path: string): UtcTimeWindow {
  const obj = plainObject(value, path);
  keysOnly(obj, ["start", "end"], path);
  const start = boundedString(required(obj, "start", path), `${path}.start`, 8, 5);
  const end = boundedString(required(obj, "end", path), `${path}.end`, 8, 5);
  if (!UTC_TIME_RE.test(start)) fail(`${path}.start`, "must be UTC HH:MM or HH:MM:SS");
  if (!UTC_TIME_RE.test(end)) fail(`${path}.end`, "must be UTC HH:MM or HH:MM:SS");
  if (timeToSeconds(end) <= timeToSeconds(start)) {
    fail(`${path}.end`, "must be later than start; split cross-midnight windows into separate rules");
  }
  return { start, end };
}

function validateEffective(value: unknown, path: string): PriceEffectiveInterval {
  const obj = plainObject(value, path);
  keysOnly(obj, ["starts_at", "ends_at", "weekdays_utc", "utc_time_windows"], path);
  const startsAt = isoDateTime(required(obj, "starts_at", path), `${path}.starts_at`);
  const endsAt = optionalDateTime(obj, "ends_at", path);
  if (endsAt !== undefined && Date.parse(endsAt) <= Date.parse(startsAt)) {
    fail(`${path}.ends_at`, "must be later than starts_at; end is exclusive");
  }

  let weekdays: readonly (typeof PRICE_WEEKDAYS)[number][] | undefined;
  if (Object.prototype.hasOwnProperty.call(obj, "weekdays_utc")) {
    if (!Array.isArray(obj.weekdays_utc) || obj.weekdays_utc.length === 0 || obj.weekdays_utc.length > 7) {
      fail(`${path}.weekdays_utc`, "must be a non-empty array with at most seven weekdays");
    }
    const parsed = obj.weekdays_utc.map((day, index) =>
      oneOf(day, PRICE_WEEKDAYS, `${path}.weekdays_utc[${index}]`)
    );
    if (new Set(parsed).size !== parsed.length) fail(`${path}.weekdays_utc`, "must not contain duplicates");
    weekdays = parsed;
  }

  let windows: readonly UtcTimeWindow[] | undefined;
  if (Object.prototype.hasOwnProperty.call(obj, "utc_time_windows")) {
    if (!Array.isArray(obj.utc_time_windows) || obj.utc_time_windows.length === 0 || obj.utc_time_windows.length > PRICE_PROTOCOL_LIMITS.maxUtcWindows) {
      fail(`${path}.utc_time_windows`, `must be a non-empty array with at most ${PRICE_PROTOCOL_LIMITS.maxUtcWindows} windows`);
    }
    const parsed = obj.utc_time_windows.map((item, index) =>
      validateUtcTimeWindow(item, `${path}.utc_time_windows[${index}]`)
    );
    const keys = parsed.map((window) => `${window.start}/${window.end}`);
    if (new Set(keys).size !== keys.length) fail(`${path}.utc_time_windows`, "must not contain duplicate windows");
    windows = parsed;
  }

  return compact({
    starts_at: startsAt,
    ends_at: endsAt,
    weekdays_utc: weekdays,
    utc_time_windows: windows
  }) as PriceEffectiveInterval;
}

function validateBoundPair(
  min: number | undefined,
  max: number | undefined,
  minPath: string,
  maxPath: string
): void {
  if (min !== undefined && max !== undefined && max <= min) {
    fail(maxPath, `must be greater than ${minPath.split(".").at(-1)}`);
  }
}

function validateContext(value: unknown, path: string): PriceContextCondition {
  const obj = plainObject(value, path);
  keysOnly(obj, ["basis", "min_inclusive", "max_exclusive"], path);
  const basis = oneOf(required(obj, "basis", path), PRICE_CONTEXT_BASES, `${path}.basis`);
  const min = optionalNonNegativeSafeInteger(obj, "min_inclusive", path);
  const max = optionalNonNegativeSafeInteger(obj, "max_exclusive", path);
  if (min === undefined && max === undefined) fail(path, "must define min_inclusive and/or max_exclusive");
  validateBoundPair(min, max, `${path}.min_inclusive`, `${path}.max_exclusive`);
  return compact({ basis, min_inclusive: min, max_exclusive: max }) as PriceContextCondition;
}

function validateCacheTtl(value: unknown, path: string): PriceCacheTtlCondition {
  const obj = plainObject(value, path);
  keysOnly(obj, ["min_seconds_inclusive", "max_seconds_exclusive"], path);
  const min = optionalNonNegativeSafeInteger(obj, "min_seconds_inclusive", path);
  const max = optionalNonNegativeSafeInteger(obj, "max_seconds_exclusive", path);
  if (min === undefined && max === undefined) fail(path, "must define min_seconds_inclusive and/or max_seconds_exclusive");
  validateBoundPair(min, max, `${path}.min_seconds_inclusive`, `${path}.max_seconds_exclusive`);
  return compact({ min_seconds_inclusive: min, max_seconds_exclusive: max }) as PriceCacheTtlCondition;
}

function validateConditions(value: unknown, path: string): PriceConditions {
  const obj = plainObject(value, path);
  keysOnly(obj, ["context", "cache_ttl"], path);
  const context = Object.prototype.hasOwnProperty.call(obj, "context")
    ? validateContext(obj.context, `${path}.context`)
    : undefined;
  const cacheTtl = Object.prototype.hasOwnProperty.call(obj, "cache_ttl")
    ? validateCacheTtl(obj.cache_ttl, `${path}.cache_ttl`)
    : undefined;
  if (context === undefined && cacheTtl === undefined) fail(path, "must contain at least one condition");
  return compact({ context, cache_ttl: cacheTtl }) as PriceConditions;
}

function validateRates(value: unknown, path: string): PriceRates {
  const obj = plainObject(value, path);
  keysOnly(obj, PRICE_RATE_FIELDS, path);
  const rates: Record<string, MonetaryRate> = {};
  for (const field of PRICE_RATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(obj, field)) {
      rates[field] = validateRate(obj[field], `${path}.${field}`);
    }
  }
  if (Object.keys(rates).length === 0) fail(path, "must contain at least one rate");
  return rates as PriceRates;
}

function validateHttpUrl(value: unknown, path: string): string {
  const raw = boundedString(value, path, PRICE_PROTOCOL_LIMITS.maxUrlLength);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail(path, "must be an absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    fail(path, "must use http or https");
  }
  if (parsed.username || parsed.password) fail(path, "must not contain embedded credentials");
  return parsed.toString();
}

function validateSource(value: unknown, path: string): PriceSourceProvenance {
  const obj = plainObject(value, path);
  keysOnly(obj, [
    "authority",
    "source_id",
    "source_url",
    "retrieved_at",
    "published_at",
    "etag",
    "content_digest_sha256"
  ], path);

  const sourceUrl = Object.prototype.hasOwnProperty.call(obj, "source_url")
    ? validateHttpUrl(obj.source_url, `${path}.source_url`)
    : undefined;
  const hash = optionalString(obj, "content_digest_sha256", path, 64);
  if (hash !== undefined && !SHA256_RE.test(hash)) {
    fail(`${path}.content_digest_sha256`, "must be 64 lowercase hexadecimal SHA-256 characters");
  }

  return compact({
    authority: oneOf(required(obj, "authority", path), PRICE_SOURCE_AUTHORITIES, `${path}.authority`),
    source_id: boundedString(required(obj, "source_id", path), `${path}.source_id`, PRICE_PROTOCOL_LIMITS.maxShortTextLength),
    source_url: sourceUrl,
    retrieved_at: isoDateTime(required(obj, "retrieved_at", path), `${path}.retrieved_at`),
    published_at: optionalDateTime(obj, "published_at", path),
    etag: optionalString(obj, "etag", path, PRICE_PROTOCOL_LIMITS.maxEtagLength),
    content_digest_sha256: hash
  }) as PriceSourceProvenance;
}

function validateVerification(
  value: unknown,
  path: string,
  retrievedAt: string
): PriceVerification {
  const obj = plainObject(value, path);
  keysOnly(obj, ["status", "verified_at"], path);
  const status = oneOf(required(obj, "status", path), PRICE_VERIFICATION_STATUSES, `${path}.status`);
  const verifiedAt = optionalDateTime(obj, "verified_at", path);

  if ((status === "verified" || status === "cross_checked") && verifiedAt === undefined) {
    fail(`${path}.verified_at`, `is required when status is ${status}`);
  }
  if (verifiedAt !== undefined && Date.parse(verifiedAt) < Date.parse(retrievedAt)) {
    fail(`${path}.verified_at`, "must not be earlier than source.retrieved_at");
  }

  return compact({ status, verified_at: verifiedAt }) as PriceVerification;
}

export function validatePriceSnapshot(value: unknown): PriceSnapshot {
  const path = "$";
  const obj = plainObject(value, path);
  keysOnly(obj, [
    "schema_version",
    "price_snapshot_id",
    "identity",
    "currency",
    "effective",
    "conditions",
    "rates",
    "source",
    "verification",
    "supersedes_price_snapshot_id"
  ], path);

  const schemaVersion = required(obj, "schema_version", path);
  if (schemaVersion !== PRICE_PROTOCOL_VERSION) {
    fail("$.schema_version", `must equal ${PRICE_PROTOCOL_VERSION}`);
  }

  const currency = boundedString(required(obj, "currency", path), "$.currency", 3, 3);
  if (!CURRENCY_RE.test(currency)) {
    fail("$.currency", "must be an uppercase ISO-like 3-letter currency code");
  }

  const source = validateSource(required(obj, "source", path), "$.source");

  return compact({
    schema_version: PRICE_PROTOCOL_VERSION,
    price_snapshot_id: boundedString(
      required(obj, "price_snapshot_id", path),
      "$.price_snapshot_id",
      PRICE_PROTOCOL_LIMITS.maxIdLength
    ),
    identity: validateIdentity(required(obj, "identity", path), "$.identity"),
    currency,
    effective: validateEffective(required(obj, "effective", path), "$.effective"),
    conditions: Object.prototype.hasOwnProperty.call(obj, "conditions")
      ? validateConditions(obj.conditions, "$.conditions")
      : undefined,
    rates: validateRates(required(obj, "rates", path), "$.rates"),
    source,
    verification: validateVerification(required(obj, "verification", path), "$.verification", source.retrieved_at),
    supersedes_price_snapshot_id: optionalString(
      obj,
      "supersedes_price_snapshot_id",
      path,
      PRICE_PROTOCOL_LIMITS.maxIdLength
    )
  }) as PriceSnapshot;
}
