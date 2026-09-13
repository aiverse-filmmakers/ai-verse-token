import assert from "node:assert/strict";
import test from "node:test";
import { CostEngine } from "../dist/src/cost/index.js";
import { createDefaultPricingSourceRegistry, PricingSourceRegistry } from "../dist/src/pricing/index.js";

const NOW = "2026-09-12T12:00:00Z";

function event(overrides = {}) {
  const base = {
    schema_version: "ai-verse-token/0.1",
    event_id: "evt-cost-1",
    source: { runtime: "hermes", source_type: "test" },
    observed_at: "2026-09-12T11:01:00Z",
    identity: {
      billing_platform: "openai",
      inference_provider: "openai",
      requested_model: "gpt-test",
      resolved_model: "gpt-test",
      service_tier: "standard"
    },
    usage: {
      input_tokens: 2_000_000,
      output_tokens: 100_000,
      cache_read_tokens: 1_000_000,
      reasoning_tokens: 0
    },
    timing: { started_at: "2026-09-12T11:00:00Z" },
    provenance: {
      collector_id: "test",
      source_record_fingerprint: "1234567890abcdef",
      usage_quality: "provider_reported",
      timing_quality: "provider_reported",
      content_stored: false
    }
  };
  return structuredMerge(base, overrides);
}

function structuredMerge(base, overrides) {
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(overrides)) {
    if (value && typeof value === "object" && !Array.isArray(value) && out[key] && typeof out[key] === "object") {
      out[key] = { ...out[key], ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

function price(overrides = {}) {
  const base = {
    schema_version: "ai-verse-token-price/0.1",
    price_snapshot_id: "price-openai-test",
    identity: {
      billing_platform: "openai",
      resolved_model: "gpt-test",
      inference_provider: "openai",
      service_tier: "standard"
    },
    currency: "USD",
    effective: { starts_at: "2026-09-01T00:00:00Z" },
    rates: {
      input_tokens: { amount: "2.50", per: 1_000_000 },
      output_tokens: { amount: "10", per: 1_000_000 },
      cache_read_tokens: { amount: "0.25", per: 1_000_000 },
      reasoning_tokens: { amount: "10", per: 1_000_000 }
    },
    source: {
      authority: "official_public_pricing",
      source_id: "openai-official-pricing",
      retrieved_at: "2026-09-12T08:00:00Z"
    },
    verification: { status: "verified", verified_at: "2026-09-12T08:00:00Z" }
  };
  return structuredMerge(base, overrides);
}

function engine() {
  return new CostEngine(createDefaultPricingSourceRegistry());
}

test("provider/runtime reported actual charge always wins over calculation including zero", () => {
  const actual = event({
    actual_charge: { amount: "0", currency: "USD", source: "provider_reported" },
    provenance: { usage_quality: "estimated" }
  });
  const result = engine().rate({ event: actual, price_snapshots: [price()], context: { now: NOW } });
  assert.equal(result.status, "ACTUAL");
  assert.equal(result.amount, "0");
  assert.equal(result.currency, "USD");
});

test("calculates exact component and total cost from authoritative usage and tariff", () => {
  const result = engine().rate({ event: event(), price_snapshots: [price()], context: { now: NOW } });
  assert.equal(result.status, "CALCULATED");
  assert.equal(result.amount, "6.25");
  assert.equal(result.price_snapshot_id, "price-openai-test");
  assert.deepEqual(result.components.map((component) => [component.rate_field, component.amount]), [
    ["input_tokens", "5"],
    ["output_tokens", "1"],
    ["reasoning_tokens", "0"],
    ["cache_read_tokens", "0.25"]
  ]);
});

test("unknown usage dimensions required by the selected tariff never become zero", () => {
  const incomplete = event({ usage: { cache_read_tokens: null } });
  const result = engine().rate({ event: incomplete, price_snapshots: [price()], context: { now: NOW } });
  assert.equal(result.status, "UNKNOWN");
  assert.deepEqual(result.reasons, ["MISSING_USAGE_DIMENSION"]);
});

test("estimated usage cannot authorize calculated money", () => {
  const result = engine().rate({
    event: event({ provenance: { usage_quality: "estimated" } }),
    price_snapshots: [price()],
    context: { now: NOW }
  });
  assert.equal(result.status, "UNKNOWN");
  assert.deepEqual(result.reasons, ["NON_AUTHORITATIVE_USAGE"]);
});

test("requires request event time instead of pricing a backfill at observation time", () => {
  const result = engine().rate({ event: event({ timing: { started_at: null } }), price_snapshots: [price()], context: { now: NOW } });
  assert.equal(result.status, "UNKNOWN");
  assert.deepEqual(result.reasons, ["MISSING_EVENT_TIME"]);
});

test("today's calculated usage requires same-day fresh authoritative pricing", () => {
  const stale = price({
    source: { authority: "official_public_pricing", source_id: "openai-official-pricing", retrieved_at: "2026-09-11T23:59:00Z" },
    verification: { status: "verified", verified_at: "2026-09-11T23:59:00Z" }
  });
  const result = engine().rate({ event: event(), price_snapshots: [stale], context: { now: NOW } });
  assert.equal(result.status, "UNKNOWN");
  assert.deepEqual(result.reasons, ["PRICING_NOT_AUTHORITATIVE"]);
});

test("same-day source recheck can renew an unchanged tariff by matching ETag evidence", () => {
  const unchanged = price({
    source: {
      authority: "official_public_pricing",
      source_id: "openai-official-pricing",
      retrieved_at: "2026-09-11T23:59:00Z",
      etag: "v1"
    },
    verification: { status: "verified", verified_at: "2026-09-11T23:59:00Z" }
  });
  const result = engine().rate({
    event: event(),
    price_snapshots: [unchanged],
    context: {
      now: NOW,
      freshness_evidence_by_source: {
        "openai-official-pricing": { checked_at: "2026-09-12T10:00:00Z", etag: "v1" }
      }
    }
  });
  assert.equal(result.status, "CALCULATED");
  assert.equal(result.amount, "6.25");
});

test("historical events use historical effective tariffs rather than today's tariff", () => {
  const oldEvent = event({
    observed_at: "2026-06-10T10:01:00Z",
    timing: { started_at: "2026-06-10T10:00:00Z" }
  });
  const oldPrice = price({
    price_snapshot_id: "june",
    effective: { starts_at: "2026-06-01T00:00:00Z", ends_at: "2026-07-01T00:00:00Z" },
    rates: {
      input_tokens: { amount: "1", per: 1_000_000 },
      output_tokens: { amount: "1", per: 1_000_000 },
      cache_read_tokens: { amount: "1", per: 1_000_000 },
      reasoning_tokens: { amount: "1", per: 1_000_000 }
    },
    source: { authority: "official_public_pricing", source_id: "openai-official-pricing", retrieved_at: "2026-06-01T08:00:00Z" },
    verification: { status: "verified", verified_at: "2026-06-01T08:00:00Z" }
  });
  const today = price({ price_snapshot_id: "today", effective: { starts_at: "2026-09-01T00:00:00Z" } });
  const result = engine().rate({ event: oldEvent, price_snapshots: [today, oldPrice], context: { now: NOW } });
  assert.equal(result.status, "CALCULATED");
  assert.equal(result.price_snapshot_id, "june");
  assert.equal(result.amount, "3.1");
});

test("missing service tier fails closed when tier-specific tariffs exist", () => {
  const noTier = event({ identity: { service_tier: null } });
  const result = engine().rate({ event: noTier, price_snapshots: [price()], context: { now: NOW } });
  assert.equal(result.status, "UNKNOWN");
  assert.deepEqual(result.reasons, ["MISSING_IDENTITY_DIMENSION"]);
});

test("more-specific matching service tariff overrides generic tariff", () => {
  const generic = price({
    price_snapshot_id: "generic",
    rates: {
      input_tokens: { amount: "100", per: 1_000_000 },
      output_tokens: { amount: "100", per: 1_000_000 },
      cache_read_tokens: { amount: "100", per: 1_000_000 },
      reasoning_tokens: { amount: "100", per: 1_000_000 }
    }
  });
  delete generic.identity.service_tier;
  const result = engine().rate({ event: event(), price_snapshots: [generic, price()], context: { now: NOW } });
  assert.equal(result.status, "CALCULATED");
  assert.equal(result.price_snapshot_id, "price-openai-test");
  assert.equal(result.amount, "6.25");
});

test("context tiers are selected from exact usage and missing context fails closed", () => {
  const low = price({
    price_snapshot_id: "low",
    conditions: { context: { basis: "input_plus_cache_read_tokens", max_exclusive: 4_000_000 } }
  });
  const high = price({
    price_snapshot_id: "high",
    conditions: { context: { basis: "input_plus_cache_read_tokens", min_inclusive: 4_000_000 } },
    rates: {
      input_tokens: { amount: "5", per: 1_000_000 },
      output_tokens: { amount: "20", per: 1_000_000 },
      cache_read_tokens: { amount: "0.5", per: 1_000_000 },
      reasoning_tokens: { amount: "20", per: 1_000_000 }
    }
  });
  const selected = engine().rate({ event: event(), price_snapshots: [high, low], context: { now: NOW } });
  assert.equal(selected.status, "CALCULATED");
  assert.equal(selected.price_snapshot_id, "low");

  const missing = engine().rate({
    event: event({ usage: { cache_read_tokens: null } }),
    price_snapshots: [high, low],
    context: { now: NOW }
  });
  assert.equal(missing.status, "UNKNOWN");
  assert.ok(missing.reasons.includes("MISSING_CONTEXT_INPUT"));
});

test("cache TTL tariffs require explicit rating context and select the matching range", () => {
  const short = price({
    price_snapshot_id: "short-cache",
    conditions: { cache_ttl: { max_seconds_exclusive: 3600 } }
  });
  const long = price({
    price_snapshot_id: "long-cache",
    conditions: { cache_ttl: { min_seconds_inclusive: 3600 } },
    rates: {
      input_tokens: { amount: "4", per: 1_000_000 },
      output_tokens: { amount: "10", per: 1_000_000 },
      cache_read_tokens: { amount: "0.5", per: 1_000_000 },
      reasoning_tokens: { amount: "10", per: 1_000_000 }
    }
  });
  const missing = engine().rate({ event: event(), price_snapshots: [short, long], context: { now: NOW } });
  assert.equal(missing.status, "UNKNOWN");
  assert.deepEqual(missing.reasons, ["MISSING_CACHE_TTL"]);

  const selected = engine().rate({
    event: event(), price_snapshots: [short, long], context: { now: NOW, cache_ttl_seconds: 7200 }
  });
  assert.equal(selected.status, "CALCULATED");
  assert.equal(selected.price_snapshot_id, "long-cache");
  assert.equal(selected.amount, "9.5");
});

test("equal-authority conflicting tariffs with the same rank fail as ambiguous", () => {
  const registry = new PricingSourceRegistry([
    { source_id: "a", authority: "official_public_pricing", billing_platforms: ["openai"], freshness: { max_age_seconds: 86400, require_same_utc_day: true } },
    { source_id: "b", authority: "official_public_pricing", billing_platforms: ["openai"], freshness: { max_age_seconds: 86400, require_same_utc_day: true } }
  ]);
  const a = price({ source: { authority: "official_public_pricing", source_id: "a", retrieved_at: "2026-09-12T08:00:00Z" } });
  const b = price({
    price_snapshot_id: "other",
    source: { authority: "official_public_pricing", source_id: "b", retrieved_at: "2026-09-12T08:00:00Z" },
    rates: {
      input_tokens: { amount: "3", per: 1_000_000 },
      output_tokens: { amount: "10", per: 1_000_000 },
      cache_read_tokens: { amount: "0.25", per: 1_000_000 },
      reasoning_tokens: { amount: "10", per: 1_000_000 }
    }
  });
  const result = new CostEngine(registry).rate({ event: event(), price_snapshots: [a, b], context: { now: NOW } });
  assert.equal(result.status, "UNKNOWN");
  assert.deepEqual(result.reasons, ["TARIFF_AMBIGUOUS"]);
});

test("secondary catalogs can never authorize CALCULATED cost", () => {
  const secondary = price({
    source: { authority: "secondary_catalog", source_id: "portkey-models", retrieved_at: "2026-09-12T11:00:00Z" },
    verification: { status: "cross_checked", verified_at: "2026-09-12T11:00:00Z" }
  });
  const result = engine().rate({ event: event(), price_snapshots: [secondary], context: { now: NOW } });
  assert.equal(result.status, "UNKNOWN");
  assert.deepEqual(result.reasons, ["PRICING_NOT_AUTHORITATIVE"]);
});

test("non-terminating exact rate math fails closed rather than rounding silently", () => {
  const odd = price({
    rates: {
      input_tokens: { amount: "1", per: 3 },
      output_tokens: { amount: "0", per: 1 },
      cache_read_tokens: { amount: "0", per: 1 },
      reasoning_tokens: { amount: "0", per: 1 }
    }
  });
  const small = event({ usage: { input_tokens: 1, output_tokens: 0, cache_read_tokens: 0, reasoning_tokens: 0 } });
  const result = engine().rate({ event: small, price_snapshots: [odd], context: { now: NOW } });
  assert.equal(result.status, "UNKNOWN");
  assert.deepEqual(result.reasons, ["UNSUPPORTED_EXACT_DECIMAL"]);
});

test("context tier uses inclusive context_input_tokens instead of decomposed uncached input", () => {
  const low = price({
    price_snapshot_id: "ctx-low",
    conditions: { context: { basis: "input_tokens", max_exclusive: 4_000_000 } }
  });
  const high = price({
    price_snapshot_id: "ctx-high",
    conditions: { context: { basis: "input_tokens", min_inclusive: 4_000_000 } },
    rates: {
      input_tokens: { amount: "5", per: 1_000_000 },
      output_tokens: { amount: "20", per: 1_000_000 },
      cache_read_tokens: { amount: "0.5", per: 1_000_000 },
      reasoning_tokens: { amount: "20", per: 1_000_000 }
    }
  });
  const selected = engine().rate({
    event: event({ usage: { context_input_tokens: 5_000_000, input_tokens: 2_000_000, cache_read_tokens: 3_000_000 } }),
    price_snapshots: [low, high],
    context: { now: NOW }
  });
  assert.equal(selected.status, "CALCULATED");
  assert.equal(selected.price_snapshot_id, "ctx-high");
});
