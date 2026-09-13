import type { UsageEvent } from "../protocol/types.js";
import type { UsageQueryFilter } from "../query/index.js";
import type { TokenReadApi } from "../read/index.js";

export const TOKEN_EXPORT_VERSION = "ai-verse-token-export/0.1" as const;
export const TOKEN_EXPORT_MAX_EVENTS = 50_000 as const;

export interface UsageExportOptions {
  readonly format: "json" | "csv";
  readonly filter?: UsageQueryFilter;
  readonly max_events?: number;
  readonly include_provenance_ids?: boolean;
  readonly exported_at?: string;
}

export interface PrivacySafeUsageEvent extends Omit<UsageEvent, "source" | "provenance"> {
  readonly source: Omit<UsageEvent["source"], "source_record_id">;
  readonly provenance: Omit<UsageEvent["provenance"], "source_record_fingerprint">;
}

function boundedMax(value: number | undefined): number {
  const result = value ?? 10_000;
  if (!Number.isSafeInteger(result) || result < 1 || result > TOKEN_EXPORT_MAX_EVENTS) {
    throw new Error(`max_events must be an integer in 1..${TOKEN_EXPORT_MAX_EVENTS}`);
  }
  return result;
}

function exportTimestamp(value: string | undefined): string {
  const result = value ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(result))) throw new Error("exported_at must be a valid ISO timestamp");
  return new Date(Date.parse(result)).toISOString();
}

export function privacySafeUsageEvent(event: UsageEvent): PrivacySafeUsageEvent {
  const { source_record_id: _sourceRecordId, ...source } = event.source;
  const { source_record_fingerprint: _fingerprint, ...provenance } = event.provenance;
  const actualCharge = event.actual_charge == null
    ? event.actual_charge
    : (() => {
        const { external_charge_id: _externalChargeId, ...safe } = event.actual_charge;
        return Object.freeze(safe);
      })();
  return Object.freeze({
    ...event,
    ...(actualCharge === undefined ? {} : { actual_charge: actualCharge }),
    source: Object.freeze(source),
    provenance: Object.freeze(provenance)
  });
}

function collect(reader: TokenReadApi, options: UsageExportOptions): readonly UsageEvent[] {
  const limit = boundedMax(options.max_events);
  const events: UsageEvent[] = [];
  let cursor: string | null = null;
  do {
    const page = reader.query({
      ...(options.filter === undefined ? {} : { filter: options.filter }),
      order: "asc",
      limit: Math.min(500, limit + 1 - events.length),
      cursor
    });
    events.push(...page.events);
    if (events.length > limit) throw new Error(`export exceeds max_events=${limit}; narrow the filter or raise the bounded limit`);
    cursor = page.hasMore ? page.nextCursor : null;
  } while (cursor !== null);
  return Object.freeze(events);
}

function csv(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CSV_COLUMNS = [
  "event_id", "observed_at", "request_id", "session_id", "run_id", "task_id",
  "runtime", "billing_platform", "inference_provider", "requested_model", "resolved_model", "service_tier",
  "workspace_id", "project_id", "agent_id", "bot_id", "worker_id",
  "context_input_tokens", "input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "cache_write_tokens", "cached_input_tokens",
  "wall_ms", "ttft_ms", "generation_ms",
  "actual_charge_amount", "actual_charge_currency", "actual_charge_source",
  "usage_quality", "timing_quality"
] as const;

function csvRow(event: UsageEvent): string {
  const values: Record<(typeof CSV_COLUMNS)[number], unknown> = {
    event_id: event.event_id,
    observed_at: event.observed_at,
    request_id: event.request_id,
    session_id: event.session_id,
    run_id: event.run_id,
    task_id: event.task_id,
    runtime: event.source.runtime,
    billing_platform: event.identity.billing_platform,
    inference_provider: event.identity.inference_provider,
    requested_model: event.identity.requested_model,
    resolved_model: event.identity.resolved_model,
    service_tier: event.identity.service_tier,
    workspace_id: event.scope?.workspace_id,
    project_id: event.scope?.project_id,
    agent_id: event.scope?.agent_id,
    bot_id: event.scope?.bot_id,
    worker_id: event.scope?.worker_id,
    context_input_tokens: event.usage.context_input_tokens,
    input_tokens: event.usage.input_tokens,
    output_tokens: event.usage.output_tokens,
    reasoning_tokens: event.usage.reasoning_tokens,
    cache_read_tokens: event.usage.cache_read_tokens,
    cache_write_tokens: event.usage.cache_write_tokens,
    cached_input_tokens: event.usage.cached_input_tokens,
    wall_ms: event.timing.wall_ms,
    ttft_ms: event.timing.ttft_ms,
    generation_ms: event.timing.generation_ms,
    actual_charge_amount: event.actual_charge?.amount,
    actual_charge_currency: event.actual_charge?.currency,
    actual_charge_source: event.actual_charge?.source,
    usage_quality: event.provenance.usage_quality,
    timing_quality: event.provenance.timing_quality
  };
  return CSV_COLUMNS.map((column) => csv(values[column])).join(",");
}

export function exportUsage(reader: TokenReadApi, options: UsageExportOptions): string {
  const events = collect(reader, options);
  if (options.format === "csv") {
    return `${CSV_COLUMNS.join(",")}\n${events.map(csvRow).join("\n")}${events.length > 0 ? "\n" : ""}`;
  }
  const projected = options.include_provenance_ids === true ? events : events.map(privacySafeUsageEvent);
  return JSON.stringify({
    schema_version: TOKEN_EXPORT_VERSION,
    exported_at: exportTimestamp(options.exported_at),
    event_count: events.length,
    events: projected
  }, null, 2);
}
