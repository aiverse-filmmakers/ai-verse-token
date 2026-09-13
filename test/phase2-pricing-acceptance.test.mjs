import assert from "node:assert/strict";
import test from "node:test";
import { CostEngine, createDefaultActualCostSourceRegistry } from "../dist/src/cost/index.js";
import { IdentityResolver } from "../dist/src/identity/index.js";
import { createDefaultPricingSourceRegistry } from "../dist/src/pricing/index.js";

const NOW = "2026-09-12T15:00:00Z";

function usageEvent(overrides = {}) {
  const base = {
    schema_version: "ai-verse-token/0.1",
    event_id: "evt-phase2",
    source: { runtime: "hermes", source_type: "phase2", source_platform: "openai" },
    observed_at: "2026-09-12T14:01:00Z",
    identity: {
      billing_platform: "openai",
      inference_provider: "openai",
      requested_model: "gpt-phase2",
      resolved_model: "gpt-phase2",
      service_tier: "standard"
    },
    usage: {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_read_tokens: 0,
      reasoning_tokens: 0
    },
    timing: { started_at: "2026-09-12T14:00:00Z" },
    provenance: {
      collector_id: "phase2",
      source_record_fingerprint: "phase2fingerprint123",
      usage_quality: "provider_reported",
      timing_quality: "provider_reported",
      content_stored: false
    }
  };
  return merge(base, overrides);
}

function price(overrides = {}) {
  const base = {
    schema_version: "ai-verse-token-price/0.1",
    price_snapshot_id: "price-phase2-standard",
    identity: {
      billing_platform: "openai",
      resolved_model: "gpt-phase2",
      inference_provider: "openai",
      service_tier: "standard"
    },
    currency: "USD",
    effective: { starts_at: "2026-09-01T00:00:00Z" },
    rates: {
      input_tokens: { amount: "2", per: 1_000_000 },
      output_tokens: { amount: "10", per: 1_000_000 },
      cache_read_tokens: { amount: "0.2", per: 1_000_000 },
      reasoning_tokens: { amount: "10", per: 1_000_000 }
    },
    source: {
      authority: "official_public_pricing",
      source_id: "openai-official-pricing",
      retrieved_at: "2026-09-12T08:00:00Z"
    },
    verification: { status: "verified", verified_at: "2026-09-12T08:00:00Z" }
  };
  return merge(base, overrides);
}

function merge(base, overrides) {
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

function cost(event, snapshots, context = {}) {
  return new CostEngine(createDefaultPricingSourceRegistry()).rate({
    event,
    price_snapshots: snapshots,
    context: { now: NOW, ...context }
  });
}

test("Phase 2 gate: historical price changes never reprice old usage with today's tariff", () => {
  const juneEvent = usageEvent({
    observed_at: "2026-06-15T10:01:00Z",
    timing: { started_at: "2026-06-15T10:00:00Z" }
  });
  const june = price({
    price_snapshot_id: "june-price",
    effective: { starts_at: "2026-06-01T00:00:00Z", ends_at: "2026-07-01T00:00:00Z" },
    rates: {
      input_tokens: { amount: "1", per: 1_000_000 },
      output_tokens: { amount: "5", per: 1_000_000 },
      cache_read_tokens: { amount: "0.1", per: 1_000_000 },
      reasoning_tokens: { amount: "5", per: 1_000_000 }
    },
    source: { authority: "official_public_pricing", source_id: "openai-official-pricing", retrieved_at: "2026-06-01T08:00:00Z" },
    verification: { status: "verified", verified_at: "2026-06-01T08:00:00Z" }
  });
  const september = price({ price_snapshot_id: "september-price" });
  const result = cost(juneEvent, [september, june]);
  assert.equal(result.status, "CALCULATED");
  assert.equal(result.price_snapshot_id, "june-price");
  assert.equal(result.amount, "1.5");
});

test("Phase 2 gate: service and context tiers resolve only with enough exact dimensions", () => {
  const flex = price({
    price_snapshot_id: "flex",
    identity: {
      billing_platform: "openai",
      resolved_model: "gpt-phase2",
      inference_provider: "openai",
      service_tier: "flex"
    },
    rates: {
      input_tokens: { amount: "1", per: 1_000_000 },
      output_tokens: { amount: "5", per: 1_000_000 },
      cache_read_tokens: { amount: "0.1", per: 1_000_000 },
      reasoning_tokens: { amount: "5", per: 1_000_000 }
    }
  });
  const standardLow = price({
    price_snapshot_id: "standard-low",
    conditions: { context: { basis: "input_tokens", max_exclusive: 2_000_000 } }
  });
  const standardHigh = price({
    price_snapshot_id: "standard-high",
    conditions: { context: { basis: "input_tokens", min_inclusive: 2_000_000 } },
    rates: {
      input_tokens: { amount: "4", per: 1_000_000 },
      output_tokens: { amount: "20", per: 1_000_000 },
      cache_read_tokens: { amount: "0.4", per: 1_000_000 },
      reasoning_tokens: { amount: "20", per: 1_000_000 }
    }
  });

  const standard = cost(usageEvent(), [flex, standardHigh, standardLow]);
  assert.equal(standard.status, "CALCULATED");
  assert.equal(standard.price_snapshot_id, "standard-low");

  const noTier = usageEvent({ identity: { service_tier: null } });
  const unknown = cost(noTier, [flex, standardHigh, standardLow]);
  assert.equal(unknown.status, "UNKNOWN");
  assert.ok(unknown.reasons.includes("MISSING_IDENTITY_DIMENSION"));
});

test("Phase 2 gate: cache zero is chargeable zero usage while missing cache usage is UNKNOWN", () => {
  const knownZero = cost(usageEvent(), [price()]);
  assert.equal(knownZero.status, "CALCULATED");
  assert.equal(knownZero.components.find((part) => part.rate_field === "cache_read_tokens").amount, "0");

  const missingCache = usageEvent({ usage: { cache_read_tokens: null } });
  const unknown = cost(missingCache, [price()]);
  assert.equal(unknown.status, "UNKNOWN");
  assert.ok(unknown.reasons.includes("MISSING_USAGE_DIMENSION"));
  assert.equal(Object.prototype.hasOwnProperty.call(unknown, "amount"), false);
});

test("Phase 2 gate: an unknown resolved model is never fuzzy-priced against a near-name tariff", () => {
  const unresolved = usageEvent({ identity: { requested_model: "gpt-phase2-latest", resolved_model: null } });
  const result = cost(unresolved, [price()]);
  assert.equal(result.status, "UNKNOWN");
  assert.deepEqual(result.reasons, ["MISSING_RESOLVED_MODEL"]);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "amount"), false);
});

test("Phase 2 gate: conflicting exact alias evidence remains ambiguous and unpriceable", () => {
  const resolver = new IdentityResolver({
    modelAliases: [
      {
        id: "requested-a",
        billingPlatform: "openai",
        matchField: "requested_model",
        alias: "alias-a",
        resolvedModel: "gpt-phase2"
      },
      {
        id: "provider-b",
        billingPlatform: "openai",
        matchField: "provider_model_id",
        alias: "provider-b",
        resolvedModel: "different-model"
      }
    ]
  });
  const raw = usageEvent({
    identity: {
      requested_model: "alias-a",
      resolved_model: null,
      provider_model_id: "provider-b"
    }
  });
  const resolved = resolver.resolveUsageEvent(raw);
  assert.equal(resolved.resolution.status, "ambiguous");
  assert.equal(resolved.resolution.pricingIdentityReady, false);
  const result = cost(resolved.event, [price()]);
  assert.equal(result.status, "UNKNOWN");
  assert.equal(Object.prototype.hasOwnProperty.call(result, "amount"), false);
});

test("Phase 2 gate: stale current pricing cannot authorize calculated cost", () => {
  const stale = price({
    source: { authority: "official_public_pricing", source_id: "openai-official-pricing", retrieved_at: "2026-09-11T23:59:00Z" },
    verification: { status: "verified", verified_at: "2026-09-11T23:59:00Z" }
  });
  const result = cost(usageEvent(), [stale]);
  assert.equal(result.status, "UNKNOWN");
  assert.deepEqual(result.reasons, ["PRICING_NOT_AUTHORITATIVE"]);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "amount"), false);
});

test("Phase 2 gate: trusted provider actual charge overrides stale or conflicting calculated pricing", () => {
  const attached = createDefaultActualCostSourceRegistry().attach(
    usageEvent({ identity: { billing_platform: "openrouter", inference_provider: "openai" } }),
    {
      source_id: "openrouter-generation-api",
      amount: 0.777,
      currency: "USD",
      external_charge_id: "gen_actual"
    }
  ).event;
  const unrelatedTariff = price();
  const result = cost(attached, [unrelatedTariff]);
  assert.equal(result.status, "ACTUAL");
  assert.equal(result.amount, "0.777");
  assert.equal(result.actual_charge.external_charge_id, "gen_actual");
});

test("Phase 2 gate: unknown monetary cost is structurally different from a real zero charge", () => {
  const unknown = cost(usageEvent({ identity: { resolved_model: null } }), [price()]);
  assert.equal(unknown.status, "UNKNOWN");
  assert.equal(Object.prototype.hasOwnProperty.call(unknown, "amount"), false);

  const zeroActual = createDefaultActualCostSourceRegistry().attach(
    usageEvent({ identity: { billing_platform: "openrouter", inference_provider: "openai" } }),
    { source_id: "openrouter-generation-api", amount: 0, currency: "USD" }
  ).event;
  const actual = cost(zeroActual, []);
  assert.equal(actual.status, "ACTUAL");
  assert.equal(actual.amount, "0");
});
