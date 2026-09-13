import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TokenQueryError } from "../dist/src/query/index.js";
import { openTokenLedger } from "../dist/src/storage/index.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ai-verse-token-query-"));
  return { root, dbPath: join(root, "token.sqlite") };
}

function event(index, overrides = {}) {
  const minute = String(index).padStart(2, "0");
  const base = {
    schema_version: "ai-verse-token/0.1",
    event_id: `evt_q_${index}`,
    request_id: `req_q_${index}`,
    session_id: index <= 3 ? "session-a" : "session-b",
    task_id: index % 2 === 0 ? "task-even" : "task-odd",
    source: { runtime: index % 2 === 0 ? "hermes" : "codex", source_type: "test" },
    observed_at: `2026-09-12T12:${minute}:00Z`,
    identity: {
      billing_platform: index <= 4 ? "openrouter" : "openai",
      inference_provider: index <= 4 ? "anthropic" : "openai",
      requested_model: index <= 4 ? "anthropic/sonnet" : "gpt-5.6",
      resolved_model: index <= 4 ? "anthropic/sonnet-v1" : "gpt-5.6-v1",
      service_tier: "standard"
    },
    scope: {
      workspace_id: index <= 5 ? "workspace-a" : "workspace-b",
      project_id: index <= 4 ? "project-a" : "project-b",
      agent_id: index % 2 === 0 ? "agent-a" : "agent-b"
    },
    usage: {
      input_tokens: index * 100,
      output_tokens: index * 10,
      cache_read_tokens: index === 3 ? null : index * 5
    },
    timing: { wall_ms: index * 1000, ttft_ms: index * 100 },
    provenance: {
      collector_id: "query-fixture",
      source_record_fingerprint: `fingerprint-query-${String(index).padStart(4, "0")}`,
      usage_quality: "provider_reported",
      timing_quality: "runtime_reported",
      content_stored: false
    }
  };
  return { ...base, ...overrides };
}

function seed(ledger) {
  for (let i = 1; i <= 7; i += 1) ledger.ingestUsageEvent(event(i));
}

test("query pages deterministically with opaque cursor and no overlap", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    seed(ledger);
    const first = ledger.queryUsage({ limit: 3 });
    assert.deepEqual(first.events.map((item) => item.event_id), ["evt_q_7", "evt_q_6", "evt_q_5"]);
    assert.equal(first.hasMore, true);
    assert.match(first.nextCursor, /^v1\|/);
    const second = ledger.queryUsage({ limit: 3, cursor: first.nextCursor });
    assert.deepEqual(second.events.map((item) => item.event_id), ["evt_q_4", "evt_q_3", "evt_q_2"]);
    assert.equal(second.hasMore, true);
    const third = ledger.queryUsage({ limit: 3, cursor: second.nextCursor });
    assert.deepEqual(third.events.map((item) => item.event_id), ["evt_q_1"]);
    assert.equal(third.hasMore, false);
    assert.equal(third.nextCursor, null);
    ledger.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("query supports ascending order, half-open time windows and exact request/session filters", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    seed(ledger);
    const window = ledger.queryUsage({
      order: "asc",
      filter: { observed_from: "2026-09-12T12:02:00Z", observed_to: "2026-09-12T12:05:00Z" }
    });
    assert.deepEqual(window.events.map((item) => item.event_id), ["evt_q_2", "evt_q_3", "evt_q_4"]);
    const session = ledger.queryUsage({ filter: { session_id: "session-a", request_id: "req_q_2" } });
    assert.deepEqual(session.events.map((item) => item.event_id), ["evt_q_2"]);
    ledger.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("query distinguishes explicit null filter from absent filter", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    seed(ledger);
    const unknownPlatform = event(8, {
      event_id: "evt_unknown_platform",
      request_id: "req_unknown_platform",
      observed_at: "2026-09-12T12:08:00Z",
      identity: { billing_platform: null, requested_model: null, resolved_model: null },
      provenance: {
        collector_id: "query-fixture",
        source_record_fingerprint: "fingerprint-query-0008",
        usage_quality: "runtime_reported",
        timing_quality: "unknown",
        content_stored: false
      }
    });
    ledger.ingestUsageEvent(unknownPlatform);
    assert.equal(ledger.queryUsage({ filter: { billing_platform: null } }).events.length, 1);
    assert.equal(ledger.queryUsage({}).events.length, 8);
    ledger.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("aggregate groups by fixed dimensions and computes count/sum/avg/min/max", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    seed(ledger);
    const result = ledger.aggregateUsage({
      groupBy: ["billing_platform", "resolved_model"],
      metrics: [
        { operator: "count" },
        { operator: "sum", field: "input_tokens" },
        { operator: "avg", field: "output_tokens" },
        { operator: "min", field: "input_tokens" },
        { operator: "max", field: "input_tokens" }
      ]
    });
    assert.equal(result.truncated, false);
    assert.deepEqual(result.rows, [
      {
        dimensions: { billing_platform: "openai", resolved_model: "gpt-5.6-v1" },
        metrics: { count: 3, sum_input_tokens: 1800, avg_output_tokens: 60, min_input_tokens: 500, max_input_tokens: 700 }
      },
      {
        dimensions: { billing_platform: "openrouter", resolved_model: "anthropic/sonnet-v1" },
        metrics: { count: 4, sum_input_tokens: 1000, avg_output_tokens: 25, min_input_tokens: 100, max_input_tokens: 400 }
      }
    ]);
    ledger.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("aggregate without group returns one bounded summary and preserves null semantics", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    seed(ledger);
    const result = ledger.aggregateUsage({
      filter: { session_id: "session-a" },
      metrics: [
        { operator: "count" },
        { operator: "sum", field: "cache_read_tokens" },
        { operator: "avg", field: "wall_ms" }
      ]
    });
    assert.deepEqual(result.rows, [{
      dimensions: {},
      metrics: { count: 3, sum_cache_read_tokens: null, avg_wall_ms: 2000 }
    }]);
    ledger.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("aggregate limit is hard-bounded and reports truncation", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    seed(ledger);
    const result = ledger.aggregateUsage({ groupBy: ["agent_id"], metrics: [{ operator: "count" }], limit: 1 });
    assert.equal(result.rows.length, 1);
    assert.equal(result.truncated, true);
    ledger.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("query validation rejects caller-controlled SQL-shaped fields, oversized limits and malformed cursors", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    assert.throws(() => ledger.queryUsage({ limit: 501 }), TokenQueryError);
    assert.throws(() => ledger.queryUsage({ cursor: "not-a-cursor" }), TokenQueryError);
    assert.throws(() => ledger.queryUsage({ filter: { "resolved_model OR 1=1": "x" } }), TokenQueryError);
    assert.throws(() => ledger.aggregateUsage({ groupBy: ["event_json"], metrics: [{ operator: "count" }] }), TokenQueryError);
    assert.throws(() => ledger.aggregateUsage({ metrics: [{ operator: "sum", field: "actual_charge_amount" }] }), TokenQueryError);
    ledger.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read-only ledger can query and aggregate", () => {
  const { root, dbPath } = fixture();
  try {
    const writer = openTokenLedger({ path: dbPath });
    seed(writer);
    writer.close();
    const reader = openTokenLedger({ path: dbPath, mode: "read-only" });
    assert.equal(reader.queryUsage({ limit: 2 }).events.length, 2);
    assert.equal(reader.aggregateUsage({ metrics: [{ operator: "count" }] }).rows[0]?.metrics.count, 7);
    reader.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integer aggregate remains exact beyond JavaScript safe-integer range", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    const large = Number.MAX_SAFE_INTEGER;
    ledger.ingestUsageEvent(event(21, {
      event_id: "evt_large_1", request_id: "req_large_1", observed_at: "2026-09-12T13:21:00Z",
      usage: { input_tokens: large }
    }));
    ledger.ingestUsageEvent(event(22, {
      event_id: "evt_large_2", request_id: "req_large_2", observed_at: "2026-09-12T13:22:00Z",
      usage: { input_tokens: large }
    }));
    const result = ledger.aggregateUsage({ metrics: [{ operator: "sum", field: "input_tokens" }] });
    assert.equal(result.rows[0].metrics.sum_input_tokens, "18014398509481982");
    ledger.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
