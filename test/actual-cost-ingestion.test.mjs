import assert from "node:assert/strict";
import test from "node:test";
import {
  ActualChargeIngestionError,
  ActualCostSourceRegistry,
  createDefaultActualCostSourceRegistry
} from "../dist/src/cost/index.js";

function event({ platform = "openrouter", runtime = "hermes", actualCharge } = {}) {
  return {
    schema_version: "ai-verse-token/0.1",
    event_id: "evt-actual-1",
    source: { runtime, source_type: "test" },
    observed_at: "2026-09-12T11:01:00Z",
    identity: {
      billing_platform: platform,
      inference_provider: "anthropic",
      requested_model: "claude",
      resolved_model: "claude"
    },
    usage: { input_tokens: 10, output_tokens: 5 },
    timing: { started_at: "2026-09-12T11:00:00Z" },
    ...(actualCharge === undefined ? {} : { actual_charge: actualCharge }),
    provenance: {
      collector_id: "test",
      source_record_fingerprint: "1234567890abcdef",
      usage_quality: "provider_reported",
      timing_quality: "provider_reported",
      content_stored: false
    }
  };
}

test("OpenRouter provider-reported generation charge attaches as ACTUAL-compatible provider data", () => {
  const result = createDefaultActualCostSourceRegistry().attach(event(), {
    source_id: "openrouter-generation-api",
    amount: 0.012345,
    currency: "USD",
    external_charge_id: "gen_123",
    reported_at: "2026-09-12T11:01:30Z"
  });
  assert.equal(result.replay, false);
  assert.deepEqual(result.event.actual_charge, {
    amount: "0.012345",
    currency: "USD",
    source: "provider_reported",
    external_charge_id: "gen_123",
    reported_at: "2026-09-12T11:01:30Z"
  });
  assert.equal(result.event.source.runtime, "hermes");
  assert.equal(result.event.provenance.collector_id, "test");
});

test("Hermes state-db actual cost attaches as runtime-reported without rewriting route identity", () => {
  const original = event({ platform: "commandcode", runtime: "hermes" });
  const result = createDefaultActualCostSourceRegistry().attach(original, {
    source_id: "hermes-state-db",
    amount: 1.25,
    currency: "USD"
  });
  assert.equal(result.event.actual_charge.source, "runtime_reported");
  assert.equal(result.event.identity.billing_platform, "commandcode");
  assert.equal(result.event.source.runtime, "hermes");
});

test("real zero actual charge is preserved exactly and not treated as missing", () => {
  const result = createDefaultActualCostSourceRegistry().attach(event(), {
    source_id: "openrouter-generation-api",
    amount: 0,
    currency: "USD"
  });
  assert.equal(result.event.actual_charge.amount, "0");
});

test("provider actual-cost source is constrained to its registered billing platform", () => {
  assert.throws(() => createDefaultActualCostSourceRegistry().attach(event({ platform: "anthropic" }), {
    source_id: "openrouter-generation-api",
    amount: 1,
    currency: "USD"
  }), (error) => error instanceof ActualChargeIngestionError && error.code === "ACTUAL_COST_ROUTE_MISMATCH");
});

test("runtime actual-cost source is constrained to its registered runtime", () => {
  assert.throws(() => createDefaultActualCostSourceRegistry().attach(event({ runtime: "codex" }), {
    source_id: "hermes-state-db",
    amount: 1,
    currency: "USD"
  }), (error) => error instanceof ActualChargeIngestionError && error.code === "ACTUAL_COST_ROUTE_MISMATCH");
});

test("unknown source cannot self-declare trusted actual cost", () => {
  assert.throws(() => createDefaultActualCostSourceRegistry().attach(event(), {
    source_id: "totally-trusted-honest",
    amount: 1,
    currency: "USD"
  }), (error) => error instanceof ActualChargeIngestionError && error.code === "ACTUAL_COST_SOURCE_UNKNOWN");
});

test("exact replay is idempotent but a different charge cannot overwrite existing actual money", () => {
  const registry = createDefaultActualCostSourceRegistry();
  const first = registry.attach(event(), {
    source_id: "openrouter-generation-api",
    amount: 2.5,
    currency: "USD",
    external_charge_id: "gen_1"
  });
  const replay = registry.attach(first.event, {
    source_id: "openrouter-generation-api",
    amount: 2.5,
    currency: "USD",
    external_charge_id: "gen_1"
  });
  assert.equal(replay.replay, true);
  assert.throws(() => registry.attach(first.event, {
    source_id: "openrouter-generation-api",
    amount: 2.6,
    currency: "USD",
    external_charge_id: "gen_1"
  }), (error) => error instanceof ActualChargeIngestionError && error.code === "ACTUAL_COST_CONFLICT");
});

test("original currency is preserved and invalid currency/report timestamp fail before mutation", () => {
  const registry = createDefaultActualCostSourceRegistry();
  const eur = registry.attach(event(), {
    source_id: "openrouter-generation-api",
    amount: 1.2,
    currency: "EUR"
  });
  assert.equal(eur.event.actual_charge.currency, "EUR");
  assert.throws(() => registry.attach(event(), {
    source_id: "openrouter-generation-api",
    amount: 1,
    currency: "usd"
  }), /currency/);
  assert.throws(() => registry.attach(event(), {
    source_id: "openrouter-generation-api",
    amount: 1,
    currency: "USD",
    reported_at: "today"
  }), /reported_at/);
});

test("custom source registry validates provider/runtime scope at trusted construction time", () => {
  assert.throws(() => new ActualCostSourceRegistry([{
    source_id: "bad-provider",
    charge_source: "provider_reported"
  }]), /billing_platforms/);
  assert.throws(() => new ActualCostSourceRegistry([{
    source_id: "bad-runtime",
    charge_source: "runtime_reported"
  }]), /runtimes/);
});
