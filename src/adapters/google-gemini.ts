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

const COLLECTOR_ID = "google-gemini-generate-content";
const VERSION = "0.1.0";
export const GOOGLE_GEMINI_PRICING_SOURCE_ID = "google-gemini-official-pricing" as const;

export interface GoogleGeminiOptions {
  readonly observedAt: string;
  readonly requestedModel: string;
}

export interface GoogleGeminiNormalizationResult {
  readonly event: UsageEvent;
  readonly response_id: string;
  readonly model_version: string;
  readonly pricing_source_id: typeof GOOGLE_GEMINI_PRICING_SOURCE_ID;
}

function usageFrom(row: Record<string, unknown>): { usage: UsageCounts; serviceTier: string | null } {
  const usage = record(row.usageMetadata, "response.usageMetadata");
  const promptInclusive = nonNegativeInt(usage.promptTokenCount, "response.usageMetadata.promptTokenCount");
  const cached = nonNegativeInt(usage.cachedContentTokenCount, "response.usageMetadata.cachedContentTokenCount");
  const candidates = nonNegativeInt(usage.candidatesTokenCount, "response.usageMetadata.candidatesTokenCount");
  const thoughts = nonNegativeInt(usage.thoughtsTokenCount, "response.usageMetadata.thoughtsTokenCount");
  const total = nonNegativeInt(usage.totalTokenCount, "response.usageMetadata.totalTokenCount");
  if (promptInclusive === null || candidates === null) {
    throw new RemoteAdapterError("REMOTE_USAGE_INVALID", "response.usageMetadata must include promptTokenCount and candidatesTokenCount");
  }
  const cachedCount = cached ?? 0;
  if (cachedCount > promptInclusive) {
    throw new RemoteAdapterError("REMOTE_USAGE_INVALID", "Google cachedContentTokenCount exceeds promptTokenCount");
  }

  const knownMinimum = promptInclusive + candidates + (thoughts ?? 0);
  if (total !== null && total < knownMinimum) {
    throw new RemoteAdapterError("REMOTE_USAGE_INVALID", "Google totalTokenCount is smaller than known prompt/output/thought token counts");
  }

  return Object.freeze({
    usage: {
      context_input_tokens: promptInclusive,
      input_tokens: promptInclusive - cachedCount,
      output_tokens: candidates,
      ...(cached === null ? {} : { cached_input_tokens: cachedCount }),
      ...(thoughts === null ? {} : { reasoning_tokens: thoughts }),
      ...(total === null ? {} : { total_tokens_reported: total })
    },
    serviceTier: optionalText(usage.serviceTier, "response.usageMetadata.serviceTier", 100)
  });
}

export function normalizeGoogleGeminiResponse(value: unknown, options: GoogleGeminiOptions): GoogleGeminiNormalizationResult {
  const row = record(value, "response");
  const responseId = text(row.responseId, "response.responseId", 500);
  const modelVersion = text(row.modelVersion, "response.modelVersion", 500);
  const requestedModel = text(options.requestedModel, "options.requestedModel", 500).replace(/^models\//, "");
  const observedAt = iso(options.observedAt, "options.observedAt");
  const normalized = usageFrom(row);

  const event = remoteEvent({
    collectorId: COLLECTOR_ID,
    collectorVersion: VERSION,
    runtime: "google-gemini",
    sourceType: "google-gemini.generate-content",
    sourceRecordId: responseId,
    observedAt,
    requestId: responseId,
    identity: {
      billing_platform: "google",
      inference_provider: "google",
      requested_model: requestedModel,
      resolved_model: modelVersion.replace(/^models\//, ""),
      provider_model_id: modelVersion,
      service_tier: normalized.serviceTier
    },
    usage: normalized.usage,
    timing: {},
    usageQuality: "provider_reported",
    timingQuality: "unknown"
  });

  return Object.freeze({
    event,
    response_id: responseId,
    model_version: modelVersion,
    pricing_source_id: GOOGLE_GEMINI_PRICING_SOURCE_ID
  });
}
