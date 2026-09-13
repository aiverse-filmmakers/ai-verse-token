import assert from "node:assert/strict";
import test from "node:test";
import {
  FIRST_RELEASE_PRICING_SOURCES,
  PricingSourceRegistry,
  PricingSourceRegistryError,
  createDefaultPricingSourceRegistry
} from "../dist/src/pricing/index.js";

function snapshot({
  id = "price-test",
  sourceId = "openai-official-pricing",
  authority = "official_public_pricing",
  platform = "openai",
  retrievedAt = "2026-09-12T08:00:00Z",
  verification = "verified"
} = {}) {
  return {
    schema_version: "ai-verse-token-price/0.1",
    price_snapshot_id: id,
    identity: {
      billing_platform: platform,
      resolved_model: "test-model"
    },
    currency: "USD",
    effective: { starts_at: "2026-09-01T00:00:00Z" },
    rates: { input_tokens: { amount: "1", per: 1000000 } },
    source: {
      authority,
      source_id: sourceId,
      retrieved_at: retrievedAt
    },
    verification: verification === "verified" || verification === "cross_checked"
      ? { status: verification, verified_at: retrievedAt }
      : { status: verification }
  };
}

const NOW = "2026-09-12T12:00:00Z";

test("default registry explicitly separates official and secondary references", () => {
  const registry = createDefaultPricingSourceRegistry();
  const ids = registry.list().map((source) => source.source_id);
  assert.ok(ids.includes("openai-official-pricing"));
  assert.ok(ids.includes("openrouter-models-api"));
  assert.ok(ids.includes("pydantic-genai-prices"));
  assert.ok(ids.includes("portkey-models"));
  assert.ok(ids.includes("litellm-model-cost-map"));
  assert.equal(registry.source("pydantic-genai-prices")?.authority, "secondary_catalog");
});

test("fresh verified official pricing can authorize calculated cost", () => {
  const assessment = createDefaultPricingSourceRegistry().assess(snapshot(), NOW);
  assert.equal(assessment.freshness, "fresh");
  assert.equal(assessment.can_authorize_calculated_cost, true);
  assert.deepEqual(assessment.reasons, []);
});

test("secondary catalogs remain discovery-only even when fresh and cross-checked", () => {
  const assessment = createDefaultPricingSourceRegistry().assess(snapshot({
    sourceId: "pydantic-genai-prices",
    authority: "secondary_catalog",
    verification: "cross_checked"
  }), NOW);
  assert.equal(assessment.freshness, "fresh");
  assert.equal(assessment.can_authorize_calculated_cost, false);
  assert.ok(assessment.reasons.includes("SECONDARY_DISCOVERY_ONLY"));
});

test("same-day requirement makes yesterday's authoritative snapshot stale even under 24 hours", () => {
  const assessment = createDefaultPricingSourceRegistry().assess(snapshot({
    retrievedAt: "2026-09-11T23:59:00Z"
  }), "2026-09-12T00:01:00Z");
  assert.equal(assessment.age_seconds, 120);
  assert.equal(assessment.freshness, "stale");
  assert.equal(assessment.can_authorize_calculated_cost, false);
  assert.ok(assessment.reasons.includes("SOURCE_STALE"));
});

test("unverified and disputed official snapshots cannot authorize cost", () => {
  const registry = createDefaultPricingSourceRegistry();
  for (const verification of ["unverified", "disputed"]) {
    const assessment = registry.assess(snapshot({ verification }), NOW);
    assert.equal(assessment.can_authorize_calculated_cost, false);
    assert.ok(assessment.reasons.includes("VERIFICATION_INSUFFICIENT"));
  }
});

test("unknown source ids never gain authority from self-declared source metadata", () => {
  const assessment = createDefaultPricingSourceRegistry().assess(snapshot({
    sourceId: "totally-official-trust-me"
  }), NOW);
  assert.equal(assessment.known_source, false);
  assert.equal(assessment.can_authorize_calculated_cost, false);
  assert.deepEqual(assessment.reasons, ["UNKNOWN_SOURCE"]);
});

test("registered source authority must match snapshot authority", () => {
  const assessment = createDefaultPricingSourceRegistry().assess(snapshot({
    sourceId: "pydantic-genai-prices",
    authority: "official_public_pricing"
  }), NOW);
  assert.equal(assessment.can_authorize_calculated_cost, false);
  assert.ok(assessment.reasons.includes("SOURCE_AUTHORITY_MISMATCH"));
});

test("an official source cannot authorize pricing for a different billing platform", () => {
  const assessment = createDefaultPricingSourceRegistry().assess(snapshot({
    sourceId: "openai-official-pricing",
    authority: "official_public_pricing",
    platform: "anthropic"
  }), NOW);
  assert.equal(assessment.can_authorize_calculated_cost, false);
  assert.ok(assessment.reasons.includes("PLATFORM_UNSUPPORTED"));
});

test("future-dated retrieval beyond clock skew fails closed", () => {
  const assessment = createDefaultPricingSourceRegistry().assess(snapshot({
    retrievedAt: "2026-09-12T12:10:00Z"
  }), NOW);
  assert.equal(assessment.freshness, "future");
  assert.equal(assessment.can_authorize_calculated_cost, false);
  assert.ok(assessment.reasons.includes("SOURCE_FUTURE"));
});

test("small source clock skew is tolerated without creating negative age", () => {
  const assessment = createDefaultPricingSourceRegistry().assess(snapshot({
    retrievedAt: "2026-09-12T12:03:00Z"
  }), NOW);
  assert.equal(assessment.freshness, "fresh");
  assert.equal(assessment.age_seconds, 0);
  assert.equal(assessment.can_authorize_calculated_cost, true);
});

test("ranking keeps authoritative pricing ahead of newer secondary catalog data", () => {
  const registry = createDefaultPricingSourceRegistry();
  const official = snapshot({ id: "official", retrievedAt: "2026-09-12T08:00:00Z" });
  const secondary = snapshot({
    id: "secondary",
    sourceId: "portkey-models",
    authority: "secondary_catalog",
    retrievedAt: "2026-09-12T11:59:00Z",
    verification: "cross_checked"
  });
  const ranked = registry.rank([secondary, official], NOW);
  assert.equal(ranked[0].price_snapshot_id, "official");
  assert.equal(ranked[1].price_snapshot_id, "secondary");
});

test("provider pricing API outranks official public pricing when both are authorized", () => {
  const registry = new PricingSourceRegistry([
    {
      source_id: "api",
      authority: "provider_pricing_api",
      billing_platforms: ["x"],
      freshness: { max_age_seconds: 86400, require_same_utc_day: true }
    },
    {
      source_id: "web",
      authority: "official_public_pricing",
      billing_platforms: ["x"],
      freshness: { max_age_seconds: 86400, require_same_utc_day: true }
    }
  ]);
  const api = snapshot({ id: "api-price", sourceId: "api", authority: "provider_pricing_api", platform: "x" });
  const web = snapshot({ id: "web-price", sourceId: "web", authority: "official_public_pricing", platform: "x" });
  assert.equal(registry.rank([web, api], NOW)[0].price_snapshot_id, "api-price");
});

test("source definitions are trusted configuration and reject duplicates/invalid freshness", () => {
  const duplicate = [FIRST_RELEASE_PRICING_SOURCES[0], FIRST_RELEASE_PRICING_SOURCES[0]];
  assert.throws(() => new PricingSourceRegistry(duplicate), /duplicate source id/);

  assert.throws(() => new PricingSourceRegistry([{
    source_id: "bad",
    authority: "official_public_pricing",
    billing_platforms: ["openai"],
    freshness: { max_age_seconds: 0, require_same_utc_day: true }
  }]), PricingSourceRegistryError);
});

test("registry list cannot be used to mutate registered definitions", () => {
  const registry = createDefaultPricingSourceRegistry();
  const list = registry.list();
  assert.equal(Object.isFrozen(list), true);
  assert.equal(Object.isFrozen(list[0]), true);
  assert.equal(Object.isFrozen(list[0].freshness), true);
});
