import type { UsageCounts, UsageEvent } from "../protocol/types.js";
import {
  RemoteAdapterError,
  nonNegativeInt,
  optionalText,
  record,
  remoteEvent,
  text
} from "./common.js";

const COLLECTOR_ID = "openai-responses-api";
const VERSION = "0.1.0";
export const OPENAI_PRICING_SOURCE_ID = "openai-official-pricing" as const;

export interface OpenAIResponseNormalizationResult {
  readonly event: UsageEvent;
  readonly response_id: string;
  readonly pricing_source_id: typeof OPENAI_PRICING_SOURCE_ID;
}

function epochSecondsIso(value: unknown, path: string): string {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RemoteAdapterError("REMOTE_RECORD_INVALID", `${path}: must be non-negative Unix seconds`);
  }
  const ms = (value as number) * 1000;
  if (!Number.isFinite(ms)) throw new RemoteAdapterError("REMOTE_RECORD_INVALID", `${path}: invalid Unix seconds`);
  return new Date(ms).toISOString();
}

function usageFrom(row: Record<string, unknown>): UsageCounts {
  const usage = record(row.usage, "response.usage");
  const input = nonNegativeInt(usage.input_tokens, "response.usage.input_tokens");
  const output = nonNegativeInt(usage.output_tokens, "response.usage.output_tokens");
  const total = nonNegativeInt(usage.total_tokens, "response.usage.total_tokens");
  if (input === null || output === null) {
    throw new RemoteAdapterError("REMOTE_USAGE_INVALID", "response.usage must include input_tokens and output_tokens");
  }

  const inputDetails = usage.input_tokens_details === undefined || usage.input_tokens_details === null
    ? undefined
    : record(usage.input_tokens_details, "response.usage.input_tokens_details");
  const outputDetails = usage.output_tokens_details === undefined || usage.output_tokens_details === null
    ? undefined
    : record(usage.output_tokens_details, "response.usage.output_tokens_details");
  const cached = inputDetails === undefined ? null : nonNegativeInt(inputDetails.cached_tokens, "response.usage.input_tokens_details.cached_tokens");
  const cacheWrite = inputDetails === undefined ? null : nonNegativeInt(inputDetails.cache_write_tokens, "response.usage.input_tokens_details.cache_write_tokens");
  const reasoning = outputDetails === undefined ? null : nonNegativeInt(outputDetails.reasoning_tokens, "response.usage.output_tokens_details.reasoning_tokens");

  const cachedCount = cached ?? 0;
  const cacheWriteCount = cacheWrite ?? 0;
  const reasoningCount = reasoning ?? 0;
  if (cachedCount + cacheWriteCount > input) {
    throw new RemoteAdapterError("REMOTE_USAGE_INVALID", "OpenAI cached + cache-write tokens exceed input_tokens");
  }
  if (reasoningCount > output) {
    throw new RemoteAdapterError("REMOTE_USAGE_INVALID", "OpenAI reasoning_tokens exceed output_tokens");
  }
  if (total !== null && total !== input + output) {
    throw new RemoteAdapterError("REMOTE_USAGE_INVALID", "OpenAI total_tokens does not equal input_tokens + output_tokens");
  }

  return {
    context_input_tokens: input,
    input_tokens: input - cachedCount - cacheWriteCount,
    output_tokens: output - reasoningCount,
    ...(cached === null ? {} : { cached_input_tokens: cachedCount }),
    ...(cacheWrite === null ? {} : { cache_write_tokens: cacheWriteCount }),
    ...(reasoning === null ? {} : { reasoning_tokens: reasoningCount }),
    ...(total === null ? {} : { total_tokens_reported: total })
  };
}

export function normalizeOpenAIResponse(value: unknown): OpenAIResponseNormalizationResult {
  const row = record(value, "response");
  const responseId = text(row.id, "response.id", 500);
  const createdAt = epochSecondsIso(row.created_at, "response.created_at");
  const model = text(row.model, "response.model", 500);
  const serviceTier = optionalText(row.service_tier, "response.service_tier", 100);

  const event = remoteEvent({
    collectorId: COLLECTOR_ID,
    collectorVersion: VERSION,
    runtime: "openai",
    sourceType: "openai.responses-api",
    sourceRecordId: responseId,
    observedAt: createdAt,
    requestId: responseId,
    identity: {
      billing_platform: "openai",
      inference_provider: "openai",
      requested_model: model,
      resolved_model: model,
      service_tier: serviceTier
    },
    usage: usageFrom(row),
    timing: {},
    usageQuality: "provider_reported",
    timingQuality: "unknown"
  });

  return Object.freeze({ event, response_id: responseId, pricing_source_id: OPENAI_PRICING_SOURCE_ID });
}
