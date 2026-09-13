import type { UsageCounts, UsageEvent, UsageIdentity } from "../protocol/types.js";
import { validateUsageEvent } from "../protocol/validation.js";
import {
  PRICE_RATE_FIELDS,
  type PriceRateField,
  type PriceSnapshot,
  type PricingSourceRegistry,
  type PriceFreshnessEvidence,
  validatePriceSnapshot
} from "../pricing/index.js";
import {
  addFractions,
  fractionToExactDecimal,
  multiplyRate,
  zeroFraction
} from "./decimal.js";
import type {
  CalculatedCostComponent,
  CostEngineInput,
  CostRatingContext,
  CostResult,
  CostUnknownReason,
  UnknownCostResult
} from "./types.js";

const AUTHORITATIVE_USAGE = new Set(["provider_reported", "runtime_reported", "derived_exact"]);
const OPTIONAL_IDENTITY_FIELDS = [
  "inference_provider",
  "provider_model_id",
  "service_tier",
  "region",
  "billing_mode"
] as const;

type OptionalIdentityField = (typeof OPTIONAL_IDENTITY_FIELDS)[number];


function sameUtcDay(leftMs: number, rightMs: number): boolean {
  const left = new Date(leftMs);
  const right = new Date(rightMs);
  return left.getUTCFullYear() === right.getUTCFullYear()
    && left.getUTCMonth() === right.getUTCMonth()
    && left.getUTCDate() === right.getUTCDate();
}

function weekdayUtc(ms: number): "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat" {
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(ms).getUTCDay()] as
    "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
}

function timeSecondsUtc(ms: number): number {
  const date = new Date(ms);
  return date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds();
}

function timeToSeconds(value: string): number {
  const parts = value.split(":").map(Number);
  return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
}

function effectiveAt(snapshot: PriceSnapshot, eventMs: number): boolean {
  const starts = Date.parse(snapshot.effective.starts_at);
  const ends = snapshot.effective.ends_at === undefined ? undefined : Date.parse(snapshot.effective.ends_at);
  if (eventMs < starts || (ends !== undefined && eventMs >= ends)) return false;
  if (snapshot.effective.weekdays_utc !== undefined && !snapshot.effective.weekdays_utc.includes(weekdayUtc(eventMs))) {
    return false;
  }
  if (snapshot.effective.utc_time_windows !== undefined) {
    const seconds = timeSecondsUtc(eventMs);
    if (!snapshot.effective.utc_time_windows.some((window) => {
      const start = timeToSeconds(window.start);
      const end = timeToSeconds(window.end);
      return seconds >= start && seconds < end;
    })) return false;
  }
  return true;
}

function identityBaseMatches(snapshot: PriceSnapshot, identity: UsageIdentity): boolean {
  return snapshot.identity.billing_platform === identity.billing_platform
    && snapshot.identity.resolved_model === identity.resolved_model;
}

function eventIdentityValue(identity: UsageIdentity, field: OptionalIdentityField): string | undefined {
  const value = identity[field];
  return typeof value === "string" ? value : undefined;
}

function identitySpecificity(snapshot: PriceSnapshot): number {
  let score = 0;
  for (const field of OPTIONAL_IDENTITY_FIELDS) {
    if (snapshot.identity[field] !== undefined) score += 1;
  }
  return score;
}

function unknown(eventId: string, reasons: readonly CostUnknownReason[], candidates: readonly PriceSnapshot[] = []): UnknownCostResult {
  return Object.freeze({
    status: "UNKNOWN",
    event_id: eventId,
    reasons: Object.freeze([...new Set(reasons)]),
    candidate_price_snapshot_ids: Object.freeze(candidates.map((candidate) => candidate.price_snapshot_id).sort())
  });
}

function contextBasisValue(snapshot: PriceSnapshot, usage: UsageCounts): number | undefined {
  const condition = snapshot.conditions?.context;
  if (condition === undefined) return 0;
  if (condition.basis === "input_tokens") {
    if (typeof usage.context_input_tokens === "number") return usage.context_input_tokens;
    return typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  }
  if (condition.basis === "input_plus_cache_read_tokens") {
    if (typeof usage.context_input_tokens === "number") return usage.context_input_tokens;
    if (typeof usage.input_tokens !== "number" || typeof usage.cache_read_tokens !== "number") return undefined;
    return usage.input_tokens + usage.cache_read_tokens;
  }
  return undefined;
}

function inBounds(value: number, min: number | undefined, max: number | undefined): boolean {
  return (min === undefined || value >= min) && (max === undefined || value < max);
}

function sourceAuthorityRank(authority: string): number {
  if (authority === "provider_pricing_api") return 3;
  if (authority === "official_public_pricing") return 2;
  return 1;
}

function verificationRank(status: string): number {
  if (status === "cross_checked") return 2;
  if (status === "verified") return 1;
  return 0;
}

function sourceTuple(snapshot: PriceSnapshot): readonly [number, number, number] {
  return [
    sourceAuthorityRank(snapshot.source.authority),
    verificationRank(snapshot.verification.status),
    Date.parse(snapshot.source.retrieved_at)
  ] as const;
}

function compareTuple(left: readonly [number, number, number], right: readonly [number, number, number]): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function tariffSignature(snapshot: PriceSnapshot): string {
  return JSON.stringify({ currency: snapshot.currency, rates: snapshot.rates });
}

function freshnessEvidence(context: CostRatingContext, sourceId: string): PriceFreshnessEvidence | undefined {
  return context.freshness_evidence_by_source?.[sourceId];
}

function isAuthoritativeSnapshot(
  registry: PricingSourceRegistry,
  snapshot: PriceSnapshot,
  eventMs: number,
  nowMs: number,
  context: CostRatingContext
): boolean {
  if (sameUtcDay(eventMs, nowMs)) {
    return registry.assess(snapshot, new Date(nowMs), freshnessEvidence(context, snapshot.source.source_id))
      .can_authorize_calculated_cost;
  }

  // Historical snapshots do not become invalid merely because today's source has changed.
  // Re-assessing at retrieval time still enforces registered source identity, authority,
  // platform scope and verification while avoiding silent repricing with today's tariff.
  return registry.assess(snapshot, new Date(Date.parse(snapshot.source.retrieved_at)))
    .can_authorize_calculated_cost;
}

function selectTariff(
  event: UsageEvent,
  snapshots: readonly PriceSnapshot[],
  registry: PricingSourceRegistry,
  context: CostRatingContext,
  eventMs: number,
  nowMs: number
): CostResult | PriceSnapshot {
  const base = snapshots.filter((snapshot) => identityBaseMatches(snapshot, event.identity) && effectiveAt(snapshot, eventMs));
  if (base.length === 0) return unknown(event.event_id, ["NO_APPLICABLE_TARIFF"]);

  let candidates = base;
  for (const field of OPTIONAL_IDENTITY_FIELDS) {
    const eventValue = eventIdentityValue(event.identity, field);
    const hasSpecific = candidates.some((candidate) => candidate.identity[field] !== undefined);
    if (eventValue === undefined && hasSpecific) {
      return unknown(event.event_id, ["MISSING_IDENTITY_DIMENSION"], candidates);
    }
    if (eventValue !== undefined) {
      candidates = candidates.filter((candidate) => candidate.identity[field] === undefined || candidate.identity[field] === eventValue);
      if (candidates.length === 0) return unknown(event.event_id, ["NO_APPLICABLE_TARIFF"], base);
    }
  }

  const hasContextCondition = candidates.some((candidate) => candidate.conditions?.context !== undefined);
  if (hasContextCondition) {
    const missingContext = candidates.some((candidate) => candidate.conditions?.context !== undefined
      && contextBasisValue(candidate, event.usage) === undefined);
    if (missingContext) return unknown(event.event_id, ["MISSING_CONTEXT_INPUT"], candidates);
    candidates = candidates.filter((candidate) => {
      const condition = candidate.conditions?.context;
      if (condition === undefined) return true;
      const value = contextBasisValue(candidate, event.usage);
      return value !== undefined && inBounds(value, condition.min_inclusive, condition.max_exclusive);
    });
  }

  const hasTtlCondition = candidates.some((candidate) => candidate.conditions?.cache_ttl !== undefined);
  if (hasTtlCondition && typeof context.cache_ttl_seconds !== "number") {
    return unknown(event.event_id, ["MISSING_CACHE_TTL"], candidates);
  }
  if (hasTtlCondition) {
    const ttl = context.cache_ttl_seconds as number;
    candidates = candidates.filter((candidate) => {
      const condition = candidate.conditions?.cache_ttl;
      return condition === undefined || inBounds(ttl, condition.min_seconds_inclusive, condition.max_seconds_exclusive);
    });
  }

  if (candidates.length === 0) return unknown(event.event_id, ["NO_APPLICABLE_TARIFF"], base);

  const maxSpecificity = Math.max(...candidates.map((candidate) =>
    identitySpecificity(candidate)
    + (candidate.conditions?.context === undefined ? 0 : 1)
    + (candidate.conditions?.cache_ttl === undefined ? 0 : 1)
  ));
  candidates = candidates.filter((candidate) =>
    identitySpecificity(candidate)
    + (candidate.conditions?.context === undefined ? 0 : 1)
    + (candidate.conditions?.cache_ttl === undefined ? 0 : 1) === maxSpecificity
  );

  const authorized = candidates.filter((candidate) =>
    isAuthoritativeSnapshot(registry, candidate, eventMs, nowMs, context)
  );
  if (authorized.length === 0) return unknown(event.event_id, ["PRICING_NOT_AUTHORITATIVE"], candidates);

  let bestTuple = sourceTuple(authorized[0] as PriceSnapshot);
  for (const candidate of authorized.slice(1)) {
    const tuple = sourceTuple(candidate);
    if (compareTuple(tuple, bestTuple) > 0) bestTuple = tuple;
  }
  const best = authorized.filter((candidate) => compareTuple(sourceTuple(candidate), bestTuple) === 0);
  if (best.length > 1) {
    const signatures = new Set(best.map(tariffSignature));
    if (signatures.size > 1) return unknown(event.event_id, ["TARIFF_AMBIGUOUS"], best);
  }

  return best.slice().sort((a, b) => a.price_snapshot_id.localeCompare(b.price_snapshot_id))[0] as PriceSnapshot;
}

function calculate(event: UsageEvent, snapshot: PriceSnapshot, eventTime: string): CostResult {
  let total = zeroFraction();
  const components: CalculatedCostComponent[] = [];

  for (const field of PRICE_RATE_FIELDS) {
    const rate = snapshot.rates[field];
    if (rate === undefined) continue;
    const units = event.usage[field as keyof UsageCounts];
    if (typeof units !== "number") {
      return unknown(event.event_id, ["MISSING_USAGE_DIMENSION"], [snapshot]);
    }

    let fraction;
    try {
      fraction = multiplyRate(rate.amount, units, rate.per);
    } catch {
      return unknown(event.event_id, ["UNSUPPORTED_EXACT_DECIMAL"], [snapshot]);
    }
    const amount = fractionToExactDecimal(fraction);
    if (amount === undefined) return unknown(event.event_id, ["UNSUPPORTED_EXACT_DECIMAL"], [snapshot]);
    total = addFractions(total, fraction);
    components.push(Object.freeze({ rate_field: field as PriceRateField, units, rate, amount }));
  }

  const amount = fractionToExactDecimal(total);
  if (amount === undefined) return unknown(event.event_id, ["UNSUPPORTED_EXACT_DECIMAL"], [snapshot]);

  return Object.freeze({
    status: "CALCULATED",
    amount,
    currency: snapshot.currency,
    event_id: event.event_id,
    event_time: eventTime,
    price_snapshot_id: snapshot.price_snapshot_id,
    pricing_source_id: snapshot.source.source_id,
    components: Object.freeze(components)
  });
}

export class CostEngine {
  readonly #registry: PricingSourceRegistry;

  constructor(registry: PricingSourceRegistry) {
    this.#registry = registry;
  }

  rate(input: CostEngineInput): CostResult {
    const event = validateUsageEvent(input.event);
    const snapshots = input.price_snapshots.map((snapshot) => validatePriceSnapshot(snapshot));
    const context = input.context ?? {};

    if (event.actual_charge !== undefined && event.actual_charge !== null) {
      return Object.freeze({
        status: "ACTUAL",
        amount: event.actual_charge.amount,
        currency: event.actual_charge.currency,
        actual_charge: event.actual_charge,
        event_id: event.event_id
      });
    }

    if (!AUTHORITATIVE_USAGE.has(event.provenance.usage_quality)) {
      return unknown(event.event_id, ["NON_AUTHORITATIVE_USAGE"]);
    }
    if (event.identity.billing_platform === null) {
      return unknown(event.event_id, ["MISSING_BILLING_PLATFORM"]);
    }
    if (event.identity.resolved_model === null) {
      return unknown(event.event_id, ["MISSING_RESOLVED_MODEL"]);
    }
    if (typeof event.timing.started_at !== "string") {
      return unknown(event.event_id, ["MISSING_EVENT_TIME"]);
    }

    const eventMs = Date.parse(event.timing.started_at);
    const nowValue = context.now ?? new Date();
    const nowMs = nowValue instanceof Date ? nowValue.getTime() : Date.parse(nowValue);
    if (!Number.isFinite(nowMs)) throw new TypeError("context.now must be a valid date-time");

    const selected = selectTariff(event, snapshots, this.#registry, context, eventMs, nowMs);
    if ("status" in selected) return selected;
    return calculate(event, selected, event.timing.started_at);
  }
}
