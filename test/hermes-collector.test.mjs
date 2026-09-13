import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CollectorRegistry,
  CollectorRunner,
  HERMES_PASSIVE_COLLECTOR,
  discoverHermesStateSources
} from "../dist/src/collectors/index.js";
import { openTokenLedger } from "../dist/src/storage/index.js";

function temp() {
  const dir = mkdtempSync(join(tmpdir(), "token-hermes-"));
  return { dir, hermes: join(dir, "state.db"), token: join(dir, "token.sqlite") };
}

function createHermes(path, { modelUsage = true } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT,
      model TEXT,
      started_at REAL,
      ended_at REAL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      billing_provider TEXT,
      billing_base_url TEXT,
      billing_mode TEXT,
      actual_cost_usd REAL,
      cost_status TEXT,
      cost_source TEXT,
      api_call_count INTEGER DEFAULT 0
    );
  `);
  if (modelUsage) {
    db.exec(`
      CREATE TABLE session_model_usage (
        session_id TEXT,
        model TEXT,
        billing_provider TEXT,
        billing_base_url TEXT,
        billing_mode TEXT,
        task TEXT,
        api_call_count INTEGER DEFAULT 0,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_write_tokens INTEGER DEFAULT 0,
        reasoning_tokens INTEGER DEFAULT 0,
        estimated_cost_usd REAL DEFAULT 0,
        actual_cost_usd REAL DEFAULT 0,
        cost_status TEXT,
        cost_source TEXT,
        first_seen REAL,
        last_seen REAL
      );
    `);
  }
  return db;
}

function insertSession(db, {
  id = "session-1",
  source = "telegram",
  model = "anthropic/claude-sonnet-4.6",
  started = 1_700_000_000,
  ended = 1_700_000_100,
  input = 100,
  output = 20,
  cacheRead = 10,
  cacheWrite = 5,
  reasoning = 3,
  provider = "openrouter",
  baseUrl = "https://openrouter.ai/api/v1",
  mode = "api",
  actual = 0,
  status = "unknown",
  costSource = "none",
  calls = 2
} = {}) {
  db.prepare(`INSERT INTO sessions (
    id, source, model, started_at, ended_at, input_tokens, output_tokens,
    cache_read_tokens, cache_write_tokens, reasoning_tokens, billing_provider,
    billing_base_url, billing_mode, actual_cost_usd, cost_status, cost_source, api_call_count
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, source, model, started, ended, input, output, cacheRead, cacheWrite, reasoning,
    provider, baseUrl, mode, actual, status, costSource, calls
  );
}

function insertModelUsage(db, {
  sessionId = "session-1",
  model = "anthropic/claude-sonnet-4.6",
  provider = "openrouter",
  baseUrl = "https://openrouter.ai/api/v1",
  mode = "api",
  task = "",
  calls = 2,
  input = 100,
  output = 20,
  cacheRead = 10,
  cacheWrite = 5,
  reasoning = 3,
  estimated = 0.004,
  actual = 0,
  status = "official_docs",
  costSource = "openrouter-model-metadata",
  firstSeen = 1_700_000_010,
  lastSeen = 1_700_000_090
} = {}) {
  db.prepare(`INSERT INTO session_model_usage (
    session_id, model, billing_provider, billing_base_url, billing_mode, task,
    api_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    reasoning_tokens, estimated_cost_usd, actual_cost_usd, cost_status, cost_source,
    first_seen, last_seen
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    sessionId, model, provider, baseUrl, mode, task, calls, input, output, cacheRead,
    cacheWrite, reasoning, estimated, actual, status, costSource, firstSeen, lastSeen
  );
}

function openRunnerLedger(tokenPath) {
  return {
    ledger: openTokenLedger({ path: tokenPath, mode: "create-or-open" }),
    runner: new CollectorRunner(new CollectorRegistry([HERMES_PASSIVE_COLLECTOR]))
  };
}

function hermesSource(path, sourceId = "main") {
  return { path, source_id: sourceId, finalization_grace_seconds: 0 };
}

test("Hermes collector detects current per-model schema and imports route/task usage", async () => {
  const { dir, hermes, token } = temp();
  const db = createHermes(hermes);
  insertSession(db);
  insertModelUsage(db, { task: "compression", model: "google/gemini-3-flash", provider: "commandcode", input: 250, output: 30 });
  db.close();
  const { ledger, runner } = openRunnerLedger(token);
  try {
    const result = await runner.run({ collector_id: "hermes-passive", source: hermesSource(hermes), ledger });
    assert.equal(result.detection.status, "available");
    assert.equal(result.health.code, "HERMES_MODEL_USAGE_READY");
    assert.equal(result.inserted, 1);
    const [event] = ledger.queryUsage().events;
    assert.equal(event.source.runtime, "hermes");
    assert.equal(event.source.source_platform, "telegram");
    assert.equal(event.session_id, "session-1");
    assert.equal(event.task_id, "compression");
    assert.equal(event.identity.billing_platform, "commandcode");
    assert.equal(event.identity.requested_model, "google/gemini-3-flash");
    assert.equal(event.identity.resolved_model, null);
    assert.equal(event.usage.input_tokens, 250);
    assert.equal(event.usage.request_units, 2);
    assert.equal(event.provenance.usage_quality, "runtime_reported");
    assert.deepEqual(event.timing, {});
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hermes estimated cost is never promoted to ACTUAL or zero money", async () => {
  const { dir, hermes, token } = temp();
  const db = createHermes(hermes);
  insertSession(db);
  insertModelUsage(db, { estimated: 22.5, actual: 0, status: "unknown", costSource: "none" });
  db.close();
  const { ledger, runner } = openRunnerLedger(token);
  try {
    await runner.run({ collector_id: "hermes-passive", source: hermesSource(hermes), ledger });
    const [event] = ledger.queryUsage().events;
    assert.equal(event.actual_charge, undefined);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("positive Hermes actual cost with source is attached through trusted runtime-reported path", async () => {
  const { dir, hermes, token } = temp();
  const db = createHermes(hermes);
  insertSession(db);
  insertModelUsage(db, { actual: 1.25, costSource: "provider-usage", status: "actual" });
  db.close();
  const { ledger, runner } = openRunnerLedger(token);
  try {
    await runner.run({ collector_id: "hermes-passive", source: hermesSource(hermes), ledger });
    const [event] = ledger.queryUsage().events;
    assert.deepEqual(event.actual_charge, {
      amount: "1.25",
      currency: "USD",
      source: "runtime_reported",
      external_charge_id: "hermes:main:session-1|anthropic/claude-sonnet-4.6|openrouter|https://openrouter.ai/api/v1|api|",
      reported_at: "2023-11-14T22:15:00.000Z"
    });
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hermes collector skips live sessions so cumulative rows cannot be double-counted", async () => {
  const { dir, hermes, token } = temp();
  const db = createHermes(hermes);
  insertSession(db, { ended: null });
  insertModelUsage(db);
  db.close();
  const { ledger, runner } = openRunnerLedger(token);
  try {
    const result = await runner.run({ collector_id: "hermes-passive", source: hermesSource(hermes), ledger });
    assert.equal(result.inserted, 0);
    assert.equal(ledger.queryUsage().events.length, 0);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hermes checkpoint pages finalized rows without replay blocking progress", async () => {
  const { dir, hermes, token } = temp();
  const db = createHermes(hermes);
  insertSession(db, { id: "s1", ended: 1_700_000_100 });
  insertSession(db, { id: "s2", ended: 1_700_000_200 });
  insertModelUsage(db, { sessionId: "s1" });
  insertModelUsage(db, { sessionId: "s2" });
  db.close();
  const { ledger, runner } = openRunnerLedger(token);
  try {
    const first = await runner.run({ collector_id: "hermes-passive", source: hermesSource(hermes), ledger, max_events: 1 });
    const second = await runner.run({ collector_id: "hermes-passive", source: hermesSource(hermes), ledger, max_events: 1 });
    const third = await runner.run({ collector_id: "hermes-passive", source: hermesSource(hermes), ledger, max_events: 1 });
    assert.equal(first.inserted, 1);
    assert.equal(first.complete, false);
    assert.equal(second.inserted, 1);
    assert.equal(second.complete, true);
    assert.equal(third.inserted, 0);
    assert.equal(ledger.queryUsage().events.length, 2);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hermes legacy sessions-only schema is visible as degraded fallback and still imports safely", async () => {
  const { dir, hermes, token } = temp();
  const db = createHermes(hermes, { modelUsage: false });
  insertSession(db, { input: 500, output: 70, calls: 5 });
  db.close();
  const { ledger, runner } = openRunnerLedger(token);
  try {
    const result = await runner.run({ collector_id: "hermes-passive", source: hermesSource(hermes), ledger });
    assert.equal(result.detection.status, "degraded");
    assert.equal(result.health.code, "HERMES_SESSION_SUMMARY_FALLBACK");
    assert.equal(result.inserted, 1);
    const [event] = ledger.queryUsage().events;
    assert.equal(event.source.source_type, "hermes.sessions");
    assert.equal(event.usage.input_tokens, 500);
    assert.equal(event.usage.request_units, 5);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hermes collection leaves source database bytes unchanged", async () => {
  const { dir, hermes, token } = temp();
  const db = createHermes(hermes);
  insertSession(db);
  insertModelUsage(db);
  db.close();
  const before = readFileSync(hermes);
  const { ledger, runner } = openRunnerLedger(token);
  try {
    await runner.run({ collector_id: "hermes-passive", source: hermesSource(hermes), ledger });
    const after = readFileSync(hermes);
    assert.equal(Buffer.compare(before, after), 0);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hermes source discovery finds main and profile state databases only", () => {
  const dir = mkdtempSync(join(tmpdir(), "token-hermes-discovery-"));
  try {
    const main = createHermes(join(dir, "state.db"));
    main.close();
    mkdirSync(join(dir, "profiles", "work"), { recursive: true });
    const work = createHermes(join(dir, "profiles", "work", "state.db"));
    work.close();
    mkdirSync(join(dir, "profiles", "empty"), { recursive: true });
    const found = discoverHermesStateSources({ hermes_home: dir, finalization_grace_seconds: 0 });
    assert.deepEqual(found.map((item) => item.source_id), ["main", "profile:work"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hermes positive numeric cost is not promoted when cost_status is not actual", async () => {
  const { dir, hermes, token } = temp();
  const db = createHermes(hermes);
  insertSession(db);
  insertModelUsage(db, { actual: 1.25, costSource: "provider-usage", status: "estimated" });
  db.close();
  const { ledger, runner } = openRunnerLedger(token);
  try {
    await runner.run({ collector_id: "hermes-passive", source: hermesSource(hermes), ledger });
    assert.equal(ledger.queryUsage().events[0].actual_charge, undefined);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hermes explicit actual zero with source is preserved as a real ACTUAL zero charge", async () => {
  const { dir, hermes, token } = temp();
  const db = createHermes(hermes);
  insertSession(db);
  insertModelUsage(db, { actual: 0, costSource: "provider-usage", status: "actual" });
  db.close();
  const { ledger, runner } = openRunnerLedger(token);
  try {
    await runner.run({ collector_id: "hermes-passive", source: hermesSource(hermes), ledger });
    assert.equal(ledger.queryUsage().events[0].actual_charge?.amount, "0");
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
