import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  normalizeBifrostLog,
  normalizeLiteLLMSpendLog,
  normalizeOpenAICompatibleGateway,
  normalizeOpenTelemetryGenAISpan
} from "../dist/src/adapters/index.js";
import { TokenLedgerError, openTokenLedger } from "../dist/src/storage/index.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ai-verse-token-otel-gateway-"));
  return { root, dbPath: join(root, "token.sqlite") };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function event({ id, collector, runtime, requestId = "resp_shared", usage = {}, scope, actualCharge } = {}) {
  return {
    schema_version: "ai-verse-token/0.1",
    event_id: id,
    request_id: requestId,
    source: {
      runtime,
      source_type: `${runtime}.test`,
      source_record_id: id,
      source_platform: "openai"
    },
    observed_at: "2026-09-12T18:00:00Z",
    identity: {
      billing_platform: "openai",
      inference_provider: "openai",
      requested_model: "gpt-5.6-sol",
      resolved_model: "gpt-5.6-sol"
    },
    ...(scope ? { scope } : {}),
    usage: {
      input_tokens: 300,
      output_tokens: 100,
      reasoning_tokens: 200,
      cached_input_tokens: 600,
      total_tokens_reported: 1200,
      ...usage
    },
    timing: {},
    ...(actualCharge ? { actual_charge: actualCharge } : {}),
    provenance: {
      collector_id: collector,
      collector_version: "0.1.0",
      source_record_fingerprint: `${collector.replace(/[^a-z0-9]/gi, "")}abcdef0123456789`,
      usage_quality: runtime === "openai" ? "provider_reported" : "runtime_reported",
      timing_quality: "unknown",
      content_stored: false
    }
  };
}

test("OpenTelemetry GenAI span decomposes inclusive cache/reasoning counters and ignores sensitive content attributes", () => {
  const result = normalizeOpenTelemetryGenAISpan({
    trace_id: "trace-1",
    span_id: "span-1",
    start_time: "2026-09-12T18:00:00.000Z",
    end_time: "2026-09-12T18:00:02.000Z",
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "gpt-5.6-sol",
      "gen_ai.response.model": "gpt-5.6-sol-2026-09-01",
      "gen_ai.response.id": "resp_otel_1",
      "gen_ai.usage.input_tokens": 1000,
      "gen_ai.usage.cache_creation.input_tokens": 100,
      "gen_ai.usage.cache_read.input_tokens": 600,
      "gen_ai.usage.output_tokens": 300,
      "gen_ai.usage.reasoning.output_tokens": 200,
      "gen_ai.response.time_to_first_chunk": 0.4,
      "gen_ai.input.messages": [{ role: "user", content: "secret prompt" }],
      "gen_ai.output.messages": [{ role: "assistant", content: "secret answer" }]
    }
  }, { billingPlatform: "openai" });
  assert.deepEqual(result.event.usage, {
    context_input_tokens: 1000,
    input_tokens: 300,
    output_tokens: 100,
    cache_write_tokens: 100,
    cache_read_tokens: 600,
    reasoning_tokens: 200,
    total_tokens_reported: 1300
  });
  assert.equal(result.event.timing.wall_ms, 2000);
  assert.equal(result.event.timing.ttft_ms, 400);
  assert.equal(result.event.identity.billing_platform, "openai");
  assert.deepEqual(result.correlation_keys, [
    { kind: "otel_span", value: "trace-1:span-1" },
    { kind: "response_id", value: "resp_otel_1" }
  ]);
  const serialized = JSON.stringify(result.event);
  assert.equal(serialized.includes("secret prompt"), false);
  assert.equal(serialized.includes("secret answer"), false);
});

test("OpenTelemetry OTLP attribute arrays and nanosecond times are accepted without using trace id alone as a strong call key", () => {
  const result = normalizeOpenTelemetryGenAISpan({
    traceId: "trace-shared",
    spanId: "span-a",
    startTimeUnixNano: "1789236000000000000",
    endTimeUnixNano: "1789236000500000000",
    attributes: [
      { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
      { key: "gen_ai.provider.name", value: { stringValue: "anthropic" } },
      { key: "gen_ai.request.model", value: { stringValue: "claude-sonnet-5" } },
      { key: "gen_ai.usage.input_tokens", value: { intValue: "20" } },
      { key: "gen_ai.usage.output_tokens", value: { intValue: "5" } }
    ]
  });
  assert.equal(result.event.timing.wall_ms, 500);
  assert.deepEqual(result.correlation_keys, [{ kind: "otel_span", value: "trace-shared:span-a" }]);
  assert.equal(result.event.identity.billing_platform, null);
});

test("LiteLLM cache hit does not replay original model tokens or promote gateway spend to ACTUAL", () => {
  const result = normalizeLiteLLMSpendLog({
    request_id: "req-cache-1",
    response_id: "resp-cache-1",
    model: "gpt-5.6-sol",
    custom_llm_provider: "openai",
    cache_hit: true,
    prompt_tokens: 5000,
    completion_tokens: 600,
    spend: 0,
    startTime: "2026-09-12T18:00:00Z",
    endTime: "2026-09-12T18:00:00.020Z"
  });
  assert.equal(result.gateway_cache_hit, true);
  assert.deepEqual(result.event.usage, {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    request_units: 1,
    total_tokens_reported: 0
  });
  assert.equal(result.gateway_calculated_cost_usd, 0);
  assert.equal(result.event.actual_charge, undefined);
});

test("LiteLLM normal request decomposes normalized usage and keeps gateway cost diagnostic only", () => {
  const result = normalizeLiteLLMSpendLog({
    request_id: "req-litellm-1",
    response_id: "resp-litellm-1",
    upstream_request_id: "upstream-1",
    model: "gpt-5.6-sol",
    custom_llm_provider: "openai",
    cache_hit: false,
    prompt_tokens: 1000,
    completion_tokens: 300,
    prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 },
    completion_tokens_details: { reasoning_tokens: 200 },
    spend: 0.0123,
    startTime: "2026-09-12T18:00:00Z",
    endTime: "2026-09-12T18:00:02Z"
  });
  assert.deepEqual(result.event.usage, {
    context_input_tokens: 1000,
    input_tokens: 300,
    output_tokens: 100,
    cache_read_tokens: 600,
    cache_write_tokens: 100,
    reasoning_tokens: 200,
    total_tokens_reported: 1300
  });
  assert.equal(result.gateway_calculated_cost_usd, 0.0123);
  assert.equal(result.event.actual_charge, undefined);
  assert.ok(result.correlation_keys.some((key) => key.kind === "upstream_request_id" && key.value === "upstream-1"));
});

test("Bifrost streaming all-zero log is treated as unknown token telemetry, not a proven zero-token model call", () => {
  const result = normalizeBifrostLog({
    request_id: "req-bifrost-1",
    provider: "openai",
    model: "gpt-5.6-sol",
    timestamp: "2026-09-12T18:00:00Z",
    streaming: true,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    latency_ms: 1200
  });
  assert.deepEqual(result.event.usage, { request_units: 1 });
  assert.equal(result.event.provenance.usage_quality, "unknown");
  assert.equal(result.gateway_calculated_cost_usd, 0);
  assert.equal(result.event.actual_charge, undefined);
});

test("generic OpenAI-compatible gateway remains a telemetry adapter and never asserts actual money", () => {
  const result = normalizeOpenAICompatibleGateway({
    id: "resp-gateway-1",
    model: "gpt-5.6-sol",
    usage: { prompt_tokens: 100, completion_tokens: 20 }
  }, {
    runtime: "custom-gateway",
    billingPlatform: "openai",
    inferenceProvider: "openai",
    observedAt: "2026-09-12T18:00:00Z",
    upstreamRequestId: "openai-upstream-1"
  });
  assert.equal(result.event.source.runtime, "custom-gateway");
  assert.equal(result.event.actual_charge, undefined);
  assert.deepEqual(result.event.usage, { context_input_tokens: 100, input_tokens: 100, output_tokens: 20, total_tokens_reported: 120 });
});

test("strong cross-source correlation keeps raw observations but normal query and aggregate count one canonical call", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    ledger.ingestUsageEvent(event({
      id: "evt_local",
      collector: "local-runtime",
      runtime: "hermes",
      scope: { workspace_id: "workspace-1", agent_id: "agent-1" }
    }));
    ledger.ingestUsageEvent(event({ id: "evt_gateway", collector: "gateway-runtime", runtime: "litellm" }));
    ledger.ingestUsageEvent(event({
      id: "evt_provider",
      collector: "provider-api",
      runtime: "openai",
      actualCharge: {
        amount: "0.0123",
        currency: "USD",
        source: "provider_reported",
        external_charge_id: "charge-1",
        reported_at: "2026-09-12T18:00:01Z"
      }
    }));

    const page = ledger.queryUsage({});
    assert.equal(page.events.length, 1);
    const canonical = page.events[0];
    assert.equal(canonical.source.runtime, "hermes");
    assert.equal(canonical.provenance.usage_quality, "derived_exact");
    assert.equal(canonical.scope.workspace_id, "workspace-1");
    assert.equal(canonical.actual_charge.amount, "0.0123");
    assert.equal(canonical.usage.input_tokens, 300);
    const aggregate = ledger.aggregateUsage({ metrics: [{ operator: "count" }, { operator: "sum", field: "input_tokens" }] });
    assert.equal(aggregate.rows[0].metrics.count, 1);
    assert.equal(aggregate.rows[0].metrics.sum_input_tokens, 300);
    ledger.close();

    const raw = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM usage_events").get().n, 5);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM event_supersessions").get().n, 4);
    raw.close();
  } finally {
    cleanup(root);
  }
});

test("strong correlation with conflicting exact token usage fails closed and rolls back the new observation", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    ledger.ingestUsageEvent(event({ id: "evt_a", collector: "collector-a", runtime: "hermes" }));
    assert.throws(
      () => ledger.ingestUsageEvent(event({ id: "evt_b", collector: "collector-b", runtime: "litellm", usage: { input_tokens: 301 } })),
      (error) => error instanceof TokenLedgerError && error.code === "INGEST_CONFLICT"
    );
    assert.equal(ledger.queryUsage({}).events.length, 1);
    ledger.close();
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM usage_events").get().n, 1);
    raw.close();
  } finally {
    cleanup(root);
  }
});

test("trace sharing alone never dedupes two different model spans", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    for (const spanId of ["span-1", "span-2"]) {
      const normalized = normalizeOpenTelemetryGenAISpan({
        trace_id: "trace-same",
        span_id: spanId,
        start_time: "2026-09-12T18:00:00Z",
        end_time: "2026-09-12T18:00:01Z",
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": "openai",
          "gen_ai.request.model": "gpt-5.6-sol",
          "gen_ai.usage.input_tokens": 10,
          "gen_ai.usage.output_tokens": 2
        }
      }, { billingPlatform: "openai" });
      ledger.ingestUsageEvent(normalized.event, { correlationKeys: normalized.correlation_keys });
    }
    assert.equal(ledger.queryUsage({}).events.length, 2);
    ledger.close();
  } finally {
    cleanup(root);
  }
});

test("event supersession records are append-only at SQLite level", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    ledger.ingestUsageEvent(event({ id: "evt_one", collector: "one", runtime: "hermes" }));
    ledger.ingestUsageEvent(event({ id: "evt_two", collector: "two", runtime: "litellm" }));
    ledger.close();
    const raw = new DatabaseSync(dbPath);
    assert.throws(() => raw.exec("UPDATE event_supersessions SET reason='x'"), /append-only/);
    assert.throws(() => raw.exec("DELETE FROM event_supersessions"), /append-only/);
    raw.close();
  } finally {
    cleanup(root);
  }
});

test("replaying a raw observation already superseded does not manufacture another canonical chain", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    const first = event({ id: "evt_first", collector: "first", runtime: "hermes" });
    ledger.ingestUsageEvent(first);
    ledger.ingestUsageEvent(event({ id: "evt_second", collector: "second", runtime: "litellm" }));
    const before = ledger.queryUsage({}).events[0].event_id;
    const replay = ledger.ingestUsageEvent(first);
    assert.equal(replay.status, "duplicate");
    const after = ledger.queryUsage({}).events[0].event_id;
    assert.equal(after, before);
    ledger.close();
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM usage_events").get().n, 3);
    raw.close();
  } finally {
    cleanup(root);
  }
});

test("strong correlation with conflicting session identity fails closed", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    ledger.ingestUsageEvent({ ...event({ id: "evt_session_a", collector: "collector-a", runtime: "hermes" }), session_id: "session-a" });
    assert.throws(
      () => ledger.ingestUsageEvent({ ...event({ id: "evt_session_b", collector: "collector-b", runtime: "openai" }), session_id: "session-b" }),
      (error) => error instanceof TokenLedgerError && error.code === "INGEST_CONFLICT"
    );
    assert.equal(ledger.queryUsage({}).events.length, 1);
    ledger.close();
  } finally {
    cleanup(root);
  }
});
