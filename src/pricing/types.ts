import type {
  PRICE_CONTEXT_BASES,
  PRICE_RATE_FIELDS,
  PRICE_SOURCE_AUTHORITIES,
  PRICE_VERIFICATION_STATUSES,
  PRICE_WEEKDAYS
} from "./constants.js";

export type PriceSourceAuthority = (typeof PRICE_SOURCE_AUTHORITIES)[number];
export type PriceVerificationStatus = (typeof PRICE_VERIFICATION_STATUSES)[number];
export type PriceWeekday = (typeof PRICE_WEEKDAYS)[number];
export type PriceContextBasis = (typeof PRICE_CONTEXT_BASES)[number];
export type PriceRateField = (typeof PRICE_RATE_FIELDS)[number];

/**
 * Exact non-negative decimal text. Floating-point money is deliberately
 * excluded from the canonical price protocol.
 */
export type DecimalMoney = string;

export interface MonetaryRate {
  readonly amount: DecimalMoney;
  readonly per: number;
}

export interface PriceIdentity {
  readonly billing_platform: string;
  readonly resolved_model: string;
  readonly inference_provider?: string;
  readonly provider_model_id?: string;
  readonly service_tier?: string;
  readonly region?: string;
  readonly billing_mode?: string;
}

export interface PriceEffectiveInterval {
  /** Inclusive. */
  readonly starts_at: string;
  /** Exclusive when present. */
  readonly ends_at?: string;
  readonly weekdays_utc?: readonly PriceWeekday[];
  readonly utc_time_windows?: readonly UtcTimeWindow[];
}

export interface UtcTimeWindow {
  /** Inclusive HH:MM or HH:MM:SS in UTC. */
  readonly start: string;
  /** Exclusive HH:MM or HH:MM:SS in UTC. Must be later than start. */
  readonly end: string;
}

export interface PriceContextCondition {
  readonly basis: PriceContextBasis;
  readonly min_inclusive?: number;
  readonly max_exclusive?: number;
}

export interface PriceCacheTtlCondition {
  readonly min_seconds_inclusive?: number;
  readonly max_seconds_exclusive?: number;
}

export interface PriceConditions {
  readonly context?: PriceContextCondition;
  readonly cache_ttl?: PriceCacheTtlCondition;
}

export type PriceRates = Partial<Record<PriceRateField, MonetaryRate>>;

export interface PriceSourceProvenance {
  readonly authority: PriceSourceAuthority;
  readonly source_id: string;
  readonly source_url?: string;
  readonly retrieved_at: string;
  readonly published_at?: string;
  readonly etag?: string;
  readonly content_digest_sha256?: string;
}

export interface PriceVerification {
  readonly status: PriceVerificationStatus;
  readonly verified_at?: string;
}

export interface PriceSnapshot {
  readonly schema_version: "ai-verse-token-price/0.1";
  readonly price_snapshot_id: string;
  readonly identity: PriceIdentity;
  readonly currency: string;
  readonly effective: PriceEffectiveInterval;
  readonly conditions?: PriceConditions;
  readonly rates: PriceRates;
  readonly source: PriceSourceProvenance;
  readonly verification: PriceVerification;
  readonly supersedes_price_snapshot_id?: string;
}
