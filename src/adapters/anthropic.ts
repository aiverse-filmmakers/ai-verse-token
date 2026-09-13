import type { CostRatingContext } from "../cost/types.js";
import type { UsageCounts, UsageEvent } from "../protocol/types.js";
import {
  RemoteAdapterError,
  nonNegativeInt,
  optionalText,
  record,
  remoteEvent,
  text,
  iso
} from "./common.js";

const COLLECTOR_ID = "anthropic-messages-api";
const VERSION = "0.1.0";
export const ANTHROPIC_PRICING_SOURCE_ID = "anthropic-official-pricing" as const;

export interface AnthropicMessageOptions {
  readonly observedAt: string;
}

export interface AnthropicMessageNormalizationResult {
  readonly event: UsageEvent;
  readonly message_id: string;
  readonly pricing_source_id: typeof ANTHROPIC_PRICING_SOURCE_ID;
  readonly pricing_context: CostRatingContext | null;
}

interface AnthropicUsageResult {
  readonly usage: UsageCounts;
  readonly serviceTier: string | null;
  readonly region: string | null;
  readonly pricingContext: CostRatingContext | null;
}

function usageFrom(row: Record<string, unknown>): AnthropicUsageResult {
  const usage = record(row.usage, "message.usage");
  const input = nonNegativeInt(usage.input_tokens, "message.usage.input_tokens");
  const outputInclusive = nonNegativeInt(usage.output_tokens, "message.usage.output_tokens");
  const cacheWrite = nonNegativeInt(usage.cache_creation_input_tokens, "message.usage.cache_creation_input_tokens");
  const cacheRead = nonNegativeInt(usage.cache_read_input_tokens, "message.usage.cache_read_input_tokens");
  if (input === null || outputInclusive === null) {
    throw new RemoteAdapterError("REMOTE_USAGE_INVALID", "message.usage must include input_tokens and output_tokens");
  }

  const outputDetails = usage.output_tokens_details === undefined || usage.output_tokens_details === null
    ? undefined
    : record(usage.output_tokens_details, "message.usage.output_tokens_details");
  const thinking = outputDetails === undefined ? null : nonNegativeInt(outputDetails.thinking_tokens, "message.usage.output_tokens_details.thinking_tokens");
  const thinkingCount = thinking ?? 0;
  if (thinkingCount > outputInclusive) {
    throw new RemoteAdapterError("REMOTE_USAGE_INVALID", "Anthropic thinking_tokens exceed output_tokens");
  }

  const serverToolUse = usage.server_tool_use === undefined || usage.server_tool_use === null
    ? undefined
    : record(usage.server_tool_use, "message.usage.server_tool_use");
  const webSearchRequests = serverToolUse === undefined
    ? null
    : nonNegativeInt(serverToolUse.web_search_requests, "message.usage.server_tool_use.web_search_requests");

  let pricingContext: CostRatingContext | null = null;
  if (usage.cache_creation !== undefined && usage.cache_creation !== null) {
    const detail = record(usage.cache_creation, "message.usage.cache_creation");
    const oneHour = nonNegativeInt(detail.ephemeral_1h_input_tokens, "message.usage.cache_creation.ephemeral_1h_input_tokens") ?? 0;
    const fiveMinute = nonNegativeInt(detail.ephemeral_5m_input_tokens, "message.usage.cache_creation.ephemeral_5m_input_tokens") ?? 0;
    if (cacheWrite !== null && oneHour + fiveMinute !== cacheWrite) {
      throw new RemoteAdapterError("REMOTE_USAGE_INVALID", "Anthropic cache_creation TTL breakdown does not equal cache_creation_input_tokens");
    }
    if (oneHour > 0 && fiveMinute === 0) pricingContext = Object.freeze({ cache_ttl_seconds: 3600 });
    if (fiveMinute > 0 && oneHour === 0) pricingContext = Object.freeze({ cache_ttl_seconds: 300 });
    // Mixed TTL writes intentionally return no single rating context. The usage remains exact,
    // but a TTL-specific tariff must fail closed rather than pretending one TTL applied to all writes.
  }

  return Object.freeze({
    usage: {
      context_input_tokens: input + (cacheWrite ?? 0) + (cacheRead ?? 0),
      input_tokens: input,
      output_tokens: outputInclusive - thinkingCount,
      ...(cacheWrite === null ? {} : { cache_write_tokens: cacheWrite }),
      ...(cacheRead === null ? {} : { cache_read_tokens: cacheRead }),
      ...(thinking === null ? {} : { reasoning_tokens: thinkingCount }),
      ...(webSearchRequests === null ? {} : { web_search_units: webSearchRequests })
    },
    serviceTier: optionalText(usage.service_tier, "message.usage.service_tier", 100),
    region: optionalText(usage.inference_geo, "message.usage.inference_geo", 100),
    pricingContext
  });
}

export function normalizeAnthropicMessage(value: unknown, options: AnthropicMessageOptions): AnthropicMessageNormalizationResult {
  const row = record(value, "message");
  const messageId = text(row.id, "message.id", 500);
  const model = text(row.model, "message.model", 500);
  const observedAt = iso(options.observedAt, "options.observedAt");
  const normalized = usageFrom(row);

  const event = remoteEvent({
    collectorId: COLLECTOR_ID,
    collectorVersion: VERSION,
    runtime: "anthropic",
    sourceType: "anthropic.messages-api",
    sourceRecordId: messageId,
    observedAt,
    requestId: messageId,
    identity: {
      billing_platform: "anthropic",
      inference_provider: "anthropic",
      requested_model: model,
      resolved_model: model,
      service_tier: normalized.serviceTier,
      region: normalized.region
    },
    usage: normalized.usage,
    timing: {},
    usageQuality: "provider_reported",
    timingQuality: "unknown"
  });

  return Object.freeze({
    event,
    message_id: messageId,
    pricing_source_id: ANTHROPIC_PRICING_SOURCE_ID,
    pricing_context: normalized.pricingContext
  });
}
