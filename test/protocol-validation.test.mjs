import assert from "node:assert/strict";
import test from "node:test";
import {
  TokenProtocolValidationError,
  validateCostStatus,
  validateUsageEvent
} from "../dist/src/protocol/index.js";

function validEvent() {
  return {
    schema_version: "ai-verse-token/0.1",
    event_id: "evt_01JTEST",
    request_id: "req_01JTEST",
    session_id: null,
    source: {
      runtime: "hermes",
      runtime_version: "1.2.3",
      source_type: "sqlite-session",
      source_record_id: "session-123",
      source_platform: "commandcode"
    },
    observed_at: "2026-09-12T15:00:00Z",
    identity: {
      billing_platform: "commandcode",
      inference_provider: "z-ai",
      requested_model: "glm-5.3-flash",
      resolved_model: "glm-5.3-flash",
      service_tier: null
    },
    scope: {
      workspace_id: "ai-verse-token",
      agent_id: "hermes-main"
    },
    usage: {
      input_tokens: 0,
      output_tokens: 120,
      reasoning_tokens: null,
      cache_read_tokens: 400
    },
    timing: {
      started_at: "2026-09-12T14:59:58Z",
      first_token_at: "2026-09-12T14:59:58.500Z",
      ended_at: "2026-09-12T15:00:00Z",
      wall_ms: 2000,
      ttft_ms: 500
    },
    actual_charge: null,
    provenance: {
      collector_id: "hermes-passive",
      collector_version: "0.1.0",
      source_record_fingerprint: "1234567890abcdef",
      usage_quality: "runtime_reported",
      timing_quality: "runtime_reported",
      content_stored: false
    }
  };
}

test("valid canonical event preserves zero, null and provenance", () => {
  const event = validateUsageEvent(validEvent());
  assert.equal(event.usage.input_tokens, 0);
  assert.equal(event.usage.reasoning_tokens, null);
  assert.equal(event.actual_charge, null);
  assert.equal(event.provenance.content_stored, false);
});

test("rejects unknown fields instead of silently dropping them", () => {
  const input = validEvent();
  input.secret_prompt = "do not accept me";
  assert.throws(() => validateUsageEvent(input), /\$\.secret_prompt: unknown field/);
});

test("rejects negative and unsafe token counts", () => {
  const negative = validEvent();
  negative.usage.input_tokens = -1;
  assert.throws(() => validateUsageEvent(negative), /input_tokens/);

  const unsafe = validEvent();
  unsafe.usage.input_tokens = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => validateUsageEvent(unsafe), /input_tokens/);
});

test("rejects content storage in canonical telemetry events", () => {
  const input = validEvent();
  input.provenance.content_stored = true;
  assert.throws(() => validateUsageEvent(input), /content_stored: must be false/);
});

test("rejects NUL and malformed date-times", () => {
  const nul = validEvent();
  nul.source.runtime = "hermes\u0000evil";
  assert.throws(() => validateUsageEvent(nul), /must not contain NUL/);

  const badDate = validEvent();
  badDate.observed_at = "2026-09-12 15:00:00";
  assert.throws(() => validateUsageEvent(badDate), /ISO 8601/);
});

test("rejects timing that ends before it starts", () => {
  const input = validEvent();
  input.timing.ended_at = "2026-09-12T14:00:00Z";
  assert.throws(() => validateUsageEvent(input), /ended_at: must not be earlier/);
});

test("accepts zero actual charge without confusing it with unknown", () => {
  const input = validEvent();
  input.actual_charge = {
    amount: "0",
    currency: "USD",
    source: "provider_reported",
    external_charge_id: "free-request"
  };
  const event = validateUsageEvent(input);
  assert.equal(event.actual_charge?.amount, "0");
  assert.equal(event.actual_charge?.currency, "USD");
});

test("cost status vocabulary is closed", () => {
  assert.equal(validateCostStatus("ACTUAL"), "ACTUAL");
  assert.equal(validateCostStatus("CALCULATED"), "CALCULATED");
  assert.equal(validateCostStatus("UNKNOWN"), "UNKNOWN");
  assert.throws(() => validateCostStatus("ESTIMATED"), TokenProtocolValidationError);
});

test("timing timestamps must remain monotonic across intermediate milestones", () => {
  const input = validEvent();
  input.timing.first_byte_at = "2026-09-12T14:59:59.500Z";
  input.timing.first_token_at = "2026-09-12T14:59:59.000Z";
  assert.throws(() => validateUsageEvent(input), /first_token_at: must not be earlier/);

  const second = validEvent();
  second.timing.first_token_at = "2026-09-12T14:59:59.000Z";
  second.timing.last_token_at = "2026-09-12T14:59:58.900Z";
  assert.throws(() => validateUsageEvent(second), /last_token_at: must not be earlier/);
});

test("canonical ACTUAL money requires exact decimal text and preserves arbitrary decimal precision", () => {
  const input = validEvent();
  input.actual_charge = {
    amount: "0.12345678901234567890123456789",
    currency: "USD",
    source: "provider_reported"
  };
  assert.equal(validateUsageEvent(input).actual_charge?.amount, "0.12345678901234567890123456789");

  const numeric = validEvent();
  numeric.actual_charge = { amount: 0.1, currency: "USD", source: "provider_reported" };
  assert.throws(() => validateUsageEvent(numeric), /actual_charge.amount: must be a string/);
});

test("runtime ID limit and published JSON Schema remain aligned at 500 characters", async () => {
  const event = validEvent();
  event.event_id = `e${"x".repeat(499)}`;
  assert.equal(validateUsageEvent(event).event_id.length, 500);
  event.event_id = `e${"x".repeat(500)}`;
  assert.throws(() => validateUsageEvent(event), /event_id/);

  const { readFileSync } = await import("node:fs");
  const schema = JSON.parse(readFileSync(new URL("../schemas/usage-event-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.event_id.maxLength, 500);
  assert.equal(schema.properties.actual_charge.properties.amount.type, "string");
});
