import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { IdentityResolver } from "../dist/src/identity/index.js";
import { TokenLedgerError, openTokenLedger } from "../dist/src/storage/index.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ai-verse-token-phase1-"));
  return { root, dbPath: join(root, "token.sqlite") };
}

function event(id, fingerprint, overrides = {}) {
  const base = {
    schema_version: "ai-verse-token/0.1",
    event_id: id,
    request_id: `req_${id}`,
    session_id: "phase1-session",
    source: { runtime: "hermes", source_type: "phase1", source_platform: "openrouter.ai" },
    observed_at: "2026-09-12T18:00:00Z",
    identity: {
      billing_platform: null,
      inference_provider: null,
      requested_model: "anthropic/sonnet",
      resolved_model: null
    },
    scope: { workspace_id: "workspace-a", project_id: "project-a", agent_id: "hermes-main" },
    usage: { input_tokens: 0, output_tokens: 20, reasoning_tokens: null },
    timing: { wall_ms: 1250, ttft_ms: null },
    provenance: {
      collector_id: "phase1-collector",
      collector_version: "0.1.0",
      source_record_fingerprint: fingerprint,
      usage_quality: "runtime_reported",
      timing_quality: "runtime_reported",
      content_stored: false
    }
  };
  return { ...base, ...overrides };
}

const resolver = new IdentityResolver({
  modelAliases: [{
    id: "phase1-sonnet",
    billingPlatform: "openrouter",
    matchField: "requested_model",
    alias: "anthropic/sonnet",
    resolvedModel: "anthropic/sonnet-20260901",
    inferenceProvider: "anthropic"
  }]
});

test("Phase 1 end-to-end persists, reopens, dedupes and preserves zero/null/missingness", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    const first = resolver.resolveUsageEvent(event("evt_phase1_a", "phase1-fingerprint-a"));
    assert.equal(first.resolution.pricingIdentityReady, true);
    ledger.ingestUsageEvent(first.event, { checkpoint: { cursor: "1" } });
    const replay = ledger.ingestUsageEvent(first.event, { checkpoint: { cursor: "2" } });
    assert.equal(replay.status, "duplicate");
    ledger.close();

    const reopened = openTokenLedger({ path: dbPath, mode: "read-only" });
    const page = reopened.queryUsage({ filter: { workspace_id: "workspace-a" } });
    assert.equal(page.events.length, 1);
    const stored = page.events[0];
    assert.equal(stored?.usage.input_tokens, 0);
    assert.equal(stored?.usage.reasoning_tokens, null);
    assert.equal(Object.prototype.hasOwnProperty.call(stored?.usage ?? {}, "cache_read_tokens"), false);
    assert.equal(stored?.identity.billing_platform, "openrouter");
    assert.equal(stored?.identity.resolved_model, "anthropic/sonnet-20260901");
    assert.equal(reopened.collectorCheckpoint("phase1-collector")?.cursor, "2");
    assert.equal(reopened.aggregateUsage({ metrics: [{ operator: "count" }, { operator: "sum", field: "output_tokens" }] }).rows[0]?.metrics.count, 1);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 1 WAL permits independent writer and read-only connections without state duplication", () => {
  const { root, dbPath } = fixture();
  try {
    const writerA = openTokenLedger({ path: dbPath });
    writerA.ingestUsageEvent(resolver.resolveUsageEvent(event("evt_phase1_1", "phase1-fingerprint-1")).event);
    const reader = openTokenLedger({ path: dbPath, mode: "read-only" });
    assert.equal(reader.queryUsage({}).events.length, 1);

    const writerB = openTokenLedger({ path: dbPath, mode: "open-existing" });
    writerB.ingestUsageEvent(resolver.resolveUsageEvent(event("evt_phase1_2", "phase1-fingerprint-2", {
      request_id: "req_phase1_2",
      observed_at: "2026-09-12T18:01:00Z"
    })).event);
    assert.equal(reader.queryUsage({}).events.length, 2);

    writerB.close();
    reader.close();
    writerA.close();
    const finalReader = openTokenLedger({ path: dbPath, mode: "read-only" });
    assert.equal(finalReader.aggregateUsage({ metrics: [{ operator: "count" }] }).rows[0]?.metrics.count, 2);
    finalReader.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 1 open detects required-schema tampering", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    ledger.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec("DROP TRIGGER usage_events_no_update;");
    raw.close();
    assert.throws(
      () => openTokenLedger({ path: dbPath, mode: "open-existing" }),
      (error) => error instanceof TokenLedgerError && error.code === "FORMAT_MISMATCH"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 1 rejects malformed non-SQLite bytes rather than replacing them", () => {
  const { root, dbPath } = fixture();
  try {
    const bytes = Buffer.from("definitely-not-a-sqlite-database\n", "utf8");
    writeFileSync(dbPath, bytes);
    assert.throws(() => openTokenLedger({ path: dbPath, mode: "open-existing" }), TokenLedgerError);
    assert.deepEqual(readFileSync(dbPath), bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 1 CI contract keeps Node 22 and 24 in the matrix", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /matrix:\s*[\s\S]*node:\s*\[22, 24\]/);
  assert.match(workflow, /npm run ci/);
  assert.match(workflow, /ubuntu-latest/);
});
