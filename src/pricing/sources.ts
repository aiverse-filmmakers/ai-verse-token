import {
  PRICE_SOURCE_AUTHORITIES
} from "./constants.js";
import type {
  PriceSnapshot,
  PriceSourceAuthority,
  PriceVerificationStatus
} from "./types.js";
import { validatePriceSnapshot } from "./validation.js";

const DEFAULT_MAX_FUTURE_SKEW_SECONDS = 300;
const DAY_SECONDS = 24 * 60 * 60;
const WEEK_SECONDS = 7 * DAY_SECONDS;

export type PricingPlatformScope = readonly string[] | "*";

export interface PricingFreshnessPolicy {
  readonly max_age_seconds: number;
  readonly require_same_utc_day: boolean;
  readonly max_future_skew_seconds?: number;
}

export interface PricingSourceDefinition {
  readonly source_id: string;
  readonly authority: PriceSourceAuthority;
  readonly billing_platforms: PricingPlatformScope;
  readonly freshness: PricingFreshnessPolicy;
}

export type PriceFreshnessStatus = "fresh" | "stale" | "future";

export interface PriceFreshnessEvidence {
  readonly checked_at: string;
  readonly etag?: string;
  readonly content_digest_sha256?: string;
}

export type PriceSourceAssessmentReason =
  | "UNKNOWN_SOURCE"
  | "SOURCE_AUTHORITY_MISMATCH"
  | "PLATFORM_UNSUPPORTED"
  | "SOURCE_STALE"
  | "SOURCE_FUTURE"
  | "VERIFICATION_INSUFFICIENT"
  | "SECONDARY_DISCOVERY_ONLY";

export interface PriceSourceAssessment {
  readonly source_id: string;
  readonly known_source: boolean;
  readonly declared_authority: PriceSourceAuthority;
  readonly registered_authority?: PriceSourceAuthority;
  readonly freshness: PriceFreshnessStatus;
  readonly age_seconds: number;
  readonly verification_status: PriceVerificationStatus;
  readonly freshness_basis: "snapshot_retrieval" | "source_recheck";
  readonly can_authorize_calculated_cost: boolean;
  readonly reasons: readonly PriceSourceAssessmentReason[];
}

export class PricingSourceRegistryError extends Error {
  readonly code = "PRICING_SOURCE_REGISTRY_INVALID" as const;
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "PricingSourceRegistryError";
    this.path = path;
  }
}

function fail(path: string, message: string): never {
  throw new PricingSourceRegistryError(path, message);
}

function string(value: unknown, path: string, max = 500): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    fail(path, `must be a non-empty string up to ${max} characters`);
  }
  if (value.includes("\u0000")) fail(path, "must not contain NUL");
  return value;
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(path, `must be one of: ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function positiveSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(path, "must be a positive safe integer");
  }
  return value as number;
}

function nonNegativeSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(path, "must be a non-negative safe integer");
  }
  return value as number;
}

function validateDefinition(value: PricingSourceDefinition, index: number): PricingSourceDefinition {
  const path = `sources[${index}]`;
  const sourceId = string(value.source_id, `${path}.source_id`, 200);
  const authority = oneOf(value.authority, PRICE_SOURCE_AUTHORITIES, `${path}.authority`);

  let platforms: PricingPlatformScope;
  if (value.billing_platforms === "*") {
    platforms = "*";
  } else {
    if (!Array.isArray(value.billing_platforms) || value.billing_platforms.length === 0) {
      fail(`${path}.billing_platforms`, "must be '*' or a non-empty platform list");
    }
    const parsed = value.billing_platforms.map((platform, platformIndex) =>
      string(platform, `${path}.billing_platforms[${platformIndex}]`, 200)
    );
    if (new Set(parsed).size !== parsed.length) {
      fail(`${path}.billing_platforms`, "must not contain duplicates");
    }
    platforms = Object.freeze(parsed);
  }

  if (typeof value.freshness !== "object" || value.freshness === null) {
    fail(`${path}.freshness`, "must be an object");
  }
  const maxAge = positiveSafeInteger(value.freshness.max_age_seconds, `${path}.freshness.max_age_seconds`);
  if (typeof value.freshness.require_same_utc_day !== "boolean") {
    fail(`${path}.freshness.require_same_utc_day`, "must be boolean");
  }
  const skew = value.freshness.max_future_skew_seconds === undefined
    ? DEFAULT_MAX_FUTURE_SKEW_SECONDS
    : nonNegativeSafeInteger(value.freshness.max_future_skew_seconds, `${path}.freshness.max_future_skew_seconds`);

  return Object.freeze({
    source_id: sourceId,
    authority,
    billing_platforms: platforms,
    freshness: Object.freeze({
      max_age_seconds: maxAge,
      require_same_utc_day: value.freshness.require_same_utc_day,
      max_future_skew_seconds: skew
    })
  });
}

function sameUtcDay(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

function toNowMs(now: string | Date): number {
  const ms = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(ms)) fail("now", "must be a valid date-time");
  return ms;
}

function authorityRank(authority: PriceSourceAuthority): number {
  switch (authority) {
    case "provider_pricing_api": return 300;
    case "official_public_pricing": return 200;
    case "secondary_catalog": return 100;
  }
}

function verificationRank(status: PriceVerificationStatus): number {
  switch (status) {
    case "cross_checked": return 40;
    case "verified": return 30;
    case "unverified": return 10;
    case "disputed": return 0;
  }
}

function platformSupported(scope: PricingPlatformScope, billingPlatform: string): boolean {
  return scope === "*" || scope.includes(billingPlatform);
}

export const FIRST_RELEASE_PRICING_SOURCES: readonly PricingSourceDefinition[] = Object.freeze([
  {
    source_id: "openai-official-pricing",
    authority: "official_public_pricing",
    billing_platforms: ["openai"],
    freshness: { max_age_seconds: DAY_SECONDS, require_same_utc_day: true }
  },
  {
    source_id: "anthropic-official-pricing",
    authority: "official_public_pricing",
    billing_platforms: ["anthropic"],
    freshness: { max_age_seconds: DAY_SECONDS, require_same_utc_day: true }
  },
  {
    source_id: "google-gemini-official-pricing",
    authority: "official_public_pricing",
    billing_platforms: ["google"],
    freshness: { max_age_seconds: DAY_SECONDS, require_same_utc_day: true }
  },
  {
    source_id: "openrouter-models-api",
    authority: "provider_pricing_api",
    billing_platforms: ["openrouter"],
    freshness: { max_age_seconds: DAY_SECONDS, require_same_utc_day: true }
  },
  {
    source_id: "commandcode-official-pricing",
    authority: "official_public_pricing",
    billing_platforms: ["commandcode"],
    freshness: { max_age_seconds: DAY_SECONDS, require_same_utc_day: true }
  },
  {
    source_id: "z-ai-official-pricing",
    authority: "official_public_pricing",
    billing_platforms: ["z-ai"],
    freshness: { max_age_seconds: DAY_SECONDS, require_same_utc_day: true }
  },
  {
    source_id: "pydantic-genai-prices",
    authority: "secondary_catalog",
    billing_platforms: "*",
    freshness: { max_age_seconds: WEEK_SECONDS, require_same_utc_day: false }
  },
  {
    source_id: "portkey-models",
    authority: "secondary_catalog",
    billing_platforms: "*",
    freshness: { max_age_seconds: WEEK_SECONDS, require_same_utc_day: false }
  },
  {
    source_id: "litellm-model-cost-map",
    authority: "secondary_catalog",
    billing_platforms: "*",
    freshness: { max_age_seconds: WEEK_SECONDS, require_same_utc_day: false }
  }
]);

export class PricingSourceRegistry {
  readonly #sources: ReadonlyMap<string, PricingSourceDefinition>;

  constructor(definitions: readonly PricingSourceDefinition[]) {
    const sources = new Map<string, PricingSourceDefinition>();
    definitions.forEach((definition, index) => {
      const normalized = validateDefinition(definition, index);
      if (sources.has(normalized.source_id)) {
        fail(`sources[${index}].source_id`, `duplicate source id '${normalized.source_id}'`);
      }
      sources.set(normalized.source_id, normalized);
    });
    this.#sources = sources;
  }

  source(sourceId: string): PricingSourceDefinition | undefined {
    return this.#sources.get(sourceId);
  }

  list(): readonly PricingSourceDefinition[] {
    return Object.freeze([...this.#sources.values()]);
  }

  assess(
    snapshotValue: unknown,
    now: string | Date = new Date(),
    evidence?: PriceFreshnessEvidence
  ): PriceSourceAssessment {
    const snapshot = validatePriceSnapshot(snapshotValue);
    const nowMs = toNowMs(now);
    const retrievedMs = Date.parse(snapshot.source.retrieved_at);
    let freshnessMs = retrievedMs;
    let freshnessBasis: "snapshot_retrieval" | "source_recheck" = "snapshot_retrieval";
    if (evidence !== undefined) {
      const checkedMs = Date.parse(evidence.checked_at);
      const validCheckedAt = Number.isFinite(checkedMs);
      const etagMatches = snapshot.source.etag !== undefined
        && evidence.etag !== undefined
        && snapshot.source.etag === evidence.etag;
      const digestMatches = snapshot.source.content_digest_sha256 !== undefined
        && evidence.content_digest_sha256 !== undefined
        && snapshot.source.content_digest_sha256 === evidence.content_digest_sha256;
      if (validCheckedAt && checkedMs >= retrievedMs && (etagMatches || digestMatches)) {
        freshnessMs = checkedMs;
        freshnessBasis = "source_recheck";
      }
    }
    const source = this.#sources.get(snapshot.source.source_id);

    if (source === undefined) {
      return Object.freeze({
        source_id: snapshot.source.source_id,
        known_source: false,
        declared_authority: snapshot.source.authority,
        freshness: freshnessMs > nowMs + DEFAULT_MAX_FUTURE_SKEW_SECONDS * 1000 ? "future" : "stale",
        age_seconds: Math.max(0, Math.floor((nowMs - freshnessMs) / 1000)),
        verification_status: snapshot.verification.status,
        freshness_basis: freshnessBasis,
        can_authorize_calculated_cost: false,
        reasons: Object.freeze(["UNKNOWN_SOURCE"] as const)
      });
    }

    const reasons: PriceSourceAssessmentReason[] = [];
    if (source.authority !== snapshot.source.authority) reasons.push("SOURCE_AUTHORITY_MISMATCH");
    if (!platformSupported(source.billing_platforms, snapshot.identity.billing_platform)) {
      reasons.push("PLATFORM_UNSUPPORTED");
    }

    const maxFutureSkew = source.freshness.max_future_skew_seconds ?? DEFAULT_MAX_FUTURE_SKEW_SECONDS;
    const future = freshnessMs > nowMs + maxFutureSkew * 1000;
    const ageSeconds = Math.max(0, Math.floor((nowMs - freshnessMs) / 1000));
    const sameDayRequiredAndMissing = source.freshness.require_same_utc_day && !sameUtcDay(freshnessMs, nowMs);
    const stale = ageSeconds > source.freshness.max_age_seconds || sameDayRequiredAndMissing;
    const freshness: PriceFreshnessStatus = future ? "future" : stale ? "stale" : "fresh";
    if (future) reasons.push("SOURCE_FUTURE");
    else if (stale) reasons.push("SOURCE_STALE");

    const verificationSufficient = snapshot.verification.status === "verified"
      || snapshot.verification.status === "cross_checked";
    if (!verificationSufficient) reasons.push("VERIFICATION_INSUFFICIENT");

    const authoritative = source.authority === "provider_pricing_api"
      || source.authority === "official_public_pricing";
    if (!authoritative) reasons.push("SECONDARY_DISCOVERY_ONLY");

    const canAuthorize = reasons.length === 0 && authoritative && verificationSufficient && freshness === "fresh";

    return Object.freeze({
      source_id: source.source_id,
      known_source: true,
      declared_authority: snapshot.source.authority,
      registered_authority: source.authority,
      freshness,
      age_seconds: ageSeconds,
      verification_status: snapshot.verification.status,
      freshness_basis: freshnessBasis,
      can_authorize_calculated_cost: canAuthorize,
      reasons: Object.freeze(reasons)
    });
  }

  rank(snapshotValues: readonly unknown[], now: string | Date = new Date()): readonly PriceSnapshot[] {
    const parsed = snapshotValues.map((value) => validatePriceSnapshot(value));
    const nowMs = toNowMs(now);

    return Object.freeze(parsed.slice().sort((left, right) => {
      const leftAssessment = this.assess(left, new Date(nowMs));
      const rightAssessment = this.assess(right, new Date(nowMs));

      if (leftAssessment.can_authorize_calculated_cost !== rightAssessment.can_authorize_calculated_cost) {
        return leftAssessment.can_authorize_calculated_cost ? -1 : 1;
      }

      const leftSource = this.#sources.get(left.source.source_id);
      const rightSource = this.#sources.get(right.source.source_id);
      const leftAuthority = leftSource?.authority ?? left.source.authority;
      const rightAuthority = rightSource?.authority ?? right.source.authority;
      const authorityDifference = authorityRank(rightAuthority) - authorityRank(leftAuthority);
      if (authorityDifference !== 0) return authorityDifference;

      const verificationDifference = verificationRank(right.verification.status) - verificationRank(left.verification.status);
      if (verificationDifference !== 0) return verificationDifference;

      const retrievedDifference = Date.parse(right.source.retrieved_at) - Date.parse(left.source.retrieved_at);
      if (retrievedDifference !== 0) return retrievedDifference;

      const sourceDifference = left.source.source_id.localeCompare(right.source.source_id);
      if (sourceDifference !== 0) return sourceDifference;
      return left.price_snapshot_id.localeCompare(right.price_snapshot_id);
    }));
  }
}

export function createDefaultPricingSourceRegistry(): PricingSourceRegistry {
  return new PricingSourceRegistry(FIRST_RELEASE_PRICING_SOURCES);
}
