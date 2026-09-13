import {
  ACTUAL_CHARGE_SOURCES,
  COST_STATUSES,
  TIMING_QUALITIES,
  TOKEN_PROTOCOL_LIMITS,
  TOKEN_PROTOCOL_VERSION,
  USAGE_QUALITIES
} from "./constants.js";
import type {
  ActualCharge,
  CostStatus,
  TimingQuality,
  UsageCounts,
  UsageEvent,
  UsageEventSource,
  UsageIdentity,
  UsageProvenance,
  UsageQuality,
  UsageScope,
  UsageTiming
} from "./types.js";

const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const DECIMAL_MONEY_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export class TokenProtocolValidationError extends Error {
  readonly code = "TOKEN_PROTOCOL_INVALID" as const;
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "TokenProtocolValidationError";
    this.path = path;
  }
}

function fail(path: string, message: string): never {
  throw new TokenProtocolValidationError(path, message);
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

function nullableString(value: unknown, path: string, max: number): string | null {
  if (value === null) return null;
  return boundedString(value, path, max);
}

function optionalNullableString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  max: number
): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
  return nullableString(obj[key], `${path}.${key}`, max);
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

function optionalNullableDateTime(
  obj: Record<string, unknown>,
  key: string,
  path: string
): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
  const value = obj[key];
  if (value === null) return null;
  return isoDateTime(value, `${path}.${key}`);
}

function nonNegativeSafeIntegerOrNull(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > TOKEN_PROTOCOL_LIMITS.maxTokenCount) {
    fail(path, `must be a safe integer in 0..${TOKEN_PROTOCOL_LIMITS.maxTokenCount} or null`);
  }
  return value as number;
}

function nonNegativeFiniteOrNull(value: unknown, path: string, max: number): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    fail(path, `must be a finite number in 0..${max} or null`);
  }
  return value;
}

function optionalNumber(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  integer: boolean,
  max: number
): number | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
  return integer
    ? nonNegativeSafeIntegerOrNull(obj[key], `${path}.${key}`)
    : nonNegativeFiniteOrNull(obj[key], `${path}.${key}`, max);
}

function compact<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

function validateSource(value: unknown, path: string): UsageEventSource {
  const obj = plainObject(value, path);
  keysOnly(obj, ["runtime", "runtime_version", "source_type", "source_record_id", "source_platform"], path);
  return compact({
    runtime: boundedString(required(obj, "runtime", path), `${path}.runtime`, TOKEN_PROTOCOL_LIMITS.maxShortTextLength),
    runtime_version: optionalNullableString(obj, "runtime_version", path, 100),
    source_type: boundedString(required(obj, "source_type", path), `${path}.source_type`, TOKEN_PROTOCOL_LIMITS.maxShortTextLength),
    source_record_id: optionalNullableString(obj, "source_record_id", path, TOKEN_PROTOCOL_LIMITS.maxIdLength),
    source_platform: optionalNullableString(obj, "source_platform", path, TOKEN_PROTOCOL_LIMITS.maxShortTextLength)
  }) as UsageEventSource;
}

function validateIdentity(value: unknown, path: string): UsageIdentity {
  const obj = plainObject(value, path);
  keysOnly(obj, [
    "billing_platform", "inference_provider", "requested_model", "resolved_model",
    "provider_model_id", "service_tier", "region", "billing_mode", "alias_rule_id"
  ], path);
  return compact({
    billing_platform: nullableString(required(obj, "billing_platform", path), `${path}.billing_platform`, TOKEN_PROTOCOL_LIMITS.maxShortTextLength),
    inference_provider: optionalNullableString(obj, "inference_provider", path, TOKEN_PROTOCOL_LIMITS.maxShortTextLength),
    requested_model: nullableString(required(obj, "requested_model", path), `${path}.requested_model`, TOKEN_PROTOCOL_LIMITS.maxModelLength),
    resolved_model: nullableString(required(obj, "resolved_model", path), `${path}.resolved_model`, TOKEN_PROTOCOL_LIMITS.maxModelLength),
    provider_model_id: optionalNullableString(obj, "provider_model_id", path, TOKEN_PROTOCOL_LIMITS.maxModelLength),
    service_tier: optionalNullableString(obj, "service_tier", path, TOKEN_PROTOCOL_LIMITS.maxShortTextLength),
    region: optionalNullableString(obj, "region", path, TOKEN_PROTOCOL_LIMITS.maxShortTextLength),
    billing_mode: optionalNullableString(obj, "billing_mode", path, TOKEN_PROTOCOL_LIMITS.maxShortTextLength),
    alias_rule_id: optionalNullableString(obj, "alias_rule_id", path, TOKEN_PROTOCOL_LIMITS.maxShortTextLength)
  }) as UsageIdentity;
}

function validateScope(value: unknown, path: string): UsageScope {
  const obj = plainObject(value, path);
  const keys = ["system_id", "workspace_id", "project_id", "agent_id", "bot_id", "worker_id", "skill_id", "automation_id", "tool_id"] as const;
  keysOnly(obj, keys, path);
  const out: Record<string, string | null | undefined> = {};
  for (const key of keys) out[key] = optionalNullableString(obj, key, path, 300);
  return compact(out) as UsageScope;
}

function validateUsage(value: unknown, path: string): UsageCounts {
  const obj = plainObject(value, path);
  const integerKeys = [
    "context_input_tokens", "input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "cache_write_tokens",
    "cached_input_tokens", "audio_input_tokens", "audio_output_tokens", "total_tokens_reported"
  ] as const;
  const numberKeys = ["image_input_units", "image_output_units", "web_search_units", "request_units"] as const;
  keysOnly(obj, [...integerKeys, ...numberKeys], path);
  const out: Record<string, number | null | undefined> = {};
  for (const key of integerKeys) out[key] = optionalNumber(obj, key, path, true, TOKEN_PROTOCOL_LIMITS.maxTokenCount);
  for (const key of numberKeys) out[key] = optionalNumber(obj, key, path, false, TOKEN_PROTOCOL_LIMITS.maxUnitCount);
  return compact(out) as UsageCounts;
}

function validateTiming(value: unknown, path: string): UsageTiming {
  const obj = plainObject(value, path);
  const dateKeys = ["started_at", "first_byte_at", "first_token_at", "last_token_at", "ended_at"] as const;
  const durationKeys = ["wall_ms", "ttft_ms", "generation_ms", "queue_ms", "provider_ms", "gateway_overhead_ms", "tool_wait_ms", "network_ms"] as const;
  keysOnly(obj, [...dateKeys, ...durationKeys], path);
  const out: Record<string, string | number | null | undefined> = {};
  for (const key of dateKeys) out[key] = optionalNullableDateTime(obj, key, path);
  for (const key of durationKeys) out[key] = optionalNumber(obj, key, path, false, TOKEN_PROTOCOL_LIMITS.maxDurationMs);

  const ordered = dateKeys
    .map((key) => ({ key, value: out[key] }))
    .filter((item): item is { key: (typeof dateKeys)[number]; value: string } => typeof item.value === "string");
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (Date.parse(current.value) < Date.parse(previous.value)) {
      fail(`${path}.${current.key}`, `must not be earlier than ${previous.key}`);
    }
  }

  return compact(out) as UsageTiming;
}

function validateActualCharge(value: unknown, path: string): ActualCharge {
  const obj = plainObject(value, path);
  keysOnly(obj, ["amount", "currency", "source", "external_charge_id", "reported_at"], path);
  const amount = boundedString(required(obj, "amount", path), `${path}.amount`, 128);
  if (!DECIMAL_MONEY_RE.test(amount)) {
    fail(`${path}.amount`, "must be a non-negative base-10 decimal string without exponent notation");
  }
  const currency = boundedString(required(obj, "currency", path), `${path}.currency`, 3, 3);
  if (!CURRENCY_RE.test(currency)) fail(`${path}.currency`, "must be an uppercase ISO-like 3-letter currency code");
  return compact({
    amount,
    currency,
    source: oneOf(required(obj, "source", path), ACTUAL_CHARGE_SOURCES, `${path}.source`),
    external_charge_id: optionalNullableString(obj, "external_charge_id", path, TOKEN_PROTOCOL_LIMITS.maxIdLength),
    reported_at: optionalNullableDateTime(obj, "reported_at", path)
  }) as ActualCharge;
}

function validateProvenance(value: unknown, path: string): UsageProvenance {
  const obj = plainObject(value, path);
  keysOnly(obj, ["collector_id", "collector_version", "source_type", "source_record_fingerprint", "usage_quality", "timing_quality", "content_stored"], path);
  const contentStored = required(obj, "content_stored", path);
  if (contentStored !== false) fail(`${path}.content_stored`, "must be false for canonical usage events");
  return compact({
    collector_id: boundedString(required(obj, "collector_id", path), `${path}.collector_id`, TOKEN_PROTOCOL_LIMITS.maxShortTextLength),
    collector_version: optionalNullableString(obj, "collector_version", path, 100),
    source_type: optionalNullableString(obj, "source_type", path, TOKEN_PROTOCOL_LIMITS.maxShortTextLength),
    source_record_fingerprint: boundedString(required(obj, "source_record_fingerprint", path), `${path}.source_record_fingerprint`, TOKEN_PROTOCOL_LIMITS.maxFingerprintLength, TOKEN_PROTOCOL_LIMITS.minFingerprintLength),
    usage_quality: oneOf(required(obj, "usage_quality", path), USAGE_QUALITIES, `${path}.usage_quality`) as UsageQuality,
    timing_quality: oneOf(required(obj, "timing_quality", path), TIMING_QUALITIES, `${path}.timing_quality`) as TimingQuality,
    content_stored: false as const
  }) as UsageProvenance;
}

export function validateCostStatus(value: unknown, path = "$.status"): CostStatus {
  return oneOf(value, COST_STATUSES, path);
}

export function validateUsageEvent(value: unknown): UsageEvent {
  const path = "$";
  const obj = plainObject(value, path);
  keysOnly(obj, [
    "schema_version", "event_id", "request_id", "session_id", "run_id", "task_id", "source",
    "observed_at", "identity", "scope", "usage", "timing", "actual_charge", "provenance"
  ], path);

  const schemaVersion = required(obj, "schema_version", path);
  if (schemaVersion !== TOKEN_PROTOCOL_VERSION) {
    fail("$.schema_version", `must equal ${TOKEN_PROTOCOL_VERSION}`);
  }

  const event: UsageEvent = compact({
    schema_version: TOKEN_PROTOCOL_VERSION,
    event_id: boundedString(required(obj, "event_id", path), "$.event_id", TOKEN_PROTOCOL_LIMITS.maxIdLength),
    request_id: optionalNullableString(obj, "request_id", path, TOKEN_PROTOCOL_LIMITS.maxIdLength),
    session_id: optionalNullableString(obj, "session_id", path, TOKEN_PROTOCOL_LIMITS.maxIdLength),
    run_id: optionalNullableString(obj, "run_id", path, TOKEN_PROTOCOL_LIMITS.maxIdLength),
    task_id: optionalNullableString(obj, "task_id", path, TOKEN_PROTOCOL_LIMITS.maxIdLength),
    source: validateSource(required(obj, "source", path), "$.source"),
    observed_at: isoDateTime(required(obj, "observed_at", path), "$.observed_at"),
    identity: validateIdentity(required(obj, "identity", path), "$.identity"),
    scope: Object.prototype.hasOwnProperty.call(obj, "scope") ? validateScope(obj.scope, "$.scope") : undefined,
    usage: validateUsage(required(obj, "usage", path), "$.usage"),
    timing: validateTiming(required(obj, "timing", path), "$.timing"),
    actual_charge: Object.prototype.hasOwnProperty.call(obj, "actual_charge")
      ? obj.actual_charge === null
        ? null
        : validateActualCharge(obj.actual_charge, "$.actual_charge")
      : undefined,
    provenance: validateProvenance(required(obj, "provenance", path), "$.provenance")
  }) as UsageEvent;

  return event;
}
