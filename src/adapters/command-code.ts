import { createDefaultActualCostSourceRegistry } from "../cost/actual.js";
import type { UsageCounts, UsageEvent } from "../protocol/types.js";
import {
  RemoteAdapterError,
  aliasValue,
  nonNegativeInt,
  nonNegativeNumber,
  optionalIso,
  optionalText,
  record,
  remoteEvent,
  text,
  iso
} from "./common.js";

const COLLECTOR_ID = "commandcode-usage-api";
const VERSION = "0.1.0";

export interface CommandCodeUsageNormalizationResult {
  readonly event: UsageEvent;
  readonly usage_id: string;
}

export interface CommandCodeWindow {
  readonly kind: "five_hour" | "weekly" | "monthly";
  readonly used: number;
  readonly limit: number;
  readonly resets_at: string | null;
}

export interface CommandCodeUsageWindowSnapshot {
  readonly observed_at: string;
  readonly plan: string | null;
  readonly windows: readonly CommandCodeWindow[];
}

function numberAlias(row: Record<string, unknown>, aliases: readonly string[], path: string): number | null {
  return nonNegativeInt(aliasValue(row, aliases, path), path);
}

function usageFrom(row: Record<string, unknown>): UsageCounts {
  const nestedRaw = aliasValue(row, ["usage", "tokens"], "record.usage");
  const source = nestedRaw === undefined ? row : record(nestedRaw, "record.usage");
  const input = numberAlias(source, ["input", "input_tokens", "inputTokens"], "record.usage.input");
  const output = numberAlias(source, ["output", "output_tokens", "outputTokens"], "record.usage.output");
  const cacheRead = numberAlias(source, ["cacheRead", "cache_read_tokens", "cacheReadTokens", "cached", "cached_tokens"], "record.usage.cache_read");
  const cacheWrite = numberAlias(source, ["cacheWrite", "cache_write_tokens", "cacheWriteTokens"], "record.usage.cache_write");
  const reasoning = numberAlias(source, ["reasoning", "reasoning_tokens", "reasoningTokens"], "record.usage.reasoning");
  const total = numberAlias(source, ["total", "total_tokens", "totalTokens"], "record.usage.total");
  if (input === null && output === null && cacheRead === null && cacheWrite === null && reasoning === null && total === null) {
    throw new RemoteAdapterError("REMOTE_USAGE_INVALID", "Command Code usage record has no token counters");
  }
  return {
    ...(input === null ? {} : { input_tokens: input }),
    ...(output === null ? {} : { output_tokens: output }),
    ...(cacheRead === null ? {} : { cache_read_tokens: cacheRead }),
    ...(cacheWrite === null ? {} : { cache_write_tokens: cacheWrite }),
    ...(reasoning === null ? {} : { reasoning_tokens: reasoning }),
    ...(total === null ? {} : { total_tokens_reported: total })
  };
}

export function normalizeCommandCodeUsageRecord(value: unknown): CommandCodeUsageNormalizationResult {
  const row = record(value, "record");
  const usageId = text(aliasValue(row, ["id", "usageId", "usage_id", "requestId", "request_id"], "record.id"), "record.id", 500);
  const createdAt = iso(aliasValue(row, ["createdAt", "created_at", "timestamp"], "record.created_at"), "record.created_at");
  const model = text(aliasValue(row, ["model", "modelId", "model_id"], "record.model"), "record.model", 500);
  const provider = optionalText(aliasValue(row, ["provider", "providerId", "provider_id"], "record.provider"), "record.provider", 200);
  const sessionId = optionalText(aliasValue(row, ["sessionId", "session_id"], "record.session_id"), "record.session_id", 500);
  const serviceTier = optionalText(aliasValue(row, ["serviceTier", "service_tier"], "record.service_tier"), "record.service_tier", 100);
  const plan = optionalText(aliasValue(row, ["planType", "plan_type", "plan"], "record.plan"), "record.plan", 100);
  const cost = nonNegativeNumber(aliasValue(row, ["costUsd", "cost_usd", "totalCost", "total_cost", "cost"], "record.cost"), "record.cost");

  let event = remoteEvent({
    collectorId: COLLECTOR_ID,
    collectorVersion: VERSION,
    runtime: "commandcode",
    sourceType: "commandcode.usage-record",
    sourceRecordId: usageId,
    observedAt: createdAt,
    requestId: usageId,
    sessionId,
    identity: {
      billing_platform: "commandcode",
      inference_provider: provider,
      requested_model: model,
      resolved_model: model,
      service_tier: serviceTier,
      billing_mode: plan
    },
    usage: usageFrom(row),
    timing: {},
    usageQuality: "provider_reported",
    timingQuality: "unknown"
  });

  if (cost !== null) {
    event = createDefaultActualCostSourceRegistry().attach(event, {
      source_id: "commandcode-usage-api",
      amount: cost,
      currency: "USD",
      external_charge_id: usageId,
      reported_at: createdAt
    }).event;
  }

  return Object.freeze({ event, usage_id: usageId });
}

export function normalizeCommandCodeUsageWindows(value: unknown): CommandCodeUsageWindowSnapshot {
  const row = record(value, "usage_windows");
  const observedAt = iso(aliasValue(row, ["observed_at", "observedAt", "timestamp"], "usage_windows.observed_at"), "usage_windows.observed_at");
  const plan = optionalText(aliasValue(row, ["plan", "plan_type", "planType"], "usage_windows.plan"), "usage_windows.plan", 100);
  const rawWindows = row.windows;
  if (!Array.isArray(rawWindows) || rawWindows.length < 1 || rawWindows.length > 3) {
    throw new RemoteAdapterError("REMOTE_WINDOW_INVALID", "usage_windows.windows must contain 1..3 windows");
  }
  const seen = new Set<string>();
  const windows = rawWindows.map((raw, index): CommandCodeWindow => {
    const window = record(raw, `usage_windows.windows[${index}]`);
    const kind = text(window.kind, `usage_windows.windows[${index}].kind`, 20);
    if (kind !== "five_hour" && kind !== "weekly" && kind !== "monthly") {
      throw new RemoteAdapterError("REMOTE_WINDOW_INVALID", `usage_windows.windows[${index}].kind is unsupported`);
    }
    if (seen.has(kind)) throw new RemoteAdapterError("REMOTE_WINDOW_INVALID", `duplicate Command Code window '${kind}'`);
    seen.add(kind);
    const used = nonNegativeNumber(window.used, `usage_windows.windows[${index}].used`);
    const limit = nonNegativeNumber(window.limit, `usage_windows.windows[${index}].limit`);
    if (used === null || limit === null || limit <= 0 || used > limit) {
      throw new RemoteAdapterError("REMOTE_WINDOW_INVALID", `usage_windows.windows[${index}] has invalid used/limit`);
    }
    const resetsAt = optionalIso(window.resets_at ?? window.resetsAt, `usage_windows.windows[${index}].resets_at`);
    return Object.freeze({ kind, used, limit, resets_at: resetsAt });
  });
  return Object.freeze({ observed_at: observedAt, plan, windows: Object.freeze(windows) });
}
