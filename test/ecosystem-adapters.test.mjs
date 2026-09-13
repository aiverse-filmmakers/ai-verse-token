import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTokenDashboardProjection } from "../dist/src/dashboard/index.js";
import { createTokenBrainAdapter } from "../dist/src/brain/index.js";
import { tokenMemoryEvidence, proposeTokenMemoryCandidate } from "../dist/src/memory/index.js";
import { tokenDataReference, createTokenDataProjection } from "../dist/src/data/index.js";
import { attributeMultipleBotsUsage } from "../dist/src/bots/index.js";
import { correlateTokenUsage } from "../dist/src/correlation/index.js";
import { createTokenCredentialHandle } from "../dist/src/connections/index.js";
import { openTokenReader } from "../dist/src/read/index.js";
import { openTokenLedger } from "../dist/src/storage/index.js";

function event(id, overrides = {}) {
  return {
    schema_version: "ai-verse-token/0.1",
    event_id: id,
    request_id: id,
    session_id: "session-1",
    task_id: overrides.task_id ?? "task-1",
    source: { runtime: "hermes", source_type: "test", source_record_id: `raw-${id}` },
    observed_at: overrides.observed_at ?? "2026-09-12T10:00:00Z",
    identity: { billing_platform: "openrouter", inference_provider: "anthropic", requested_model: "claude", resolved_model: "claude-sonnet" },
    scope: { workspace_id: "workspace-1", project_id: "project-1", agent_id: "agent-1" },
    usage: { input_tokens: 100, output_tokens: 20, reasoning_tokens: 5, cache_read_tokens: 50, cache_write_tokens: 0, total_tokens_reported: 175 },
    timing: { started_at: "2026-09-12T10:00:00Z", ended_at: "2026-09-12T10:00:01Z", wall_ms: 1000 },
    ...(overrides.actual_charge ? { actual_charge: overrides.actual_charge } : {}),
    provenance: { collector_id: "test", source_record_fingerprint: `fingerprint-${id}-0123456789`, usage_quality: "provider_reported", timing_quality: "provider_reported", content_stored: false }
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "token-ecosystem-"));
  const path = join(dir, "token.sqlite");
  const first = event("evt_ecosystem_1", { actual_charge: { amount: "0.1", currency: "USD", source: "provider_reported" } });
  const second = event("evt_ecosystem_2", { observed_at: "2026-09-12T10:01:00Z" });
  const ledger = openTokenLedger({ path });
  ledger.ingestUsageEvent(first);
  ledger.ingestUsageEvent(second);
  ledger.close();
  return { dir, path, first, second, cleanup() { rmSync(dir, { recursive: true, force: true }); } };
}

test("Dashboard projection is bounded/read-only and never exposes a SQLite path", () => {
  const f = fixture();
  try {
    const reader = openTokenReader({ path: f.path });
    const dashboard = createTokenDashboardProjection(reader);
    const overview = dashboard.overview();
    assert.equal(overview.summary.request_count, 2);
    assert.equal(overview.provenance.read_only, true);
    assert.equal(overview.provenance.opens_sqlite_directly, false);
    assert.equal(JSON.stringify(overview).includes(f.path), false);
    const models = dashboard.breakdown("resolved_model");
    assert.equal(models.rows[0].dimensions.resolved_model, "claude-sonnet");
    assert.equal(dashboard.timeline("hour").rollups.length, 1);
    reader.close();
  } finally { f.cleanup(); }
});

test("Brain adapter returns bounded privacy-safe usage answers only", () => {
  const f = fixture();
  try {
    const reader = openTokenReader({ path: f.path });
    const brain = createTokenBrainAdapter(reader);
    assert.equal(brain.summary().answer.request_count, 2);
    const recent = brain.recent(undefined, 1);
    assert.equal(recent.answer.length, 1);
    assert.equal(recent.provenance.bounded, true);
    assert.equal("source_record_id" in recent.answer[0].source, false);
    assert.equal("source_record_fingerprint" in recent.answer[0].provenance, false);
    assert.throws(() => brain.recent(undefined, 101), /1\.\.100/);
    reader.close();
  } finally { f.cleanup(); }
});

test("Memory bridge produces evidence/candidates but never an automatic Memory write", () => {
  const usage = event("evt_memory_1");
  const evidence = tokenMemoryEvidence(usage);
  assert.equal(evidence.uri, "token://event/evt_memory_1");
  assert.equal("source_record_id" in evidence, false);
  const candidate = proposeTokenMemoryCandidate({ title: "September build usage", summary: "Usage pattern worth remembering.", events: [usage] });
  assert.equal(candidate.auto_write, false);
  assert.equal(candidate.evidence[0].event_id, usage.event_id);
  assert.equal(JSON.stringify(candidate).includes("fingerprint-"), false);
});

test("Data bridge keeps Token as authority and does not transfer ledger ownership", () => {
  const f = fixture();
  try {
    const ref = tokenDataReference(f.first);
    assert.deepEqual(ref, { uri: "token://event/evt_ecosystem_1", authority: "ai-verse-token", ownership_transferred: false, event_id: "evt_ecosystem_1" });
    const reader = openTokenReader({ path: f.path });
    const projection = createTokenDataProjection(reader, undefined, new Date("2026-09-12T12:00:00Z"));
    assert.equal(projection.authority, "ai-verse-token");
    assert.equal(projection.ownership_transferred, false);
    assert.equal(projection.summary.request_count, 2);
    assert.equal(JSON.stringify(projection).includes(f.path), false);
    reader.close();
  } finally { f.cleanup(); }
});

test("Multiple Bots attribution maps TeamRun to run_id and fails closed on attribution conflicts", () => {
  const usage = event("evt_bots_1");
  const attributed = attributeMultipleBotsUsage(usage, {
    bot_id: "bot-research",
    worker_id: "worker-7",
    team_run_id: "teamrun-42",
    task_id: "task-1",
    workspace_id: "workspace-1"
  });
  assert.equal(attributed.run_id, "teamrun-42");
  assert.equal(attributed.scope.bot_id, "bot-research");
  assert.equal(attributed.scope.worker_id, "worker-7");
  assert.throws(() => attributeMultipleBotsUsage(attributed, { worker_id: "worker-8" }), (error) => error?.code === "ATTRIBUTION_CONFLICT");
});

test("Skills/Automations correlation enriches only absent exact scope fields", () => {
  const usage = event("evt_corr_1");
  const correlated = correlateTokenUsage(usage, { skill_id: "skill-social", automation_id: "automation-post", tool_id: "tool-publish", run_id: "run-1" });
  assert.equal(correlated.scope.skill_id, "skill-social");
  assert.equal(correlated.scope.automation_id, "automation-post");
  assert.equal(correlated.run_id, "run-1");
  assert.throws(() => correlateTokenUsage(correlated, { skill_id: "skill-other" }), (error) => error?.code === "ATTRIBUTION_CONFLICT");
});

test("Connections integration exposes opaque credential handles and never accepts secret values", () => {
  const handle = createTokenCredentialHandle({ connection_id: "openrouter-main", credential_name: "api-key", billing_platform: "openrouter", inference_provider: "anthropic" });
  assert.deepEqual(handle, {
    connection_id: "openrouter-main",
    credential_name: "api-key",
    billing_platform: "openrouter",
    inference_provider: "anthropic",
    contains_secret: false
  });
  assert.equal(JSON.stringify(handle).includes("sk-"), false);
  assert.throws(() => createTokenCredentialHandle({ connection_id: "openrouter-main", credential_name: "api-key", billing_platform: "openrouter", api_key: "sk-secret" }), /never secret values/);
  assert.throws(() => createTokenCredentialHandle({ connection_id: "../escape", credential_name: "api-key", billing_platform: "openrouter" }), /safe opaque identifier/);
});

test("ecosystem adapters remain install-order independent with no sibling package dependency", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  for (const name of ["dashboard", "brain", "memory", "data", "bots", "connections", "correlation"]) {
    assert.ok(packageJson.exports[`./${name}`]);
  }
});
