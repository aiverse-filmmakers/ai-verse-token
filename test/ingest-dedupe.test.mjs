import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { TokenLedgerError, openTokenLedger } from "../dist/src/storage/index.js";
import { trustedActual } from "./trusted-actual-fixture.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ai-verse-token-ingest-"));
  return { root, dbPath: join(root, "token.sqlite") };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function validEvent(overrides = {}) {
  const event = {
    schema_version: "ai-verse-token/0.1",
    event_id: "evt_ingest_1",
    request_id: "req_provider_1",
    session_id: "session-1",
    source: {
      runtime: "hermes",
      runtime_version: "1.2.3",
      source_type: "sqlite-session",
      source_record_id: "row-1",
      source_platform: "openrouter"
    },
    observed_at: "2026-09-12T16:00:00Z",
    identity: {
      billing_platform: "openrouter",
      inference_provider: "anthropic",
      requested_model: "anthropic/claude-sonnet-4",
      resolved_model: "anthropic/claude-sonnet-4",
      service_tier: "standard"
    },
    scope: {
      workspace_id: "workspace-1",
      project_id: "project-1",
      agent_id: "hermes-main"
    },
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 500,
      reasoning_tokens: null
    },
    timing: {
      started_at: "2026-09-12T15:59:58Z",
      first_token_at: "2026-09-12T15:59:58.400Z",
      ended_at: "2026-09-12T16:00:00Z",
      wall_ms: 2000,
      ttft_ms: 400
    },
    actual_charge: {
      amount: "0.0123",
      currency: "USD",
      source: "provider_reported",
      external_charge_id: "gen-123",
      reported_at: "2026-09-12T16:00:01Z"
    },
    provenance: {
      collector_id: "hermes-passive",
      collector_version: "0.1.0",
      source_record_fingerprint: "abcdef0123456789",
      usage_quality: "runtime_reported",
      timing_quality: "runtime_reported",
      content_stored: false
    }
  };
  return Object.assign(event, overrides);
}

function trustedEvent(overrides = {}) {
  return trustedActual(validEvent(overrides));
}

function eventCount(path) {
  const raw = new DatabaseSync(path, { readOnly: true });
  const count = raw.prepare("SELECT COUNT(*) AS count FROM usage_events").get().count;
  raw.close();
  return count;
}

test("inserts one canonical immutable usage event", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    const result = ledger.ingestUsageEvent(trustedEvent());
    assert.deepEqual(result, {
      status: "inserted",
      eventId: "evt_ingest_1",
      duplicateOf: null,
      correlationKeysAdded: 2,
      checkpointUpdated: false
    });
    ledger.close();
    assert.equal(eventCount(dbPath), 1);
  } finally {
    cleanup(root);
  }
});

test("exact event replay is a no-op", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    ledger.ingestUsageEvent(trustedEvent());
    const replay = ledger.ingestUsageEvent(trustedEvent());
    assert.equal(replay.status, "duplicate");
    assert.equal(replay.duplicateOf, "evt_ingest_1");
    assert.equal(replay.correlationKeysAdded, 0);
    ledger.close();
    assert.equal(eventCount(dbPath), 1);
  } finally {
    cleanup(root);
  }
});

test("same source fingerprint dedupes a replay with a new event id and observation time", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    ledger.ingestUsageEvent(trustedEvent());
    const replay = validEvent({ event_id: "evt_ingest_replay", observed_at: "2026-09-12T17:00:00Z" });
    replay.provenance.collector_version = "0.2.0";
    const result = ledger.ingestUsageEvent(trustedActual(replay));
    assert.equal(result.status, "duplicate");
    assert.equal(result.eventId, "evt_ingest_1");
    assert.equal(result.duplicateOf, "evt_ingest_1");
    ledger.close();
    assert.equal(eventCount(dbPath), 1);
  } finally {
    cleanup(root);
  }
});

test("reused source fingerprint with changed usage fails closed", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    ledger.ingestUsageEvent(trustedEvent());
    const changed = validEvent({ event_id: "evt_changed" });
    changed.usage.input_tokens = 9999;
    assert.throws(
      () => ledger.ingestUsageEvent(trustedActual(changed)),
      (error) => error instanceof TokenLedgerError && error.code === "INGEST_CONFLICT"
    );
    ledger.close();
    assert.equal(eventCount(dbPath), 1);
  } finally {
    cleanup(root);
  }
});

test("same event id with changed canonical data fails closed", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    ledger.ingestUsageEvent(trustedEvent());
    const changed = validEvent();
    changed.identity.resolved_model = "different/model";
    assert.throws(
      () => ledger.ingestUsageEvent(trustedActual(changed)),
      (error) => error instanceof TokenLedgerError && error.code === "INGEST_CONFLICT"
    );
    ledger.close();
  } finally {
    cleanup(root);
  }
});

test("SQLite blocks raw event update and delete", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    ledger.ingestUsageEvent(trustedEvent());
    ledger.close();
    const raw = new DatabaseSync(dbPath);
    assert.throws(() => raw.exec("UPDATE usage_events SET input_tokens = 5 WHERE event_id='evt_ingest_1'"), /immutable/);
    assert.throws(() => raw.exec("DELETE FROM usage_events WHERE event_id='evt_ingest_1'"), /immutable/);
    raw.close();
    assert.equal(eventCount(dbPath), 1);
  } finally {
    cleanup(root);
  }
});

test("checkpoint advancement commits atomically with insert and duplicate replay", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    const first = ledger.ingestUsageEvent(trustedEvent(), { checkpoint: { key: "sessions", cursor: "row-1" } });
    assert.equal(first.checkpointUpdated, true);
    assert.equal(ledger.collectorCheckpoint("hermes-passive", "sessions")?.cursor, "row-1");

    const replay = ledger.ingestUsageEvent(trustedEvent(), { checkpoint: { key: "sessions", cursor: "row-2" } });
    assert.equal(replay.status, "duplicate");
    assert.equal(ledger.collectorCheckpoint("hermes-passive", "sessions")?.cursor, "row-2");
    ledger.close();
    assert.equal(eventCount(dbPath), 1);
  } finally {
    cleanup(root);
  }
});

test("stores automatic and explicit correlation keys without duplication", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    const result = ledger.ingestUsageEvent(trustedEvent(), {
      correlationKeys: [
        { kind: "trace_id", value: "trace-123" },
        { kind: "request_id", value: "req_provider_1" }
      ]
    });
    assert.equal(result.correlationKeysAdded, 3);
    ledger.close();

    const raw = new DatabaseSync(dbPath, { readOnly: true });
    const rows = raw.prepare("SELECT key_kind, key_value FROM event_correlations ORDER BY key_kind, key_value").all()
      .map((row) => ({ key_kind: row.key_kind, key_value: row.key_value }));
    raw.close();
    assert.deepEqual(rows, [
      { key_kind: "external_charge_id", key_value: "gen-123" },
      { key_kind: "request_id", key_value: "req_provider_1" },
      { key_kind: "trace_id", key_value: "trace-123" }
    ]);
  } finally {
    cleanup(root);
  }
});

test("read-only ledger rejects ingest", () => {
  const { root, dbPath } = fixture();
  try {
    const writer = openTokenLedger({ path: dbPath });
    writer.close();
    const reader = openTokenLedger({ path: dbPath, mode: "read-only" });
    assert.throws(
      () => reader.ingestUsageEvent(trustedEvent()),
      (error) => error instanceof TokenLedgerError && error.code === "READ_ONLY"
    );
    reader.close();
  } finally {
    cleanup(root);
  }
});

test("invalid correlation/checkpoint metadata inserts nothing", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    assert.throws(
      () => ledger.ingestUsageEvent(trustedEvent(), { correlationKeys: [{ kind: "BAD KIND", value: "x" }] }),
      (error) => error instanceof TokenLedgerError && error.code === "INGEST_INVALID"
    );
    assert.throws(
      () => ledger.ingestUsageEvent(trustedEvent(), { checkpoint: { cursor: "" } }),
      (error) => error instanceof TokenLedgerError && error.code === "INGEST_INVALID"
    );
    ledger.close();
    assert.equal(eventCount(dbPath), 0);
  } finally {
    cleanup(root);
  }
});
