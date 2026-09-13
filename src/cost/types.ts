import type { ActualCharge, UsageEvent } from "../protocol/types.js";
import type { MonetaryRate, PriceFreshnessEvidence, PriceRateField } from "../pricing/index.js";

export const COST_UNKNOWN_REASONS = [
  "NON_AUTHORITATIVE_USAGE",
  "MISSING_EVENT_TIME",
  "MISSING_BILLING_PLATFORM",
  "MISSING_RESOLVED_MODEL",
  "NO_APPLICABLE_TARIFF",
  "MISSING_IDENTITY_DIMENSION",
  "MISSING_CONTEXT_INPUT",
  "MISSING_CACHE_TTL",
  "PRICING_NOT_AUTHORITATIVE",
  "TARIFF_AMBIGUOUS",
  "MISSING_USAGE_DIMENSION",
  "UNSUPPORTED_EXACT_DECIMAL"
] as const;

export type CostUnknownReason = (typeof COST_UNKNOWN_REASONS)[number];

export interface CostRatingContext {
  readonly now?: string | Date;
  readonly cache_ttl_seconds?: number | null;
  readonly freshness_evidence_by_source?: Readonly<Record<string, PriceFreshnessEvidence | undefined>>;
}

export interface CalculatedCostComponent {
  readonly rate_field: PriceRateField;
  readonly units: number;
  readonly rate: MonetaryRate;
  readonly amount: string;
}

export interface ActualCostResult {
  readonly status: "ACTUAL";
  readonly amount: string;
  readonly currency: string;
  readonly actual_charge: ActualCharge;
  readonly event_id: string;
}

export interface CalculatedCostResult {
  readonly status: "CALCULATED";
  readonly amount: string;
  readonly currency: string;
  readonly event_id: string;
  readonly event_time: string;
  readonly price_snapshot_id: string;
  readonly pricing_source_id: string;
  readonly components: readonly CalculatedCostComponent[];
}

export interface UnknownCostResult {
  readonly status: "UNKNOWN";
  readonly event_id: string;
  readonly reasons: readonly CostUnknownReason[];
  readonly candidate_price_snapshot_ids: readonly string[];
}

export type CostResult = ActualCostResult | CalculatedCostResult | UnknownCostResult;

export interface CostEngineInput {
  readonly event: UsageEvent | unknown;
  readonly price_snapshots: readonly unknown[];
  readonly context?: CostRatingContext;
}
