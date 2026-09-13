import { addFractions, decimalTextToFraction, fractionToExactDecimal, zeroFraction } from "../cost/decimal.js";
import type { CostResult } from "../cost/types.js";
import type { UsageEvent } from "../protocol/types.js";
import { validateUsageEvent } from "../protocol/validation.js";
import { analyzeUsageTime, requestTimeMetrics } from "../time/index.js";
import type {
  CostCoverage,
  CurrencyCostTotals,
  EfficiencyAnalysis,
  EfficiencyGroupDimension,
  EfficiencyGroupRow,
  EfficiencyInput,
  EfficiencyMetrics,
  ExactIntegerMetric,
  RatioMetric,
  RetryLink,
  RetryTax
} from "./types.js";

function exactInteger(value: bigint): string {
  return value.toString();
}

function eventTotal(event: UsageEvent): { lower: bigint; complete: boolean } {
  const reported = event.usage.total_tokens_reported;
  if (typeof reported === "number") return { lower: BigInt(reported), complete: true };
  const fields = [
    event.usage.input_tokens,
    event.usage.output_tokens,
    event.usage.reasoning_tokens,
    event.usage.cache_read_tokens,
    event.usage.cache_write_tokens,
    event.usage.cached_input_tokens
  ];
  const lower = fields.reduce<bigint>((sum, value) => sum + (typeof value === "number" ? BigInt(value) : 0n), 0n);
  return { lower, complete: fields.every((value) => typeof value === "number") };
}

function totalTokens(events: readonly UsageEvent[]): ExactIntegerMetric {
  let lower = 0n;
  let unknown = 0;
  for (const event of events) {
    const total = eventTotal(event);
    lower += total.lower;
    if (!total.complete) unknown += 1;
  }
  return Object.freeze({ known_lower_bound: exactInteger(lower), complete: unknown === 0, unknown_event_count: unknown });
}

function ratio(
  events: readonly UsageEvent[],
  numerator: (event: UsageEvent) => number | undefined | null,
  denominatorParts: (event: UsageEvent) => readonly (number | undefined | null)[]
): RatioMetric {
  let numeratorTotal = 0n;
  let denominatorTotal = 0n;
  let unknown = 0;
  for (const event of events) {
    const numeratorValue = numerator(event);
    const parts = denominatorParts(event);
    const complete = typeof numeratorValue === "number" && parts.every((value) => typeof value === "number");
    if (!complete) unknown += 1;
    if (typeof numeratorValue === "number") numeratorTotal += BigInt(numeratorValue);
    for (const part of parts) if (typeof part === "number") denominatorTotal += BigInt(part);
  }
  const value = unknown === 0 && denominatorTotal > 0n
    ? Number(numeratorTotal) / Number(denominatorTotal)
    : unknown === 0 && denominatorTotal === 0n ? 0 : null;
  return Object.freeze({
    value,
    numerator_lower_bound: exactInteger(numeratorTotal),
    denominator_lower_bound: exactInteger(denominatorTotal),
    complete: unknown === 0,
    unknown_event_count: unknown
  });
}

function sumExactDecimals(values: readonly string[]): string {
  let total = zeroFraction();
  for (const value of values) total = addFractions(total, decimalTextToFraction(value));
  const exact = fractionToExactDecimal(total);
  if (exact === undefined) throw new Error("Cost total cannot be represented as an exact decimal");
  return exact;
}

function costCoverage(events: readonly UsageEvent[], costs: readonly CostResult[]): CostCoverage {
  const eventIds = new Set(events.map((event) => event.event_id));
  const relevant = costs.filter((cost) => eventIds.has(cost.event_id));
  const byEvent = new Map<string, CostResult>();
  for (const cost of relevant) {
    if (byEvent.has(cost.event_id)) throw new Error(`Duplicate cost result for event '${cost.event_id}'`);
    byEvent.set(cost.event_id, cost);
  }
  let actualCount = 0;
  let calculatedCount = 0;
  let unknownCount = 0;
  const currencies = new Map<string, { actual: string[]; calculated: string[] }>();
  for (const event of events) {
    const cost = byEvent.get(event.event_id);
    if (cost === undefined || cost.status === "UNKNOWN") {
      unknownCount += 1;
      continue;
    }
    const target = currencies.get(cost.currency) ?? { actual: [], calculated: [] };
    if (cost.status === "ACTUAL") {
      actualCount += 1;
      target.actual.push(cost.amount);
    } else {
      calculatedCount += 1;
      target.calculated.push(cost.amount);
    }
    currencies.set(cost.currency, target);
  }
  const rows: CurrencyCostTotals[] = [...currencies.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, totals]) => {
    const actual = sumExactDecimals(totals.actual);
    const calculated = sumExactDecimals(totals.calculated);
    return Object.freeze({
      currency,
      actual,
      calculated,
      known_total: sumExactDecimals([actual, calculated])
    });
  });
  return Object.freeze({
    by_currency: Object.freeze(rows),
    actual_event_count: actualCount,
    calculated_event_count: calculatedCount,
    unknown_event_count: unknownCount,
    complete: unknownCount === 0
  });
}

function metrics(events: readonly UsageEvent[], costs: readonly CostResult[]): EfficiencyMetrics {
  const time = analyzeUsageTime(events).summary;
  return Object.freeze({
    request_count: events.length,
    total_tokens: totalTokens(events),
    cache_read_ratio: ratio(
      events,
      (event) => event.usage.cache_read_tokens ?? event.usage.cached_input_tokens,
      (event) => [event.usage.input_tokens, event.usage.cache_read_tokens ?? event.usage.cached_input_tokens]
    ),
    reasoning_share: ratio(
      events,
      (event) => event.usage.reasoning_tokens,
      (event) => [event.usage.output_tokens, event.usage.reasoning_tokens]
    ),
    compute_ms_known: time.compute_ms ?? 0,
    compute_time_complete: time.unknown_compute_request_count === 0,
    active_wall_ms_known: time.active_wall_ms ?? 0,
    active_wall_time_complete: time.interval_request_count === events.length,
    costs: costCoverage(events, costs)
  });
}

function dimensionValue(event: UsageEvent, dimension: EfficiencyGroupDimension): string | null {
  switch (dimension) {
    case "session_id": return event.session_id ?? null;
    case "task_id": return event.task_id ?? null;
    case "runtime": return event.source.runtime;
    case "billing_platform": return event.identity.billing_platform;
    case "inference_provider": return event.identity.inference_provider ?? null;
    case "resolved_model": return event.identity.resolved_model;
    case "workspace_id": return event.scope?.workspace_id ?? null;
    case "project_id": return event.scope?.project_id ?? null;
    case "agent_id": return event.scope?.agent_id ?? null;
    case "bot_id": return event.scope?.bot_id ?? null;
    case "worker_id": return event.scope?.worker_id ?? null;
  }
}

function groupRows(events: readonly UsageEvent[], costs: readonly CostResult[], dimension?: EfficiencyGroupDimension): readonly EfficiencyGroupRow[] {
  if (dimension === undefined) return Object.freeze([]);
  const groups = new Map<string, { key: string | null; events: UsageEvent[] }>();
  for (const event of events) {
    const key = dimensionValue(event, dimension);
    const mapKey = key === null ? "\u0000" : `v:${key}`;
    const group = groups.get(mapKey) ?? { key, events: [] };
    group.events.push(event);
    groups.set(mapKey, group);
  }
  return Object.freeze([...groups.values()]
    .sort((a, b) => (a.key ?? "").localeCompare(b.key ?? ""))
    .map((group) => Object.freeze({ dimension, key: group.key, metrics: metrics(group.events, costs) })));
}

function validateRetryLinks(events: readonly UsageEvent[], links: readonly RetryLink[]): readonly UsageEvent[] {
  const byId = new Map(events.map((event) => [event.event_id, event]));
  const retryIds = new Set<string>();
  const direct = new Map<string, string>();
  for (const link of links) {
    if (link.retry_event_id === link.original_event_id) throw new Error("Retry event cannot reference itself");
    if (!byId.has(link.retry_event_id) || !byId.has(link.original_event_id)) throw new Error("Retry link references an unknown event");
    if (retryIds.has(link.retry_event_id)) throw new Error(`Duplicate retry link for '${link.retry_event_id}'`);
    retryIds.add(link.retry_event_id);
    direct.set(link.retry_event_id, link.original_event_id);
  }
  for (const retryId of retryIds) {
    const seen = new Set<string>([retryId]);
    let cursor = direct.get(retryId);
    while (cursor !== undefined) {
      if (seen.has(cursor)) throw new Error("Retry links contain a cycle");
      seen.add(cursor);
      cursor = direct.get(cursor);
    }
  }
  return Object.freeze([...retryIds].map((id) => byId.get(id)!));
}

function retryTax(events: readonly UsageEvent[], costs: readonly CostResult[], links: readonly RetryLink[]): RetryTax {
  const retries = validateRetryLinks(events, links);
  const walls = retries.map(requestTimeMetrics);
  const known = walls.filter((metric) => metric.wall_ms !== null);
  return Object.freeze({
    retry_request_count: retries.length,
    total_tokens: totalTokens(retries),
    compute_ms_known: known.reduce((sum, metric) => sum + (metric.wall_ms ?? 0), 0),
    compute_time_complete: known.length === retries.length,
    costs: costCoverage(retries, costs)
  });
}

export function analyzeEfficiency(input: EfficiencyInput): EfficiencyAnalysis {
  const events = input.events.map((event) => validateUsageEvent(event));
  const costs = input.costs ?? [];
  const costIds = new Set(events.map((event) => event.event_id));
  for (const cost of costs) if (!costIds.has(cost.event_id)) throw new Error(`Cost result references unknown event '${cost.event_id}'`);
  return Object.freeze({
    overall: metrics(events, costs),
    groups: groupRows(events, costs, input.group_by),
    retry_tax: retryTax(events, costs, input.retry_links ?? [])
  });
}
