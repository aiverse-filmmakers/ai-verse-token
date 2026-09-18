import { createDefaultActualCostSourceRegistry } from "../cost/actual.js";
import { sealTrustedActualChargeEvent } from "../cost/trusted-actual-admission.js";
import type { UsageCounts, UsageEvent, UsageTiming } from "../protocol/types.js";
import {
  RemoteAdapterError,
  nonNegativeInt,
  nonNegativeNumber,
  optionalText,
  record,
  remoteEvent,
  text,
  iso
} from "./common.js";

const COLLECTOR_ID = "openrouter-generation-api";
const VERSION = "0.1.0";

export interface OpenRouterGenerationNormalizationResult {
  readonly event: UsageEvent;
  readonly generation_id: string;
  readonly upstream_id: string | null;
  readonly provider_name: string | null;
}

function providerModelId(row: Record<string, unknown>): string | null {
  if (!Array.isArray(row.provider_responses) || row.provider_responses.length !== 1) return null;
  const only = row.provider_responses[0];
  if (typeof only !== "object" || only === null || Array.isArray(only)) return null;
  return optionalText((only as Record<string, unknown>).model_permaslug, "data.provider_responses[0].model_permaslug", 500);
}

function usageFrom(row: Record<string, unknown>): UsageCounts {
  const nativePrompt = nonNegativeInt(row.native_tokens_prompt, "data.native_tokens_prompt");
  const nativeCompletion = nonNegativeInt(row.native_tokens_completion, "data.native_tokens_completion");
  const cached = nonNegativeInt(row.native_tokens_cached, "data.native_tokens_cached");
  const reasoning = nonNegativeInt(row.native_tokens_reasoning, "data.native_tokens_reasoning");

  if (nativePrompt !== null || nativeCompletion !== null) {
    const cachedCount = cached ?? 0;
    const reasoningCount = reasoning ?? 0;
    if (nativePrompt !== null && cachedCount > nativePrompt) {
      throw new RemoteAdapterError("REMOTE_USAGE_INVALID", "data.native_tokens_cached exceeds native_tokens_prompt");
    }
    if (nativeCompletion !== null && reasoningCount > nativeCompletion) {
      throw new RemoteAdapterError("REMOTE_USAGE_INVALID", "data.native_tokens_reasoning exceeds native_tokens_completion");
    }
    return {
      ...(nativePrompt === null ? {} : { context_input_tokens: nativePrompt, input_tokens: nativePrompt - cachedCount }),
      ...(nativeCompletion === null ? {} : { output_tokens: nativeCompletion - reasoningCount }),
      ...(cached === null ? {} : { cached_input_tokens: cachedCount }),
      ...(reasoning === null ? {} : { reasoning_tokens: reasoningCount }),
      ...(nativePrompt === null || nativeCompletion === null ? {} : { total_tokens_reported: nativePrompt + nativeCompletion })
    };
  }

  const prompt = nonNegativeInt(row.tokens_prompt, "data.tokens_prompt");
  const completion = nonNegativeInt(row.tokens_completion, "data.tokens_completion");
  if (prompt === null && completion === null) return {};
  return {
    ...(prompt === null ? {} : { context_input_tokens: prompt, input_tokens: prompt }),
    ...(completion === null ? {} : { output_tokens: completion }),
    ...(prompt === null || completion === null ? {} : { total_tokens_reported: prompt + completion })
  };
}

function timingFrom(row: Record<string, unknown>): UsageTiming {
  const generationMs = nonNegativeNumber(row.generation_time, "data.generation_time");
  return generationMs === null ? {} : { generation_ms: generationMs };
}

export function normalizeOpenRouterGeneration(value: unknown): OpenRouterGenerationNormalizationResult {
  const envelope = record(value, "response");
  const row = record(envelope.data ?? value, "data");
  const generationId = text(row.id, "data.id", 500);
  const createdAt = iso(row.created_at, "data.created_at");
  const resolvedModel = text(row.model, "data.model", 500);
  const router = optionalText(row.router, "data.router", 500);
  const provider = optionalText(row.provider_name, "data.provider_name", 200);
  const requestId = optionalText(row.request_id, "data.request_id", 500);
  const sessionId = optionalText(row.session_id, "data.session_id", 500);
  const upstreamId = optionalText(row.upstream_id, "data.upstream_id", 500);
  const serviceTier = optionalText(row.service_tier, "data.service_tier", 100);
  const region = optionalText(row.data_region, "data.data_region", 100);
  const apiType = optionalText(row.api_type, "data.api_type", 100);
  const cost = nonNegativeNumber(row.total_cost, "data.total_cost");

  let event = remoteEvent({
    collectorId: COLLECTOR_ID,
    collectorVersion: VERSION,
    runtime: "openrouter",
    sourceType: "openrouter.generation-api",
    sourceRecordId: generationId,
    observedAt: createdAt,
    requestId,
    sessionId,
    identity: {
      billing_platform: "openrouter",
      inference_provider: provider,
      requested_model: router ?? resolvedModel,
      resolved_model: resolvedModel,
      provider_model_id: providerModelId(row),
      service_tier: serviceTier,
      region,
      billing_mode: apiType
    },
    usage: usageFrom(row),
    timing: timingFrom(row),
    usageQuality: "provider_reported",
    timingQuality: row.generation_time === undefined || row.generation_time === null ? "unknown" : "provider_reported"
  });

  if (cost !== null) {
    const attached = createDefaultActualCostSourceRegistry().attach(event, {
      source_id: "openrouter-generation-api",
      amount: cost,
      currency: "USD",
      external_charge_id: generationId,
      reported_at: createdAt
    });
    event = sealTrustedActualChargeEvent(attached.event, attached.source.source_id);
  }

  return Object.freeze({ event, generation_id: generationId, upstream_id: upstreamId, provider_name: provider });
}
