import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CLAUDE_CODE_COLLECTOR,
  CODEX_COLLECTOR,
  GEMINI_CLI_COLLECTOR,
  OPENCODE_COLLECTOR,
  OPENCLAW_COLLECTOR,
  CollectorRegistry,
  CollectorRunner,
  discoverClaudeCodeSources,
  discoverCodexSources,
  discoverGeminiCliSources,
  discoverOpenClawSources,
  discoverOpenCodeSources
} from "../dist/src/collectors/index.js";
import { openTokenLedger } from "../dist/src/storage/index.js";

const ALL = [
  CLAUDE_CODE_COLLECTOR,
  CODEX_COLLECTOR,
  OPENCODE_COLLECTOR,
  GEMINI_CLI_COLLECTOR,
  OPENCLAW_COLLECTOR
];

function temp(prefix = "token-local-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, token: join(dir, "token.sqlite") };
}

function runnerLedger(token) {
  return {
    ledger: openTokenLedger({ path: token, mode: "create-or-open" }),
    runner: new CollectorRunner(new CollectorRegistry(ALL))
  };
}

function jsonl(path, records) {
  writeFileSync(path, `${records.map((item) => JSON.stringify(item)).join("\n")}\n`);
}

test("Claude Code collector deduplicates repeated content-block records by request identity", async () => {
  const { dir, token } = temp();
  const sourcePath = join(dir, "claude.jsonl");
  const usage = {
    input_tokens: 3,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 20,
    output_tokens: 7,
    service_tier: "standard"
  };
  jsonl(sourcePath, [
    { type: "assistant", timestamp: "2026-09-12T10:00:00Z", sessionId: "s1", requestId: "req-1", message: { role: "assistant", id: "m1", model: "claude-sonnet-5", usage } },
    { type: "assistant", timestamp: "2026-09-12T10:00:00.100Z", sessionId: "s1", requestId: "req-1", message: { role: "assistant", id: "m1", model: "claude-sonnet-5", usage } }
  ]);
  const { ledger, runner } = runnerLedger(token);
  try {
    const result = await runner.run({ collector_id: "claude-code-local", source: { path: sourcePath, source_id: "session" }, ledger });
    assert.equal(result.emitted, 2);
    assert.equal(result.inserted, 1);
    assert.equal(result.duplicates, 1);
    const [event] = ledger.queryUsage().events;
    assert.equal(event.identity.billing_platform, "anthropic");
    assert.equal(event.identity.requested_model, "claude-sonnet-5");
    assert.deepEqual(event.usage, {
      context_input_tokens: 123,
      input_tokens: 3,
      output_tokens: 7,
      cache_read_tokens: 20,
      cache_write_tokens: 100,
      total_tokens_reported: 130
    });
    assert.deepEqual(event.timing, {});
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude Code collector uses iteration usage when top-level counters are not authoritative", async () => {
  const { dir, token } = temp();
  const sourcePath = join(dir, "claude.jsonl");
  jsonl(sourcePath, [{
    type: "assistant",
    timestamp: "2026-09-12T10:00:00Z",
    sessionId: "s1",
    requestId: "req-iterations",
    message: {
      role: "assistant",
      model: "claude-opus-5",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        iterations: [
          { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 10, cache_creation_input_tokens: 1 },
          { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 11, cache_creation_input_tokens: 2 }
        ]
      }
    }
  }]);
  const { ledger, runner } = runnerLedger(token);
  try {
    const first = await runner.run({ collector_id: "claude-code-local", source: { path: sourcePath, source_id: "session" }, ledger, max_events: 1 });
    const second = await runner.run({ collector_id: "claude-code-local", source: { path: sourcePath, source_id: "session" }, ledger, max_events: 1 });
    assert.equal(first.inserted, 1);
    assert.equal(first.complete, false);
    assert.equal(second.inserted, 1);
    assert.equal(ledger.queryUsage().events.length, 2);
    assert.deepEqual(ledger.queryUsage().events.map((event) => event.usage.input_tokens).sort((a, b) => a - b), [4, 5]);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex collector preserves model/turn state across pagination and normalizes subset counters", async () => {
  const { dir, token } = temp();
  const sourcePath = join(dir, "rollout.jsonl");
  jsonl(sourcePath, [
    { timestamp: "2026-09-12T11:00:00Z", type: "session_meta", payload: { id: "thread-1", model_provider: "openai", cli_version: "0.150.0" } },
    { timestamp: "2026-09-12T11:00:01Z", type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-5.6-sol" } },
    { timestamp: "2026-09-12T11:00:02Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 80, cache_write_input_tokens: 5, output_tokens: 20, reasoning_output_tokens: 8, total_tokens: 120 } } } },
    { timestamp: "2026-09-12T11:00:03Z", type: "response_item", payload: { type: "custom_tool_call" } },
    { timestamp: "2026-09-12T11:00:04Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 10, reasoning_output_tokens: 2, total_tokens: 60 } } } }
  ]);
  const { ledger, runner } = runnerLedger(token);
  try {
    const source = { path: sourcePath, source_id: "thread-file" };
    const first = await runner.run({ collector_id: "codex-local", source, ledger, max_events: 1 });
    const second = await runner.run({ collector_id: "codex-local", source, ledger, max_events: 1 });
    assert.equal(first.inserted, 1);
    assert.equal(second.inserted, 1);
    const events = ledger.queryUsage().events;
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.session_id, "thread-1");
      assert.equal(event.task_id, "turn-1");
      assert.equal(event.identity.requested_model, "gpt-5.6-sol");
      assert.equal(event.identity.billing_platform, "openai");
    }
    const firstUsage = events.find((event) => event.usage.total_tokens_reported === 120);
    assert.deepEqual(firstUsage.usage, {
      context_input_tokens: 100,
      input_tokens: 20,
      output_tokens: 12,
      reasoning_tokens: 8,
      cached_input_tokens: 80,
      cache_write_tokens: 5,
      total_tokens_reported: 120
    });
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex 0.153+ prefers durable per-response usage records and suppresses duplicate legacy token_count events", async () => {
  const { dir, token } = temp();
  const sourcePath = join(dir, "rollout-current.jsonl");
  const usage = { input_tokens: 120, cached_input_tokens: 80, cache_write_input_tokens: 4, output_tokens: 30, reasoning_output_tokens: 10, total_tokens: 150 };
  jsonl(sourcePath, [
    { timestamp: "2026-09-12T11:30:00Z", type: "session_meta", payload: { id: "thread-current", model_provider: "openai", cli_version: "0.153.4" } },
    { timestamp: "2026-09-12T11:30:01Z", type: "turn_context", payload: { turn_id: "turn-current", model: "gpt-5.6-sol" } },
    { timestamp: "2026-09-12T11:30:02Z", type: "token_usage_record", payload: { thread_id: "thread-current", turn_id: "turn-current", session_id: "thread-current", root_turn_id: "root-current", response_id: "resp-current", usage, turn_token_usage: usage, thread_token_usage: usage } },
    { timestamp: "2026-09-12T11:30:02.100Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } } }
  ]);
  const { ledger, runner } = runnerLedger(token);
  try {
    await runner.run({ collector_id: "codex-local", source: { path: sourcePath, source_id: "current-thread" }, ledger });
    const events = ledger.queryUsage().events;
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.request_id, "resp-current");
    assert.equal(event.session_id, "thread-current");
    assert.equal(event.task_id, "turn-current");
    assert.equal(event.source.source_type, "codex.rollout-token-usage-record");
    assert.deepEqual(event.usage, {
      context_input_tokens: 120,
      input_tokens: 40,
      output_tokens: 20,
      reasoning_tokens: 10,
      cached_input_tokens: 80,
      cache_write_tokens: 4,
      total_tokens_reported: 150
    });
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex total-only recompute records are marked estimated instead of price-authoritative", async () => {
  const { dir, token } = temp();
  const sourcePath = join(dir, "rollout.jsonl");
  jsonl(sourcePath, [
    { timestamp: "2026-09-12T11:00:00Z", type: "session_meta", payload: { id: "thread-1", model_provider: "openai" } },
    { timestamp: "2026-09-12T11:00:01Z", type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-5.6-sol" } },
    { timestamp: "2026-09-12T11:00:02Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 9000 } } } }
  ]);
  const { ledger, runner } = runnerLedger(token);
  try {
    await runner.run({ collector_id: "codex-local", source: { path: sourcePath, source_id: "thread-file" }, ledger });
    assert.equal(ledger.queryUsage().events[0].provenance.usage_quality, "estimated");
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode collector reads assistant message data from SQLite without modifying the source DB", async () => {
  const { dir, token } = temp();
  const sourcePath = join(dir, "opencode.db");
  const db = new DatabaseSync(sourcePath);
  db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE session (id TEXT PRIMARY KEY);");
  db.prepare("INSERT INTO message(id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
    "m1", "s1", 1_789_209_600_000,
    JSON.stringify({ role: "assistant", modelID: "claude-sonnet-4.6", providerID: "github-copilot", cost: 123, tokens: { total: 11540, input: 11300, output: 153, reasoning: 7, cache: { read: 80, write: 0 } } })
  );
  db.close();
  const before = readFileSync(sourcePath);
  const { ledger, runner } = runnerLedger(token);
  try {
    await runner.run({ collector_id: "opencode-local", source: { path: sourcePath, source_id: "db" }, ledger });
    const event = ledger.queryUsage().events[0];
    assert.equal(event.identity.billing_platform, "github-copilot");
    assert.equal(event.identity.requested_model, "claude-sonnet-4.6");
    assert.equal(event.actual_charge, undefined);
    assert.deepEqual(event.usage, {
      input_tokens: 11300,
      output_tokens: 153,
      reasoning_tokens: 7,
      cache_read_tokens: 80,
      cache_write_tokens: 0,
      total_tokens_reported: 11540
    });
    assert.deepEqual(readFileSync(sourcePath), before);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Gemini CLI collector imports message-level cached/thought token counters and protects cursor identity", async () => {
  const { dir, token } = temp();
  const sourcePath = join(dir, "session-1.json");
  const doc = {
    sessionId: "gem-session",
    messages: [
      { id: "u1", type: "user", timestamp: "2026-09-12T12:00:00Z" },
      { id: "g1", type: "gemini", timestamp: "2026-09-12T12:00:01Z", model: "gemini-3.1-pro-preview", tokens: { input: 100, output: 20, cached: 40, thoughts: 5, tool: 9, total: 174 } }
    ]
  };
  writeFileSync(sourcePath, JSON.stringify(doc));
  const { ledger, runner } = runnerLedger(token);
  try {
    const source = { path: sourcePath, source_id: "gem" };
    await runner.run({ collector_id: "gemini-cli-local", source, ledger });
    const event = ledger.queryUsage().events[0];
    assert.equal(event.identity.billing_platform, "google");
    assert.equal(event.identity.requested_model, "gemini-3.1-pro-preview");
    assert.deepEqual(event.usage, {
      input_tokens: 100,
      output_tokens: 20,
      reasoning_tokens: 5,
      cached_input_tokens: 40,
      total_tokens_reported: 174
    });
    doc.messages[1].id = "changed";
    writeFileSync(sourcePath, JSON.stringify(doc));
    await assert.rejects(
      runner.run({ collector_id: "gemini-cli-local", source, ledger }),
      (error) => error?.code === "COLLECTOR_FAILED" && error?.cause?.code === "GEMINI_SOURCE_CHANGED"
    );
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenClaw collector imports normalized assistant usage but distrusts all-zero persisted usage", async () => {
  const { dir, token } = temp();
  const sourcePath = join(dir, "session-abc.jsonl");
  jsonl(sourcePath, [
    { type: "message", id: "a1", timestamp: "2026-09-12T13:00:00Z", message: { role: "assistant", provider: "openai", model: "gpt-5.6-sol", api: "openai-responses", usage: { input: 11, output: 20, cacheRead: 100, cacheWrite: 5, totalTokens: 136, cost: { total: 99 } } } },
    { type: "message", id: "a2", timestamp: "2026-09-12T13:00:01Z", message: { role: "assistant", provider: "custom", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } } }
  ]);
  const { ledger, runner } = runnerLedger(token);
  try {
    await runner.run({ collector_id: "openclaw-local", source: { path: sourcePath, source_id: "oc" }, ledger });
    const events = ledger.queryUsage().events;
    assert.equal(events.length, 2);
    const nonzero = events.find((event) => event.request_id === "a1");
    const zero = events.find((event) => event.request_id === "a2");
    assert.equal(nonzero.provenance.usage_quality, "runtime_reported");
    assert.equal(nonzero.identity.billing_mode, "openai-responses");
    assert.equal(nonzero.actual_charge, undefined);
    assert.equal(zero.provenance.usage_quality, "unknown");
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local collector discovery finds canonical roots and excludes OpenClaw trajectory files", () => {
  const { dir } = temp();
  try {
    const claudeHome = join(dir, ".claude");
    mkdirSync(join(claudeHome, "projects", "p"), { recursive: true });
    writeFileSync(join(claudeHome, "projects", "p", "s.jsonl"), "{}\n");
    const codexHome = join(dir, ".codex");
    mkdirSync(join(codexHome, "sessions", "2026", "09", "12"), { recursive: true });
    writeFileSync(join(codexHome, "sessions", "2026", "09", "12", "rollout-a.jsonl"), "{}\n");
    const geminiHome = join(dir, ".gemini");
    mkdirSync(join(geminiHome, "tmp", "project", "chats"), { recursive: true });
    writeFileSync(join(geminiHome, "tmp", "project", "chats", "session-a.json"), JSON.stringify({ messages: [] }));
    const openclawHome = join(dir, ".openclaw");
    mkdirSync(join(openclawHome, "agents", "main", "sessions"), { recursive: true });
    writeFileSync(join(openclawHome, "agents", "main", "sessions", "a.jsonl"), "{}\n");
    writeFileSync(join(openclawHome, "agents", "main", "sessions", "a.trajectory.jsonl"), "{}\n");
    const openCodeHome = join(dir, "opencode");
    mkdirSync(openCodeHome, { recursive: true });
    writeFileSync(join(openCodeHome, "opencode.db"), "placeholder");

    assert.equal(discoverClaudeCodeSources({ claude_home: claudeHome }).length, 1);
    assert.equal(discoverCodexSources({ codex_home: codexHome }).length, 1);
    assert.equal(discoverGeminiCliSources({ gemini_home: geminiHome }).length, 1);
    assert.equal(discoverOpenClawSources({ state_dir: openclawHome }).length, 1);
    assert.equal(discoverOpenCodeSources({ data_dir: openCodeHome }).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
