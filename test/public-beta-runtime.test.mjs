import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AI_VERSE_TOKEN_LEDGER_PATH,
  AI_VERSE_TOKEN_PRICING_ROOT,
  AI_VERSE_TOKEN_RUNTIME_CONFIG,
  disableTokenExtension,
  installTokenExtension,
  uninstallTokenExtension,
  updateTokenExtension
} from "../dist/src/native/index.js";
import { collectTokenUsage, doctorTokenRuntime, setupTokenRuntime, statusTokenRuntime } from "../dist/src/runtime/index.js";
import { PriceSnapshotStore, createOpenRouterModelsFetcher } from "../dist/src/pricing/index.js";
import { openTokenReader } from "../dist/src/read/index.js";
import { openTokenGatewayProjection } from "../dist/src/gateway/index.js";
import { openTokenLedger } from "../dist/src/storage/index.js";

function osFixture() {
  const root = mkdtempSync(join(tmpdir(), "token-beta-host-"));
  mkdirSync(join(root, "operator"));
  mkdirSync(join(root, "workspaces"));
  mkdirSync(join(root, "system", "extensions"), { recursive: true });
  writeFileSync(join(root, "AI-VERSE.yaml"), 'schema_version: "2.0"\narchitecture: unified-workspace\n');
  writeFileSync(join(root, "AGENTS.md"), "# runtime\n");
  writeFileSync(join(root, "system", "extensions", "README.md"), "Local registry: `/.aiverse/extensions/registry.json`\n");
  return root;
}

function emptySourceRoots(root) {
  const roots = {};
  for (const name of ["hermes", "claude_code", "codex", "opencode", "gemini_cli", "openclaw"]) {
    roots[name] = join(root, `source-${name}`);
    mkdirSync(roots[name], { recursive: true });
  }
  return roots;
}

function jsonl(path, records) {
  writeFileSync(path, `${records.map((item) => JSON.stringify(item)).join("\n")}\n`);
}

function event(id, overrides = {}) {
  const scope = overrides.scope ?? { workspace_id: "workspace-a", skill_id: "skill-a", bot_id: "bot-a" };
  return {
    schema_version: "ai-verse-token/0.1",
    event_id: id,
    request_id: id,
    session_id: `session-${id}`,
    task_id: overrides.task_id ?? `task-${id}`,
    source: { runtime: "gateway", source_type: "test" },
    observed_at: overrides.observed_at ?? "2026-09-12T10:01:00Z",
    identity: overrides.identity ?? { billing_platform: "openrouter", inference_provider: "anthropic", requested_model: "anthropic/test", resolved_model: "anthropic/test", provider_model_id: "anthropic/test" },
    scope,
    usage: overrides.usage ?? { input_tokens: 100, output_tokens: 20, total_tokens_reported: 120 },
    timing: { started_at: overrides.started_at ?? "2026-09-12T10:00:00Z" },
    ...(overrides.actual_charge === undefined ? {} : { actual_charge: overrides.actual_charge }),
    provenance: { collector_id: "test", source_record_fingerprint: `fingerprint-${id}-0123456789`, usage_quality: "provider_reported", timing_quality: "provider_reported", content_stored: false }
  };
}

function priceSnapshot() {
  return {
    schema_version: "ai-verse-token-price/0.1",
    price_snapshot_id: "openrouter-anthropic-test-2026-09-12",
    identity: { billing_platform: "openrouter", resolved_model: "anthropic/test", provider_model_id: "anthropic/test" },
    currency: "USD",
    effective: { starts_at: "2026-09-12T00:00:00Z" },
    rates: { input_tokens: { amount: "0.000001", per: 1 }, output_tokens: { amount: "0.000002", per: 1 } },
    source: { authority: "provider_pricing_api", source_id: "openrouter-models-api", retrieved_at: "2026-09-12T08:00:00Z" },
    verification: { status: "verified", verified_at: "2026-09-12T08:00:00Z" }
  };
}

test("setup activates durable runtime state and update/uninstall preserve canonical state", async () => {
  const root = osFixture();
  try {
    const roots = emptySourceRoots(root);
    installTokenExtension(root);
    assert.equal(statusTokenRuntime(root).state, "setup-required");

    const setup = await setupTokenRuntime(root, { source_roots: roots, sync_pricing: false });
    assert.equal(setup.ledger_created, true);
    assert.equal(setup.readiness.ready, true);
    assert.equal(statusTokenRuntime(root).state, "ready");
    assert.equal(existsSync(join(root, AI_VERSE_TOKEN_RUNTIME_CONFIG)), true);

    const ledgerPath = join(root, AI_VERSE_TOKEN_LEDGER_PATH);
    const configPath = join(root, AI_VERSE_TOKEN_RUNTIME_CONFIG);
    const ledgerBefore = readFileSync(ledgerPath);
    const configBefore = readFileSync(configPath);

    disableTokenExtension(root);
    updateTokenExtension(root);
    assert.equal(statusTokenRuntime(root).state, "disabled");
    assert.deepEqual(readFileSync(ledgerPath), ledgerBefore);
    assert.deepEqual(readFileSync(configPath), configBefore);

    uninstallTokenExtension(root);
    assert.equal(existsSync(ledgerPath), true);
    assert.deepEqual(readFileSync(ledgerPath), ledgerBefore);
    assert.deepEqual(readFileSync(configPath), configBefore);

    installTokenExtension(root);
    assert.deepEqual(readFileSync(ledgerPath), ledgerBefore);
    assert.deepEqual(readFileSync(configPath), configBefore);
    assert.equal(statusTokenRuntime(root).state, "ready");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("default runtime orchestration discovers and actually collects Codex usage", async () => {
  const root = osFixture();
  try {
    const roots = emptySourceRoots(root);
    const codexDir = join(roots.codex, "sessions", "2026", "09", "12");
    mkdirSync(codexDir, { recursive: true });
    const usage = { input_tokens: 120, cached_input_tokens: 80, cache_write_input_tokens: 4, output_tokens: 30, reasoning_output_tokens: 10, total_tokens: 150 };
    jsonl(join(codexDir, "rollout-current.jsonl"), [
      { timestamp: "2026-09-12T11:30:00Z", type: "session_meta", payload: { id: "thread-current", model_provider: "openai", cli_version: "0.153.4" } },
      { timestamp: "2026-09-12T11:30:01Z", type: "turn_context", payload: { turn_id: "turn-current", model: "gpt-5.6-sol" } },
      { timestamp: "2026-09-12T11:30:02Z", type: "token_usage_record", payload: { thread_id: "thread-current", turn_id: "turn-current", session_id: "thread-current", response_id: "resp-current", usage, turn_token_usage: usage, thread_token_usage: usage } }
    ]);

    installTokenExtension(root);
    const setup = await setupTokenRuntime(root, { source_roots: roots, sync_pricing: false });
    assert.equal(setup.collection.inserted, 1);
    const again = await collectTokenUsage(root, { source_roots: roots });
    assert.equal(again.inserted, 0);

    const reader = openTokenReader({ path: join(root, AI_VERSE_TOKEN_LEDGER_PATH), authorization: { principal_id: "test-owner", mode: "owner" } });
    assert.equal(reader.summary().request_count, 1);
    const [collected] = reader.query().events;
    assert.equal(collected.request_id, "resp-current");
    reader.close();

    const doctor = await doctorTokenRuntime(root);
    assert.equal(doctor.ready, true);
    assert.equal(doctor.cost_truth.primary_read_preserves_unknown, true);
    assert.equal(doctor.cost_truth.calculated_cost_ready, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("doctor is read-only and reports incomplete pricing state as unhealthy", async () => {
  const root = osFixture();
  try {
    const roots = emptySourceRoots(root);
    installTokenExtension(root);
    await setupTokenRuntime(root, { source_roots: roots, sync_pricing: false });
    const syncStatePath = join(root, AI_VERSE_TOKEN_PRICING_ROOT, "sync-state");
    rmSync(syncStatePath, { recursive: true, force: true });
    assert.equal(existsSync(syncStatePath), false);

    const doctor = await doctorTokenRuntime(root);
    assert.equal(doctor.state, "unhealthy");
    assert.equal(doctor.ready, false);
    assert.equal(doctor.problems.some((item) => item.code === "PRICING_STORE_UNHEALTHY"), true);
    assert.equal(existsSync(syncStatePath), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("primary read reports ACTUAL, CALCULATED and UNKNOWN without turning unknown into zero", () => {
  const root = mkdtempSync(join(tmpdir(), "token-beta-read-"));
  const db = join(root, "token.sqlite");
  const pricing = join(root, "pricing");
  try {
    const ledger = openTokenLedger({ path: db });
    ledger.ingestUsageEvent(event("actual", { actual_charge: { amount: "0", currency: "USD", source: "provider_reported" } }));
    ledger.ingestUsageEvent(event("calculated"));
    ledger.ingestUsageEvent(event("unknown", { identity: { billing_platform: "openrouter", inference_provider: "anthropic", requested_model: "missing", resolved_model: "missing", provider_model_id: "missing" } }));
    ledger.close();
    new PriceSnapshotStore(pricing).put(priceSnapshot());

    const reader = openTokenReader({ path: db, pricing_root: pricing, authorization: { principal_id: "test-owner", mode: "owner" } });
    const costs = reader.costs({ max_events: 10 });
    assert.deepEqual(costs.results.map((x) => x.status).sort(), ["ACTUAL", "CALCULATED", "UNKNOWN"]);
    assert.equal(costs.summary.actual_event_count, 1);
    assert.equal(costs.summary.calculated_event_count, 1);
    assert.equal(costs.summary.unknown_event_count, 1);
    const unknown = costs.results.find((x) => x.status === "UNKNOWN");
    assert.equal("amount" in unknown, false);
    assert.equal(JSON.stringify(unknown).includes('"amount":"0"'), false);
    assert.equal(reader.efficiency({ max_events: 10 }).cost_scope, "actual_calculated_unknown");
    reader.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("host scope is an enforced read floor and telemetry attribution never grants permission", () => {
  const root = mkdtempSync(join(tmpdir(), "token-beta-auth-"));
  const db = join(root, "token.sqlite");
  try {
    const ledger = openTokenLedger({ path: db });
    ledger.ingestUsageEvent(event("a", { scope: { workspace_id: "workspace-a", skill_id: "skill-a", bot_id: "bot-a" } }));
    ledger.ingestUsageEvent(event("b", { scope: { workspace_id: "workspace-b", skill_id: "skill-b", bot_id: "bot-b" } }));
    ledger.close();

    const authorization = { principal_id: "gateway-user", mode: "scoped", scope_floor: { workspace_id: "workspace-a" } };
    const reader = openTokenReader({ path: db, authorization });
    assert.deepEqual(reader.query().events.map((x) => x.event_id), ["a"]);
    assert.throws(() => reader.query({ filter: { workspace_id: "workspace-b" } }), (error) => error?.code === "READ_UNAUTHORIZED_SCOPE");
    reader.close();

    assert.throws(() => openTokenGatewayProjection({ root }), (error) => error?.code === "READ_UNAUTHORIZED_SCOPE");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Gateway projection is owner-backed, scoped and explicitly non-authoritative", () => {
  const root = osFixture();
  try {
    installTokenExtension(root);
    const state = join(root, ".aiverse", "extensions", "ai-verse-token", "state");
    mkdirSync(state, { recursive: true });
    const ledger = openTokenLedger({ path: join(root, AI_VERSE_TOKEN_LEDGER_PATH) });
    ledger.ingestUsageEvent(event("a", { scope: { workspace_id: "workspace-a", skill_id: "skill-a", bot_id: "bot-a" } }));
    ledger.ingestUsageEvent(event("b", { scope: { workspace_id: "workspace-b", skill_id: "skill-b", bot_id: "bot-b" } }));
    ledger.close();
    new PriceSnapshotStore(join(root, AI_VERSE_TOKEN_PRICING_ROOT));

    const projection = openTokenGatewayProjection({ root, authorization: { principal_id: "gateway-user", mode: "scoped", scope_floor: { workspace_id: "workspace-a" } } });
    const overview = projection.overview();
    assert.equal(overview.owner, "ai-verse-token");
    assert.equal(overview.read_only, true);
    assert.equal(overview.attribution_is_authority, false);
    assert.equal(overview.summary.request_count, 1);
    assert.deepEqual(projection.events().events.map((x) => x.event_id), ["a"]);
    projection.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("OpenRouter pricing transport maps live catalog pricing without persisting the bearer secret", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TOKEN_TEST_OPENROUTER_KEY;
  let observedAuthorization = null;
  try {
    process.env.TOKEN_TEST_OPENROUTER_KEY = "test-secret";
    globalThis.fetch = async (_url, options) => {
      observedAuthorization = options.headers.authorization;
      return new Response(JSON.stringify({ data: [{ id: "anthropic/test", pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0.0000001" } }] }), { status: 200, headers: { etag: '"catalog-v1"' } });
    };
    const fetcher = createOpenRouterModelsFetcher({ api_key_env: "TOKEN_TEST_OPENROUTER_KEY" });
    const result = await fetcher.fetch({ source_id: "openrouter-models-api", reason: "manual", now: "2026-09-13T10:00:00Z" });
    assert.equal(result.status, "updated");
    assert.equal(result.snapshots.length, 1);
    assert.equal(result.snapshots[0].rates.input_tokens.amount, "0.000001");
    assert.equal(observedAuthorization, "Bearer test-secret");
    assert.equal(JSON.stringify(result).includes("test-secret"), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TOKEN_TEST_OPENROUTER_KEY;
    else process.env.TOKEN_TEST_OPENROUTER_KEY = originalKey;
  }
});
