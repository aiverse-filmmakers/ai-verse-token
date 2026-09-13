import type { CorrelationKey } from "../storage/ledger.js";
import type { UsageCounts, UsageEvent, UsageTiming } from "../protocol/types.js";
import {
  RemoteAdapterError,
  nonNegativeInt,
  nonNegativeNumber,
  optionalText,
  record,
  remoteEvent,
  text
} from "./common.js";

const COLLECTOR_ID = "opentelemetry-genai";
const VERSION = "0.1.0";

type AttributeMap = Record<string, unknown>;

export interface OpenTelemetryGenAISpanOptions {
  readonly billingPlatform?: string | null;
  readonly sourceRecordId?: string | null;
}

export interface OpenTelemetryGenAINormalizationResult {
  readonly event: UsageEvent;
  readonly correlation_keys: readonly CorrelationKey[];
  readonly trace_id: string;
  readonly span_id: string;
}

function otlpValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const row = value as Record<string, unknown>;
  for (const key of ["stringValue", "intValue", "doubleValue", "boolValue"]) {
    if (row[key] !== undefined) return row[key];
  }
  return value;
}

function attributes(value: unknown): AttributeMap {
  if (Array.isArray(value)) {
    const result: AttributeMap = {};
    for (let index = 0; index < value.length; index += 1) {
      const item = record(value[index], `span.attributes[${index}]`);
      const key = text(item.key, `span.attributes[${index}].key`, 500);
      result[key] = otlpValue(item.value);
    }
    return result;
  }
  return record(value ?? {}, "span.attributes");
}

function attrText(attrs: AttributeMap, key: string, max = 500): string | null {
  return optionalText(otlpValue(attrs[key]), `span.attributes.${key}`, max);
}

function attrInt(attrs: AttributeMap, key: string): number | null {
  const raw = otlpValue(attrs[key]);
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    const parsed = Number(raw);
    return nonNegativeInt(parsed, `span.attributes.${key}`);
  }
  return nonNegativeInt(raw, `span.attributes.${key}`);
}

function nanoIso(value: unknown, path: string): string {
  if ((typeof value !== "string" && typeof value !== "number") || !/^\d+$/.test(String(value))) {
    throw new RemoteAdapterError("REMOTE_RECORD_INVALID", `${path}: must be Unix nanoseconds`);
  }
  const ns = BigInt(String(value));
  const ms = ns / 1_000_000n;
  if (ms > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RemoteAdapterError("REMOTE_RECORD_INVALID", `${path}: is outside the supported date range`);
  }
  return new Date(Number(ms)).toISOString();
}

function spanTime(row: Record<string, unknown>, normalAliases: readonly string[], nanoAliases: readonly string[], path: string): string | null {
  for (const key of normalAliases) {
    const value = row[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
      throw new RemoteAdapterError("REMOTE_RECORD_INVALID", `${path}: must be an ISO 8601 date-time`);
    }
    return new Date(Date.parse(value)).toISOString();
  }
  for (const key of nanoAliases) {
    const value = row[key];
    if (value !== undefined && value !== null) return nanoIso(value, `${path}.${key}`);
  }
  return null;
}

function usageFrom(attrs: AttributeMap): UsageCounts {
  const inputInclusive = attrInt(attrs, "gen_ai.usage.input_tokens");
  const outputInclusive = attrInt(attrs, "gen_ai.usage.output_tokens");
  const cacheWrite = attrInt(attrs, "gen_ai.usage.cache_creation.input_tokens");
  const cacheRead = attrInt(attrs, "gen_ai.usage.cache_read.input_tokens");
  const reasoning = attrInt(attrs, "gen_ai.usage.reasoning.output_tokens");
  const cacheWriteCount = cacheWrite ?? 0;
  const cacheReadCount = cacheRead ?? 0;
  const reasoningCount = reasoning ?? 0;
  if (inputInclusive !== null && cacheWriteCount + cacheReadCount > inputInclusive) {
    throw new RemoteAdapterError("REMOTE_USAGE_INVALID", "OpenTelemetry cache token subsets exceed gen_ai.usage.input_tokens");
  }
  if (outputInclusive !== null && reasoningCount > outputInclusive) {
    throw new RemoteAdapterError("REMOTE_USAGE_INVALID", "OpenTelemetry reasoning tokens exceed gen_ai.usage.output_tokens");
  }
  return {
    ...(inputInclusive === null ? {} : { context_input_tokens: inputInclusive, input_tokens: inputInclusive - cacheWriteCount - cacheReadCount }),
    ...(outputInclusive === null ? {} : { output_tokens: outputInclusive - reasoningCount }),
    ...(cacheWrite === null ? {} : { cache_write_tokens: cacheWriteCount }),
    ...(cacheRead === null ? {} : { cache_read_tokens: cacheReadCount }),
    ...(reasoning === null ? {} : { reasoning_tokens: reasoningCount }),
    ...(inputInclusive === null || outputInclusive === null ? {} : { total_tokens_reported: inputInclusive + outputInclusive })
  };
}

function timingFrom(row: Record<string, unknown>, attrs: AttributeMap): UsageTiming {
  const started = spanTime(row, ["start_time", "startTime"], ["start_time_unix_nano", "startTimeUnixNano"], "span.start_time");
  const ended = spanTime(row, ["end_time", "endTime"], ["end_time_unix_nano", "endTimeUnixNano"], "span.end_time");
  const ttfcSeconds = nonNegativeNumber(otlpValue(attrs["gen_ai.response.time_to_first_chunk"]), "span.attributes.gen_ai.response.time_to_first_chunk");
  if (started !== null && ended !== null && Date.parse(ended) < Date.parse(started)) {
    throw new RemoteAdapterError("REMOTE_RECORD_INVALID", "OpenTelemetry span ends before it starts");
  }
  return {
    ...(started === null ? {} : { started_at: started }),
    ...(ended === null ? {} : { ended_at: ended }),
    ...(started === null || ended === null ? {} : { wall_ms: Date.parse(ended) - Date.parse(started) }),
    ...(ttfcSeconds === null ? {} : { ttft_ms: ttfcSeconds * 1000 })
  };
}

export function normalizeOpenTelemetryGenAISpan(
  value: unknown,
  options: OpenTelemetryGenAISpanOptions = {}
): OpenTelemetryGenAINormalizationResult {
  const row = record(value, "span");
  const traceId = text(row.trace_id ?? row.traceId, "span.trace_id", 128);
  const spanId = text(row.span_id ?? row.spanId, "span.span_id", 128);
  const attrs = attributes(row.attributes);
  const operation = attrText(attrs, "gen_ai.operation.name", 200);
  if (operation === null) throw new RemoteAdapterError("REMOTE_RECORD_INVALID", "span.attributes.gen_ai.operation.name is required");
  const provider = attrText(attrs, "gen_ai.provider.name", 200);
  const requestedModel = attrText(attrs, "gen_ai.request.model", 500);
  const responseModel = attrText(attrs, "gen_ai.response.model", 500);
  const responseId = attrText(attrs, "gen_ai.response.id", 500);
  const billingPlatform = options.billingPlatform === undefined
    ? null
    : options.billingPlatform === null
      ? null
      : text(options.billingPlatform, "options.billingPlatform", 200);
  const timing = timingFrom(row, attrs);
  const observedAt = timing.ended_at ?? timing.started_at;
  if (observedAt === undefined || observedAt === null) {
    throw new RemoteAdapterError("REMOTE_RECORD_INVALID", "OpenTelemetry span requires start or end time");
  }
  const sourceRecordId = options.sourceRecordId ?? `${traceId}:${spanId}`;
  const event = remoteEvent({
    collectorId: COLLECTOR_ID,
    collectorVersion: VERSION,
    runtime: "opentelemetry",
    sourceType: `otel.genai.${operation}`,
    sourceRecordId,
    observedAt,
    ...(responseId === null ? {} : { requestId: responseId }),
    identity: {
      billing_platform: billingPlatform,
      inference_provider: provider,
      requested_model: requestedModel,
      resolved_model: responseModel ?? requestedModel
    },
    usage: usageFrom(attrs),
    timing,
    usageQuality: "provider_reported",
    timingQuality: "derived_exact"
  });
  const correlationKeys: CorrelationKey[] = [{ kind: "otel_span", value: `${traceId}:${spanId}` }];
  if (responseId !== null) correlationKeys.push({ kind: "response_id", value: responseId });
  return Object.freeze({ event, correlation_keys: Object.freeze(correlationKeys), trace_id: traceId, span_id: spanId });
}
