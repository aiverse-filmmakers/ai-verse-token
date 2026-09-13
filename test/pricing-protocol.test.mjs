import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  PriceProtocolValidationError,
  validatePriceSnapshot
} from "../dist/src/pricing/index.js";

function validSnapshot() {
  return {
    schema_version: "ai-verse-token-price/0.1",
    price_snapshot_id: "price_openrouter_claude_2026-09-12",
    identity: {
      billing_platform: "openrouter",
      resolved_model: "anthropic/claude-sonnet-4.5",
      inference_provider: "anthropic",
      provider_model_id: "anthropic/claude-sonnet-4.5",
      service_tier: "standard",
      region: "global",
      billing_mode: "api"
    },
    currency: "USD",
    effective: {
      starts_at: "2026-09-12T00:00:00Z",
      weekdays_utc: ["mon", "tue", "wed", "thu", "fri"],
      utc_time_windows: [{ start: "00:00", end: "23:59:59" }]
    },
    conditions: {
      context: {
        basis: "input_plus_cache_read_tokens",
        min_inclusive: 0,
        max_exclusive: 200000
      },
      cache_ttl: {
        min_seconds_inclusive: 0,
        max_seconds_exclusive: 3600
      }
    },
    rates: {
      input_tokens: { amount: "3.00", per: 1000000 },
      output_tokens: { amount: "15", per: 1000000 },
      cache_read_tokens: { amount: "0.30", per: 1000000 },
      reasoning_tokens: { amount: "15", per: 1000000 },
      request_units: { amount: "0", per: 1 }
    },
    source: {
      authority: "official_public_pricing",
      source_id: "openrouter-pricing",
      source_url: "https://openrouter.ai/pricing",
      retrieved_at: "2026-09-12T08:00:00Z",
      published_at: "2026-09-12T00:00:00Z",
      etag: "pricing-v7",
      content_digest_sha256: "a".repeat(64)
    },
    verification: {
      status: "cross_checked",
      verified_at: "2026-09-12T08:05:00Z"
    }
  };
}

function clone(value) {
  return structuredClone(value);
}

test("accepts a complex effective-dated price snapshot", () => {
  const snapshot = validatePriceSnapshot(validSnapshot());
  assert.equal(snapshot.identity.billing_platform, "openrouter");
  assert.equal(snapshot.rates.input_tokens?.amount, "3.00");
  assert.equal(snapshot.rates.request_units?.amount, "0");
  assert.equal(snapshot.conditions?.context?.max_exclusive, 200000);
});

test("preserves exact decimal tariff text including known zero", () => {
  const input = validSnapshot();
  input.rates.input_tokens.amount = "0.000000000000000001";
  input.rates.output_tokens.amount = "0";
  const snapshot = validatePriceSnapshot(input);
  assert.equal(snapshot.rates.input_tokens?.amount, "0.000000000000000001");
  assert.equal(snapshot.rates.output_tokens?.amount, "0");
});

test("rejects floating-point money and exponent notation", () => {
  const numberRate = validSnapshot();
  numberRate.rates.input_tokens.amount = 3;
  assert.throws(() => validatePriceSnapshot(numberRate), /input_tokens\.amount: must be a string/);

  const exponent = validSnapshot();
  exponent.rates.input_tokens.amount = "3e-6";
  assert.throws(() => validatePriceSnapshot(exponent), /decimal string without exponent/);
});

test("rejects inverted effective intervals", () => {
  const input = validSnapshot();
  input.effective.ends_at = "2026-09-11T23:59:59Z";
  assert.throws(() => validatePriceSnapshot(input), /ends_at: must be later than starts_at/);
});

test("rejects duplicate weekdays and cross-midnight UTC windows", () => {
  const duplicateDay = validSnapshot();
  duplicateDay.effective.weekdays_utc = ["mon", "mon"];
  assert.throws(() => validatePriceSnapshot(duplicateDay), /weekdays_utc: must not contain duplicates/);

  const crossMidnight = validSnapshot();
  crossMidnight.effective.utc_time_windows = [{ start: "22:00", end: "06:00" }];
  assert.throws(() => validatePriceSnapshot(crossMidnight), /split cross-midnight windows/);
});

test("rejects invalid context and cache condition bounds", () => {
  const context = validSnapshot();
  context.conditions.context = {
    basis: "input_tokens",
    min_inclusive: 200000,
    max_exclusive: 200000
  };
  assert.throws(() => validatePriceSnapshot(context), /max_exclusive: must be greater/);

  const ttl = validSnapshot();
  ttl.conditions.cache_ttl = {
    min_seconds_inclusive: 3600,
    max_seconds_exclusive: 60
  };
  assert.throws(() => validatePriceSnapshot(ttl), /max_seconds_exclusive: must be greater/);
});

test("requires at least one rate and rejects unknown rate dimensions", () => {
  const empty = validSnapshot();
  empty.rates = {};
  assert.throws(() => validatePriceSnapshot(empty), /rates: must contain at least one rate/);

  const unknown = validSnapshot();
  unknown.rates.secret_discount = { amount: "1", per: 1 };
  assert.throws(() => validatePriceSnapshot(unknown), /secret_discount: unknown field/);
});

test("verification timestamps are explicit and ordered", () => {
  const missing = validSnapshot();
  delete missing.verification.verified_at;
  assert.throws(() => validatePriceSnapshot(missing), /verified_at: is required/);

  const earlier = validSnapshot();
  earlier.verification.verified_at = "2026-09-12T07:59:59Z";
  assert.throws(() => validatePriceSnapshot(earlier), /must not be earlier than source\.retrieved_at/);

  const unverified = validSnapshot();
  unverified.verification = { status: "unverified" };
  assert.equal(validatePriceSnapshot(unverified).verification.status, "unverified");
});

test("source provenance rejects embedded credentials and malformed digests", () => {
  const credentialUrl = validSnapshot();
  credentialUrl.source.source_url = "https://user:pass@example.com/pricing";
  assert.throws(() => validatePriceSnapshot(credentialUrl), /embedded credentials/);

  const digest = validSnapshot();
  digest.source.content_digest_sha256 = "ABC";
  assert.throws(() => validatePriceSnapshot(digest), /SHA-256/);
});

test("identity, currency and top-level vocabulary are strict", () => {
  const badCurrency = validSnapshot();
  badCurrency.currency = "usd";
  assert.throws(() => validatePriceSnapshot(badCurrency), /uppercase ISO-like/);

  const missingModel = validSnapshot();
  delete missingModel.identity.resolved_model;
  assert.throws(() => validatePriceSnapshot(missingModel), /resolved_model: is required/);

  const unknown = validSnapshot();
  unknown.current_price = true;
  assert.throws(() => validatePriceSnapshot(unknown), /current_price: unknown field/);
});

test("JSON Schema is valid JSON and carries the frozen protocol vocabulary", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/price-snapshot-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.schema_version.const, "ai-verse-token-price/0.1");
  assert.deepEqual(schema.required, [
    "schema_version",
    "price_snapshot_id",
    "identity",
    "currency",
    "effective",
    "rates",
    "source",
    "verification"
  ]);
  assert.equal(schema.properties.rates.properties.input_tokens.$ref, "#/$defs/rate");
  assert.equal(schema.$defs.rate.properties.amount.$ref, "#/$defs/decimalMoney");
});

test("validator errors expose a stable pricing-protocol error type", () => {
  assert.throws(() => validatePriceSnapshot(null), PriceProtocolValidationError);
});
