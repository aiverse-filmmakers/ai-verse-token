import type { CorrelationKey } from "../storage/ledger.js";
import type { UsageCounts, UsageEvent, UsageTiming } from "../protocol/types.js";
import {
  RemoteAdapterError,
  aliasValue,
  iso,
  nonNegativeInt,
  nonNegativeNumber,
  optionalIso,
  optionalText,
  record,
  remoteEvent,
  text
} from "./common.js";

export interface GatewayNormalizationResult {
  readonly event: UsageEvent;
  readonly correlation_keys: readonly CorrelationKey[];
  readonly gateway_calculated_cost_usd: number | null;
  readonly gateway_cache_hit: boolean;
}

export interface OpenAICompatibleGatewayOptions {
  readonly runtime: string;
  readonly sourceType?: string;
  readonly billingPlatform?: string | null;
  readonly inferenceProvider?: string | null;
  readonly observedAt: string;
  readonly requestId?: string | null;
  readonly sessionId?: string | null;
  readonly upstreamRequestId?: string | null;
}

function bool(value: unknown, path: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw new RemoteAdapterError("REMOTE_RECORD_INVALID", `${path}: must be boolean`);
  return value;
}

function openAIUsage(usageValue: unknown, path: string): UsageCounts {
  const usage = record(usageValue, path);
  const prompt = nonNegativeInt(usage.prompt_tokens ?? usage.input_tokens, `${path}.prompt_tokens`);
  const completion = nonNegativeInt(usage.completion_tokens ?? usage.output_tokens, `${path}.completion_tokens`);
  const promptDetails = usage.prompt_tokens_details == null ? undefined : record(usage.prompt_tokens_details, `${path}.prompt_tokens_details`);
  const completionDetails = usage.completion_tokens_details == null ? undefined : record(usage.completion_tokens_details, `${path}.completion_tokens_details`);
  const cached = promptDetails === undefined
    ? nonNegativeInt(usage.cache_read_input_tokens, `${path}.cache_read_input_tokens`)
    : nonNegativeInt(promptDetails.cached_tokens, `${path}.prompt_tokens_details.cached_tokens`);
  const cacheWriteFromDetails = promptDetails === undefined
    ? null
    : nonNegativeInt(promptDetails.cache_write_tokens ?? promptDetails.cache_creation_tokens, `${path}.prompt_tokens_details.cache_write_tokens`);
  const cacheWrite = cacheWriteFromDetails ?? nonNegativeInt(usage.cache_creation_input_tokens, `${path}.cache_creation_input_tokens`);
  const reasoning = completionDetails === undefined
    ? nonNegativeInt(usage.reasoning_tokens, `${path}.reasoning_tokens`)
    : nonNegativeInt(completionDetails.reasoning_tokens, `${path}.completion_tokens_details.reasoning_tokens`);
  const cacheReadCount = cached ?? 0;
  const cacheWriteCount = cacheWrite ?? 0;
  const reasoningCount = reasoning ?? 0;
  if (prompt !== null && cacheReadCount + cacheWriteCount > prompt) {
    throw new RemoteAdapterError("REMOTE_USAGE_INVALID", `${path}: cached/cache-write subsets exceed prompt tokens`);
  }
  if (completion !== null && reasoningCount > completion) {
    throw new RemoteAdapterError("REMOTE_USAGE_INVALID", `${path}: reasoning subset exceeds completion tokens`);
  }
  return {
    ...(prompt === null ? {} : { context_input_tokens: prompt, input_tokens: prompt - cacheReadCount - cacheWriteCount }),
    ...(completion === null ? {} : { output_tokens: completion - reasoningCount }),
    ...(cached === null ? {} : { cache_read_tokens: cacheReadCount }),
    ...(cacheWrite === null ? {} : { cache_write_tokens: cacheWriteCount }),
    ...(reasoning === null ? {} : { reasoning_tokens: reasoningCount }),
    ...(prompt === null || completion === null ? {} : { total_tokens_reported: prompt + completion })
  };
}

function zeroGatewayUsage(): UsageCounts {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    request_units: 1,
    total_tokens_reported: 0
  };
}

function correlationKeys(requestId: string | null, upstreamRequestId: string | null, responseId: string | null): CorrelationKey[] {
  const result: CorrelationKey[] = [];
  if (requestId !== null) result.push({ kind: "request_id", value: requestId });
  if (upstreamRequestId !== null) result.push({ kind: "upstream_request_id", value: upstreamRequestId });
  if (responseId !== null) result.push({ kind: "response_id", value: responseId });
  return result;
}

export function normalizeOpenAICompatibleGateway(
  value: unknown,
  options: OpenAICompatibleGatewayOptions
): GatewayNormalizationResult {
  const row = record(value, "gateway.response");
  const responseId = optionalText(row.id, "gateway.response.id", 500);
  const model = text(row.model, "gateway.response.model", 500);
  const runtime = text(options.runtime, "options.runtime", 100);
  const observedAt = iso(options.observedAt, "options.observedAt");
  const requestId = options.requestId == null ? responseId : text(options.requestId, "options.requestId", 500);
  const upstreamRequestId = options.upstreamRequestId == null ? null : text(options.upstreamRequestId, "options.upstreamRequestId", 500);
  const event = remoteEvent({
    collectorId: `${runtime}-openai-compatible`,
    collectorVersion: "0.1.0",
    runtime,
    sourceType: options.sourceType ?? "gateway.openai-compatible",
    sourceRecordId: responseId ?? requestId ?? `${model}:${observedAt}`,
    observedAt,
    ...(requestId === null ? {} : { requestId }),
    ...(options.sessionId == null ? {} : { sessionId: options.sessionId }),
    identity: {
      billing_platform: options.billingPlatform ?? null,
      inference_provider: options.inferenceProvider ?? null,
      requested_model: model,
      resolved_model: model
    },
    usage: openAIUsage(row.usage, "gateway.response.usage"),
    timing: {},
    usageQuality: "runtime_reported",
    timingQuality: "unknown"
  });
  return Object.freeze({
    event,
    correlation_keys: Object.freeze(correlationKeys(requestId, upstreamRequestId, responseId)),
    gateway_calculated_cost_usd: null,
    gateway_cache_hit: false
  });
}

export interface LiteLLMSpendLogOptions {
  readonly observedAt?: string | null;
  readonly billingPlatform?: string | null;
}

export function normalizeLiteLLMSpendLog(value: unknown, options: LiteLLMSpendLogOptions = {}): GatewayNormalizationResult {
  const row = record(value, "litellm");
  const requestId = optionalText(aliasValue(row, ["request_id", "requestId", "litellm_call_id"], "litellm.request_id"), "litellm.request_id", 500);
  const responseId = optionalText(aliasValue(row, ["response_id", "responseId"], "litellm.response_id"), "litellm.response_id", 500);
  const upstreamRequestId = optionalText(aliasValue(row, ["upstream_request_id", "provider_request_id"], "litellm.upstream_request_id"), "litellm.upstream_request_id", 500);
  const model = text(aliasValue(row, ["model", "model_id"], "litellm.model"), "litellm.model", 500);
  const provider = optionalText(aliasValue(row, ["custom_llm_provider", "provider"], "litellm.provider"), "litellm.provider", 200);
  const cacheHit = bool(aliasValue(row, ["cache_hit", "cacheHit"], "litellm.cache_hit"), "litellm.cache_hit") ?? false;
  const start = optionalIso(aliasValue(row, ["startTime", "start_time"], "litellm.start_time"), "litellm.start_time");
  const end = optionalIso(aliasValue(row, ["endTime", "end_time"], "litellm.end_time"), "litellm.end_time");
  const observedAt = options.observedAt == null ? end ?? start : iso(options.observedAt, "options.observedAt");
  if (observedAt === null) throw new RemoteAdapterError("REMOTE_RECORD_INVALID", "LiteLLM record requires an observed/start/end time");
  const usageSource = row.usage === undefined ? row : record(row.usage, "litellm.usage");
  const usage = cacheHit ? zeroGatewayUsage() : openAIUsage(usageSource, "litellm.usage");
  const spend = nonNegativeNumber(aliasValue(row, ["spend", "response_cost", "cost"], "litellm.spend"), "litellm.spend");
  const timing: UsageTiming = {
    ...(start === null ? {} : { started_at: start }),
    ...(end === null ? {} : { ended_at: end }),
    ...(start === null || end === null ? {} : { wall_ms: Date.parse(end) - Date.parse(start) })
  };
  if (typeof timing.wall_ms === "number" && timing.wall_ms < 0) throw new RemoteAdapterError("REMOTE_RECORD_INVALID", "LiteLLM end time precedes start time");
  const sourceRecordId = responseId ?? requestId ?? `${model}:${observedAt}`;
  const event = remoteEvent({
    collectorId: "litellm-spend-log",
    collectorVersion: "0.1.0",
    runtime: "litellm",
    sourceType: "litellm.spend-log",
    sourceRecordId,
    observedAt,
    ...(requestId === null ? {} : { requestId }),
    identity: {
      billing_platform: options.billingPlatform ?? provider,
      inference_provider: provider,
      requested_model: model,
      resolved_model: model
    },
    usage,
    timing,
    usageQuality: cacheHit ? "derived_exact" : "runtime_reported",
    timingQuality: start === null || end === null ? "unknown" : "runtime_reported"
  });
  return Object.freeze({
    event,
    correlation_keys: Object.freeze(correlationKeys(requestId, upstreamRequestId, responseId)),
    gateway_calculated_cost_usd: spend,
    gateway_cache_hit: cacheHit
  });
}

export interface BifrostLogOptions {
  readonly observedAt?: string | null;
  readonly billingPlatform?: string | null;
}

export function normalizeBifrostLog(value: unknown, options: BifrostLogOptions = {}): GatewayNormalizationResult {
  const row = record(value, "bifrost");
  const requestId = optionalText(aliasValue(row, ["request_id", "requestId"], "bifrost.request_id"), "bifrost.request_id", 500);
  const responseId = optionalText(aliasValue(row, ["response_id", "responseId"], "bifrost.response_id"), "bifrost.response_id", 500);
  const upstreamRequestId = optionalText(aliasValue(row, ["upstream_request_id", "provider_request_id"], "bifrost.upstream_request_id"), "bifrost.upstream_request_id", 500);
  const provider = optionalText(aliasValue(row, ["provider", "provider_name"], "bifrost.provider"), "bifrost.provider", 200);
  const model = text(aliasValue(row, ["model", "model_name"], "bifrost.model"), "bifrost.model", 500);
  const observedAtRaw = options.observedAt ?? aliasValue(row, ["timestamp", "created_at", "observed_at"], "bifrost.observed_at");
  const observedAt = iso(observedAtRaw, "bifrost.observed_at");
  const stream = bool(aliasValue(row, ["stream", "streaming", "is_streaming"], "bifrost.streaming"), "bifrost.streaming") ?? false;
  const input = nonNegativeInt(aliasValue(row, ["input_tokens", "prompt_tokens"], "bifrost.input_tokens"), "bifrost.input_tokens");
  const output = nonNegativeInt(aliasValue(row, ["output_tokens", "completion_tokens"], "bifrost.output_tokens"), "bifrost.output_tokens");
  const zeroStreamBug = stream && input === 0 && output === 0;
  const usage: UsageCounts = zeroStreamBug
    ? { request_units: 1 }
    : {
        ...(input === null ? {} : { input_tokens: input }),
        ...(output === null ? {} : { output_tokens: output }),
        ...(input === null || output === null ? {} : { total_tokens_reported: input + output })
      };
  const latency = nonNegativeNumber(row.latency_ms, "bifrost.latency_ms");
  const ttft = nonNegativeNumber(aliasValue(row, ["ttft_ms", "time_to_first_token_ms"], "bifrost.ttft"), "bifrost.ttft");
  const spend = nonNegativeNumber(aliasValue(row, ["cost", "cost_usd", "spend"], "bifrost.cost"), "bifrost.cost");
  const event = remoteEvent({
    collectorId: "bifrost-log",
    collectorVersion: "0.1.0",
    runtime: "bifrost",
    sourceType: "bifrost.request-log",
    sourceRecordId: responseId ?? requestId ?? `${model}:${observedAt}`,
    observedAt,
    ...(requestId === null ? {} : { requestId }),
    identity: {
      billing_platform: options.billingPlatform ?? provider,
      inference_provider: provider,
      requested_model: model,
      resolved_model: model
    },
    usage,
    timing: {
      ...(latency === null ? {} : { wall_ms: latency }),
      ...(ttft === null ? {} : { ttft_ms: ttft })
    },
    usageQuality: zeroStreamBug ? "unknown" : "runtime_reported",
    timingQuality: latency === null && ttft === null ? "unknown" : "runtime_reported"
  });
  return Object.freeze({
    event,
    correlation_keys: Object.freeze(correlationKeys(requestId, upstreamRequestId, responseId)),
    gateway_calculated_cost_usd: spend,
    gateway_cache_hit: false
  });
}
