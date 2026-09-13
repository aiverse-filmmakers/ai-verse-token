import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeOpenRouterGeneration } from "../dist/src/adapters/index.js";
import { CostEngine } from "../dist/src/cost/index.js";
import { createTokenDashboardProjection } from "../dist/src/dashboard/index.js";
import {
  AI_VERSE_TOKEN_LEDGER_PATH,
  inspectTokenNative,
  installTokenExtension,
  uninstallTokenExtension
} from "../dist/src/native/index.js";
import { createDefaultPricingSourceRegistry } from "../dist/src/pricing/index.js";
import { openTokenReader } from "../dist/src/read/index.js";
import { openTokenLedger } from "../dist/src/storage/index.js";

const npmExecPath = process.env.npm_execpath ?? null;

function runNpm(args, options = {}) {
  if (npmExecPath) return execFileSync(process.execPath, [npmExecPath, ...args], options);
  return execFileSync("npm", args, { ...options, shell: process.platform === "win32" });
}

function osFixture() {
  const root = mkdtempSync(join(tmpdir(), "token-release-os-"));
  mkdirSync(join(root, "operator"));
  mkdirSync(join(root, "workspaces"));
  mkdirSync(join(root, "system", "extensions"), { recursive: true });
  writeFileSync(join(root, "AI-VERSE.yaml"), 'schema_version: "2.0"\narchitecture: unified-workspace\n');
  writeFileSync(join(root, "AGENTS.md"), "# runtime\n");
  writeFileSync(join(root, "system", "extensions", "README.md"), "Local registry: `/.aiverse/extensions/registry.json`\n");
  return root;
}

function calculatedEvent(overrides = {}) {
  return {
    schema_version: "ai-verse-token/0.1",
    event_id: overrides.event_id ?? "evt_release_calculated",
    source: { runtime: "codex", source_type: "release.test" },
    observed_at: overrides.observed_at ?? "2026-06-10T10:01:00Z",
    identity: { billing_platform: "openai", inference_provider: "openai", requested_model: "gpt-release", resolved_model: "gpt-release", service_tier: "standard" },
    usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 0, reasoning_tokens: 0, ...(overrides.usage ?? {}) },
    timing: { started_at: overrides.started_at ?? "2026-06-10T10:00:00Z" },
    provenance: { collector_id: "release-test", source_record_fingerprint: `release-${overrides.event_id ?? "calc"}-0123456789`, usage_quality: "provider_reported", timing_quality: "unknown", content_stored: false }
  };
}

function price(id, start, end, inputRate) {
  return {
    schema_version: "ai-verse-token-price/0.1",
    price_snapshot_id: id,
    identity: { billing_platform: "openai", resolved_model: "gpt-release", inference_provider: "openai", service_tier: "standard" },
    currency: "USD",
    effective: { starts_at: start, ...(end === null ? {} : { ends_at: end }) },
    rates: {
      input_tokens: { amount: inputRate, per: 1_000_000 },
      output_tokens: { amount: "10", per: 1_000_000 },
      cache_read_tokens: { amount: "1", per: 1_000_000 },
      reasoning_tokens: { amount: "10", per: 1_000_000 }
    },
    source: { authority: "official_public_pricing", source_id: "openai-official-pricing", retrieved_at: start },
    verification: { status: "verified", verified_at: start }
  };
}

test("packed artifact installs on a clean project and exposes package plus CLI without source tree", () => {
  const work = mkdtempSync(join(tmpdir(), "token-packed-release-"));
  const packDir = join(work, "pack");
  const project = join(work, "project");
  mkdirSync(packDir);
  mkdirSync(project);
  try {
    const filename = runNpm(["pack", "--ignore-scripts", "--pack-destination", packDir], { cwd: new URL("..", import.meta.url), encoding: "utf8" }).trim().split(/\r?\n/).at(-1);
    assert.ok(filename);
    const tarball = join(packDir, filename);
    assert.equal(existsSync(tarball), true);
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "token-clean-install", private: true, type: "module" }));
    runNpm(["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: project, stdio: "pipe" });
    const version = execFileSync(process.execPath, ["--input-type=module", "--eval", "import { PACKAGE_VERSION } from '@ai-verse/token'; process.stdout.write(PACKAGE_VERSION);"], { cwd: project, encoding: "utf8" });
    assert.equal(version, "0.1.0-beta.2");
    const cli = execFileSync(process.execPath, [join(project, "node_modules", "@ai-verse", "token", "bin", "ai-verse-token.mjs"), "--version"], { cwd: project, encoding: "utf8" });
    assert.equal(cli.trim(), "0.1.0-beta.2");
    const oneCommand = runNpm(["exec", "--yes", "--package", tarball, "--", "ai-verse-token", "--version"], { cwd: work, encoding: "utf8" });
    assert.equal(oneCommand.trim(), "0.1.0-beta.2");
    assert.equal(existsSync(join(project, "node_modules", "@ai-verse", "token", "src")), false);
    assert.equal(existsSync(join(project, "node_modules", "@ai-verse", "token", "test")), false);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("release story preserves ACTUAL/CALCULATED/UNKNOWN truth and native state across uninstall/reinstall", () => {
  const root = osFixture();
  try {
    installTokenExtension(root);
    const ledgerPath = join(root, AI_VERSE_TOKEN_LEDGER_PATH);
    mkdirSync(join(root, ".aiverse", "extensions", "ai-verse-token", "state"), { recursive: true });
    const ledger = openTokenLedger({ path: ledgerPath });
    const actual = normalizeOpenRouterGeneration({
      data: {
        id: "gen-release-1",
        request_id: "req-release-1",
        created_at: "2026-09-12T18:00:00Z",
        model: "anthropic/claude-sonnet",
        provider_name: "Anthropic",
        native_tokens_prompt: 1000,
        native_tokens_completion: 200,
        native_tokens_cached: 600,
        native_tokens_reasoning: 100,
        total_cost: 0.0125
      }
    }).event;
    ledger.ingestUsageEvent(actual);
    ledger.close();

    const reader = openTokenReader({ path: ledgerPath, authorization: { principal_id: "test-owner", mode: "owner" } });
    const dashboard = createTokenDashboardProjection(reader).overview();
    assert.equal(dashboard.summary.request_count, 1);
    assert.equal(dashboard.efficiency.analysis.overall.costs.actual_event_count, 1);
    assert.equal(dashboard.provenance.opens_sqlite_directly, false);
    reader.close();

    const engine = new CostEngine(createDefaultPricingSourceRegistry());
    const june = price("price-june", "2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z", "1");
    const september = price("price-september", "2026-09-01T00:00:00Z", null, "50");
    const calculated = engine.rate({ event: calculatedEvent(), price_snapshots: [september, june], context: { now: "2026-09-12T20:00:00Z" } });
    assert.equal(calculated.status, "CALCULATED");
    assert.equal(calculated.price_snapshot_id, "price-june");
    assert.equal(calculated.amount, "2");
    const unknown = engine.rate({ event: calculatedEvent({ event_id: "evt_release_unknown", usage: { output_tokens: null } }), price_snapshots: [june], context: { now: "2026-09-12T20:00:00Z" } });
    assert.equal(unknown.status, "UNKNOWN");
    assert.equal("amount" in unknown, false);
    const actualRated = engine.rate({ event: actual, price_snapshots: [], context: { now: "2026-09-12T20:00:00Z" } });
    assert.equal(actualRated.status, "ACTUAL");
    assert.equal(actualRated.amount, "0.0125");

    const before = readFileSync(ledgerPath);
    uninstallTokenExtension(root);
    assert.deepEqual(readFileSync(ledgerPath), before);
    installTokenExtension(root);
    assert.deepEqual(readFileSync(ledgerPath), before);
    const doctor = inspectTokenNative(root, true);
    assert.equal(doctor.healthy, true);
    assert.deepEqual(doctor.ledger_integrity, { checked: true, ok: true, details: ["ok"] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release CI contract covers macOS/Linux/Windows across Node 22 and 24", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /os: \[ubuntu-latest, macos-latest, windows-latest\]/);
  assert.match(workflow, /node: \[22, 24\]/);
  assert.match(workflow, /npm run ci/);
  assert.match(workflow, /npm pack --dry-run/);
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.private, undefined);
  assert.equal(packageJson.scripts.prepare, "npm run build");
  assert.doesNotMatch(packageJson.scripts.clean, /rm -rf/);
});
