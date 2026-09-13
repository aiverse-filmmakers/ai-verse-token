import { addFractions, compareFractions, decimalTextToFraction, fractionToExactDecimal, subtractFractions, zeroFraction } from "../cost/decimal.js";
import type { CostResult } from "../cost/types.js";
import type { UsageEvent } from "../protocol/types.js";
import { validateUsageEvent } from "../protocol/validation.js";
import { analyzeUsageTime } from "../time/index.js";
import type {
  BudgetDefinition,
  BudgetEvaluation,
  BudgetState,
  CostBudgetDefinition,
  NumericBudgetDefinition,
  QuotaWindowEvaluation,
  QuotaWindowSnapshot
} from "./types.js";

function parseNonNegativeDecimal(value: string, path: string): string {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error(`${path} must be a non-negative decimal string`);
  return value;
}

function bigintRatio(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) throw new Error("ratio denominator must be positive");
  const scale = 1_000_000_000n;
  return Number((numerator * scale) / denominator) / Number(scale);
}

function parseNonNegativeInteger(value: string, path: string): bigint {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`${path} must be a non-negative integer string`);
  return BigInt(value);
}

function warningFraction(value: number | undefined): number {
  const result = value ?? 0.8;
  if (!Number.isFinite(result) || result <= 0 || result >= 1) throw new Error("warning_fraction must be > 0 and < 1");
  return result;
}


function eventTokenTotal(event: UsageEvent): { lower: bigint; complete: boolean } {
  if (typeof event.usage.total_tokens_reported === "number") {
    return { lower: BigInt(event.usage.total_tokens_reported), complete: true };
  }
  const fields = [event.usage.input_tokens, event.usage.output_tokens, event.usage.reasoning_tokens,
    event.usage.cache_read_tokens, event.usage.cache_write_tokens, event.usage.cached_input_tokens];
  let lower = 0n;
  for (const value of fields) if (typeof value === "number") lower += BigInt(value);
  return { lower, complete: fields.every((value) => typeof value === "number") };
}

function numericBudget(events: readonly UsageEvent[], definition: NumericBudgetDefinition): BudgetEvaluation {
  const limit = parseNonNegativeInteger(definition.limit, "budget.limit");
  if (limit <= 0n) throw new Error("budget.limit must be greater than zero");
  let known = 0n;
  let complete = true;
  let unknown = 0;
  if (definition.metric === "requests") {
    known = BigInt(events.length);
  } else if (definition.metric === "total_tokens") {
    for (const event of events) {
      const total = eventTokenTotal(event);
      known += total.lower;
      if (!total.complete) { complete = false; unknown += 1; }
    }
  } else {
    const time = analyzeUsageTime(events).summary;
    if (definition.metric === "compute_ms") {
      known = BigInt(Math.trunc(time.compute_ms ?? 0));
      unknown = time.unknown_compute_request_count;
      complete = unknown === 0;
    } else {
      known = BigInt(Math.trunc(time.active_wall_ms ?? 0));
      unknown = events.length - time.interval_request_count;
      complete = unknown === 0;
    }
  }
  const utilization = bigintRatio(known, limit);
  const state = known >= limit ? "EXCEEDED" : !complete ? "UNKNOWN"
    : (utilization >= warningFraction(definition.warning_fraction) ? "WARNING" : "OK");
  const remaining = complete ? (known >= limit ? 0n : limit - known).toString() : null;
  return Object.freeze({
    budget_id: definition.budget_id,
    metric: definition.metric,
    state,
    known_used: known.toString(),
    limit: limit.toString(),
    remaining_if_complete: remaining,
    utilization_if_complete: complete ? utilization : null,
    complete,
    unknown_event_count: unknown
  });
}

function sumDecimals(values: readonly string[]): string {
  let total = zeroFraction();
  for (const value of values) total = addFractions(total, decimalTextToFraction(value));
  const result = fractionToExactDecimal(total);
  if (result === undefined) throw new Error("Cost budget total is not a finite decimal");
  return result;
}

function costBudget(events: readonly UsageEvent[], costs: readonly CostResult[], definition: CostBudgetDefinition): BudgetEvaluation {
  const limitText = parseNonNegativeDecimal(definition.limit, "budget.limit");
  const limitFraction = decimalTextToFraction(limitText);
  if (compareFractions(limitFraction, zeroFraction()) <= 0) throw new Error("budget.limit must be greater than zero");
  const ids = new Set(events.map((event) => event.event_id));
  const byEvent = new Map<string, CostResult>();
  for (const cost of costs) {
    if (!ids.has(cost.event_id)) continue;
    if (byEvent.has(cost.event_id)) throw new Error(`Duplicate cost result for event '${cost.event_id}'`);
    byEvent.set(cost.event_id, cost);
  }
  const included: string[] = [];
  let unknown = 0;
  for (const event of events) {
    const cost = byEvent.get(event.event_id);
    if (cost === undefined || cost.status === "UNKNOWN") { unknown += 1; continue; }
    if (cost.currency !== definition.currency) { unknown += 1; continue; }
    if (cost.status === "CALCULATED" && definition.include_calculated === false) { unknown += 1; continue; }
    included.push(cost.amount);
  }
  const knownUsed = sumDecimals(included);
  parseNonNegativeDecimal(knownUsed, "known cost");
  const knownFraction = decimalTextToFraction(knownUsed);
  const complete = unknown === 0;
  const comparison = compareFractions(knownFraction, limitFraction);
  const utilizationNumber = Number(knownUsed) / Number(limitText);
  const utilization = Number.isFinite(utilizationNumber) ? utilizationNumber : null;
  const state: BudgetState = comparison >= 0 ? "EXCEEDED" : !complete ? "UNKNOWN"
    : utilization !== null && utilization >= warningFraction(definition.warning_fraction) ? "WARNING" : "OK";
  const remainder = comparison >= 0 ? "0" : fractionToExactDecimal(subtractFractions(limitFraction, knownFraction));
  if (complete && remainder === undefined) throw new Error("Cost budget remainder is not a finite decimal");
  const remaining = complete ? remainder ?? null : null;
  return Object.freeze({
    budget_id: definition.budget_id,
    metric: "cost",
    state,
    known_used: knownUsed,
    limit: definition.limit,
    remaining_if_complete: remaining,
    utilization_if_complete: complete ? utilization : null,
    complete,
    currency: definition.currency,
    unknown_event_count: unknown
  });
}

export function evaluateBudget(
  values: readonly UsageEvent[],
  costs: readonly CostResult[],
  definition: BudgetDefinition
): BudgetEvaluation {
  const events = values.map((event) => validateUsageEvent(event));
  if (typeof definition.budget_id !== "string" || definition.budget_id.length < 1 || definition.budget_id.includes("\u0000")) {
    throw new Error("budget_id must be a non-empty string without NUL");
  }
  if (definition.metric === "cost") return costBudget(events, costs, definition);
  return numericBudget(events, definition);
}

export function evaluateQuotaWindows(snapshot: QuotaWindowSnapshot, warning = 0.8): readonly QuotaWindowEvaluation[] {
  if (!Number.isFinite(warning) || warning <= 0 || warning >= 1) throw new Error("warning must be > 0 and < 1");
  const observed = Date.parse(snapshot.observed_at);
  if (!Number.isFinite(observed)) throw new Error("quota observed_at must be a valid timestamp");
  const seen = new Set<string>();
  return Object.freeze(snapshot.windows.map((window) => {
    if (typeof window.kind !== "string" || window.kind.length < 1 || seen.has(window.kind)) throw new Error("quota window kinds must be unique non-empty strings");
    seen.add(window.kind);
    if (!Number.isFinite(window.used) || !Number.isFinite(window.limit) || window.used < 0 || window.limit <= 0) {
      throw new Error(`quota window '${window.kind}' has invalid used/limit`);
    }
    if (window.resets_at !== null && !Number.isFinite(Date.parse(window.resets_at))) throw new Error(`quota window '${window.kind}' has invalid resets_at`);
    const utilization = window.used / window.limit;
    const state = utilization >= 1 ? "EXCEEDED" : utilization >= warning ? "WARNING" : "OK";
    return Object.freeze({
      kind: window.kind,
      state,
      used: window.used,
      limit: window.limit,
      remaining: Math.max(0, window.limit - window.used),
      utilization,
      resets_at: window.resets_at
    });
  }));
}
