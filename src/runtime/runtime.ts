import { existsSync, lstatSync, readdirSync } from "node:fs";
import { CollectorRunner } from "../collectors/index.js";
import {
  AI_VERSE_TOKEN_LEDGER_PATH,
  AI_VERSE_TOKEN_PRICING_ROOT,
  AI_VERSE_TOKEN_STATE_ROOT
} from "../native/constants.js";
import { inspectTokenNative } from "../native/doctor.js";
import { ensureSafeDirectory, safeRelativePath } from "../native/paths.js";
import { PriceSnapshotStore, PricingSynchronizer, createDefaultPricingSourceRegistry, createOpenRouterModelsFetcher, type PricingSyncReport } from "../pricing/index.js";
import { openTokenLedger } from "../storage/index.js";
import { ensureTokenRuntimeConfig, readTokenRuntimeConfig, TokenRuntimeError } from "./config.js";
import { createDefaultCollectorRegistry, discoverDefaultTokenSources } from "./sources.js";
import type {
  TokenCollectionResult,
  TokenCollectionSourceResult,
  TokenOperationalDoctor,
  TokenOperationalStatus,
  TokenSetupResult
} from "./types.js";

const DEFAULT_SOURCE_BATCH_SIZE = 500;
const DEFAULT_MAX_BATCHES_PER_SOURCE = 200;

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code ?? "RUNTIME_OPERATION_FAILED")
    : "RUNTIME_OPERATION_FAILED";
}

function requireInstalled(root: string): { readonly root: string; readonly enabled: boolean } {
  const status = inspectTokenNative(root, false);
  if (status.mode !== "ai-verse-os-v2" || status.registration?.registered !== true || status.registration.installed !== true || status.materialized !== true) {
    throw new TokenRuntimeError("SETUP_REQUIRES_INSTALL", "AI-Verse Token must be installed before setup");
  }
  return Object.freeze({ root: status.root_path, enabled: status.registration.enabled !== false });
}

export async function collectTokenUsage(rootPath: string, options: {
  readonly max_events_per_batch?: number;
  readonly max_batches_per_source?: number;
  readonly source_roots?: Readonly<Record<string, string>>;
} = {}): Promise<TokenCollectionResult> {
  const installed = requireInstalled(rootPath);
  const config = readTokenRuntimeConfig(installed.root);
  if (config === null) throw new TokenRuntimeError("SETUP_REQUIRED", "Token setup must be completed before collection");
  if (!installed.enabled || !config.collection.enabled) {
    return Object.freeze({ owner: "ai-verse-token", attribution_is_authority: false, source_count: 0, sources: Object.freeze([]), emitted: 0, inserted: 0, duplicates: 0, complete: true, error_count: 0 });
  }
  const maxEvents = options.max_events_per_batch ?? DEFAULT_SOURCE_BATCH_SIZE;
  const maxBatches = options.max_batches_per_source ?? DEFAULT_MAX_BATCHES_PER_SOURCE;
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 10_000) throw new TokenRuntimeError("COLLECTION_INVALID", "max_events_per_batch must be in 1..10000");
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 10_000) throw new TokenRuntimeError("COLLECTION_INVALID", "max_batches_per_source must be in 1..10000");

  ensureSafeDirectory(installed.root, AI_VERSE_TOKEN_STATE_ROOT);
  const ledgerPath = safeRelativePath(installed.root, AI_VERSE_TOKEN_LEDGER_PATH);
  const ledger = openTokenLedger({ path: ledgerPath, mode: "create-or-open" });
  try {
    const discovery = discoverDefaultTokenSources(options.source_roots);
    const registry = createDefaultCollectorRegistry();
    const runner = new CollectorRunner(registry);
    const rows: TokenCollectionSourceResult[] = [];

    for (const problem of discovery.problems) {
      rows.push(Object.freeze({ collector_id: problem.collector_id, source_key: "discovery", path: null, health: "error", emitted: 0, inserted: 0, duplicates: 0, complete: false, batches: 0, error_code: problem.code, error_message: problem.message }));
    }

    for (const source of discovery.sources) {
      let emitted = 0;
      let inserted = 0;
      let duplicates = 0;
      let batches = 0;
      let complete = false;
      let lastRun: Awaited<ReturnType<CollectorRunner["run"]>> | undefined;
      try {
        do {
          lastRun = await runner.run({
            collector_id: source.collector_id,
            source: source.source,
            ledger,
            checkpoint_key: source.source_key,
            max_events: maxEvents
          });
          batches += 1;
          emitted += lastRun.emitted;
          inserted += lastRun.inserted;
          duplicates += lastRun.duplicates;
          complete = lastRun.complete;
          if (lastRun.health.status === "unavailable") break;
        } while (!complete && batches < maxBatches);
        rows.push(Object.freeze({
          collector_id: source.collector_id,
          source_key: source.source_key,
          path: source.path,
          health: lastRun?.health.status ?? "error",
          emitted,
          inserted,
          duplicates,
          complete,
          batches,
          ...(lastRun === undefined ? {} : { last_run: lastRun })
        }));
      } catch (error) {
        rows.push(Object.freeze({ collector_id: source.collector_id, source_key: source.source_key, path: source.path, health: "error", emitted, inserted, duplicates, complete: false, batches, error_code: errorCode(error), error_message: error instanceof Error ? error.message : String(error), ...(lastRun === undefined ? {} : { last_run: lastRun }) }));
      }
    }

    return Object.freeze({
      owner: "ai-verse-token",
      attribution_is_authority: false,
      source_count: discovery.sources.length,
      sources: Object.freeze(rows),
      emitted: rows.reduce((sum, row) => sum + row.emitted, 0),
      inserted: rows.reduce((sum, row) => sum + row.inserted, 0),
      duplicates: rows.reduce((sum, row) => sum + row.duplicates, 0),
      complete: rows.every((row) => row.complete || row.health === "unavailable"),
      error_count: rows.filter((row) => row.health === "error").length
    });
  } finally {
    ledger.close();
  }
}

export async function syncTokenPricing(rootPath: string): Promise<readonly PricingSyncReport[]> {
  const installed = requireInstalled(rootPath);
  const config = readTokenRuntimeConfig(installed.root);
  if (config === null) throw new TokenRuntimeError("SETUP_REQUIRED", "Token setup must be completed before pricing sync");
  if (!installed.enabled || !config.pricing.openrouter_models_api.enabled) return Object.freeze([]);
  ensureSafeDirectory(installed.root, AI_VERSE_TOKEN_STATE_ROOT);
  ensureSafeDirectory(installed.root, AI_VERSE_TOKEN_PRICING_ROOT);
  const store = new PriceSnapshotStore(safeRelativePath(installed.root, AI_VERSE_TOKEN_PRICING_ROOT));
  const registry = createDefaultPricingSourceRegistry();
  const sync = new PricingSynchronizer({
    registry,
    store,
    fetchers: [createOpenRouterModelsFetcher({ api_key_env: config.pricing.openrouter_models_api.api_key_env })]
  });
  return Object.freeze([await sync.refreshSource({ source_id: "openrouter-models-api", reason: "manual" })]);
}

function safeSnapshotCount(root: string): number {
  const pricingRoot = safeRelativePath(root, AI_VERSE_TOKEN_PRICING_ROOT);
  const snapshots = `${pricingRoot}/snapshots`;
  if (!existsSync(snapshots)) return 0;
  try {
    const info = lstatSync(snapshots);
    if (info.isSymbolicLink() || !info.isDirectory()) return 0;
    return readdirSync(snapshots).filter((name) => name.endsWith(".json")).length;
  } catch { return 0; }
}

export function statusTokenRuntime(rootPath: string): TokenOperationalStatus {
  const native = inspectTokenNative(rootPath, false);
  const installed = native.registration?.registered === true && native.registration.installed === true && native.materialized === true;
  const enabled = installed && native.registration?.enabled !== false;
  let setup = false;
  try { setup = installed && readTokenRuntimeConfig(native.root_path) !== null; } catch { setup = false; }
  const ledgerExists = native.ledger_exists === true;
  const ready = installed && enabled && setup && ledgerExists;
  const state = !installed ? "absent" : !setup ? "setup-required" : !enabled ? "disabled" : !ledgerExists ? "unhealthy" : "ready";
  return Object.freeze({ state, ready, installed, enabled, setup, ledger_exists: ledgerExists });
}

export async function doctorTokenRuntime(rootPath: string): Promise<TokenOperationalDoctor> {
  const native = inspectTokenNative(rootPath, true);
  const problems: Array<{ code: string; message: string }> = native.problems.map((item) => ({ code: item.code, message: item.message }));
  const notices: Array<{ code: string; message: string }> = native.notices.map((item) => ({ code: item.code, message: item.message }));
  const installed = native.registration?.registered === true && native.registration.installed === true && native.materialized === true;
  const enabled = installed && native.registration?.enabled !== false;
  let config = null;
  try { config = installed ? readTokenRuntimeConfig(native.root_path) : null; }
  catch (error) { problems.push({ code: errorCode(error), message: error instanceof Error ? error.message : String(error) }); }
  const setup = config !== null;
  const ledgerExists = native.ledger_exists === true;
  const integrityOk = native.ledger_integrity?.ok ?? null;

  let healthy = 0;
  let degraded = 0;
  let unavailable = 0;
  let errors = 0;
  let discovered = 0;
  if (setup) {
    const discovery = discoverDefaultTokenSources();
    discovered = discovery.sources.length;
    errors += discovery.problems.length;
    for (const problem of discovery.problems) notices.push({ code: problem.code, message: problem.message });
    const registry = createDefaultCollectorRegistry();
    for (const source of discovery.sources) {
      try {
        const detection = await registry.require(source.collector_id).detect(source.source);
        if (detection.status === "available") healthy += 1;
        else if (detection.status === "degraded") degraded += 1;
        else unavailable += 1;
      } catch (error) {
        errors += 1;
        notices.push({ code: errorCode(error), message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (discovered === 0) notices.push({ code: "NO_LOCAL_SOURCES", message: "No supported local usage-history source is currently discoverable. Direct provider/Gateway ingestion can still populate Token." });
  }

  let openrouterStatus: string | null = null;
  const snapshotCount = setup ? safeSnapshotCount(native.root_path) : 0;
  if (setup) {
    const pricingRoot = safeRelativePath(native.root_path, AI_VERSE_TOKEN_PRICING_ROOT);
    if (existsSync(`${pricingRoot}/snapshots`) && existsSync(`${pricingRoot}/sync-state`)) {
      try { openrouterStatus = new PriceSnapshotStore(pricingRoot).syncState("openrouter-models-api")?.last_status ?? null; }
      catch (error) { notices.push({ code: "PRICING_STORE_UNHEALTHY", message: error instanceof Error ? error.message : String(error) }); }
    }
    if (snapshotCount === 0) notices.push({ code: "PRICING_NOT_YET_SYNCED", message: "No verified pricing snapshot is stored yet. ACTUAL remains available and unpriceable events remain UNKNOWN, never zero." });
  }

  if (installed && !setup) problems.push({ code: "SETUP_REQUIRED", message: "Token is installed but runtime setup has not initialized the ledger/configuration." });
  if (enabled && setup && !ledgerExists) problems.push({ code: "LEDGER_MISSING", message: "Token setup is present but the canonical ledger is missing." });
  if (integrityOk === false) problems.push({ code: "LEDGER_UNHEALTHY", message: "Token ledger integrity failed." });

  const pricingCredentialEnv = config?.pricing.openrouter_models_api.api_key_env;
  const credentialAvailable = pricingCredentialEnv !== undefined
    && typeof process.env[pricingCredentialEnv] === "string"
    && process.env[pricingCredentialEnv]!.trim().length > 0;
  const calculatedCostReady = snapshotCount > 0;
  const ready = installed && enabled && setup && ledgerExists && integrityOk !== false && problems.length === 0;
  const state = !installed ? "absent"
    : !setup ? "setup-required"
      : !enabled ? "disabled"
        : problems.length > 0 ? "unhealthy"
          : "ready";
  return Object.freeze({
    state,
    ready,
    depths_checked: Object.freeze(["structural", "attachment/discovery", "runtime", "dependency", "operational"] as const),
    installed,
    enabled,
    setup,
    ledger: Object.freeze({ exists: ledgerExists, integrity_ok: integrityOk }),
    collectors: Object.freeze({ discovered_sources: discovered, healthy, degraded, unavailable, errors }),
    pricing: Object.freeze({ transport_configured: config?.pricing.openrouter_models_api.enabled === true, credential_available: credentialAvailable, snapshot_count: snapshotCount, openrouter_last_status: openrouterStatus, calculated_cost_ready: calculatedCostReady }),
    cost_truth: Object.freeze({ primary_read_supports_actual: true, primary_read_supports_calculated: true, primary_read_preserves_unknown: true, calculated_cost_ready: calculatedCostReady }),
    problems: Object.freeze(problems),
    notices: Object.freeze(notices)
  });
}

export async function setupTokenRuntime(rootPath: string, options: {
  readonly source_roots?: Readonly<Record<string, string>>;
  readonly sync_pricing?: boolean;
} = {}): Promise<TokenSetupResult> {
  const installed = requireInstalled(rootPath);
  ensureSafeDirectory(installed.root, AI_VERSE_TOKEN_STATE_ROOT);
  const ledgerPath = safeRelativePath(installed.root, AI_VERSE_TOKEN_LEDGER_PATH);
  const ledgerCreated = !existsSync(ledgerPath);
  const ledger = openTokenLedger({ path: ledgerPath, mode: "create-or-open" });
  ledger.close();
  ensureSafeDirectory(installed.root, AI_VERSE_TOKEN_PRICING_ROOT);
  void new PriceSnapshotStore(safeRelativePath(installed.root, AI_VERSE_TOKEN_PRICING_ROOT));
  const configured = ensureTokenRuntimeConfig(installed.root);
  const collection = installed.enabled && configured.config.collection.enabled
    ? await collectTokenUsage(installed.root, { ...(options.source_roots === undefined ? {} : { source_roots: options.source_roots }) })
    : null;
  let pricing: readonly PricingSyncReport[] = Object.freeze([]);
  const apiKeyEnv = configured.config.pricing.openrouter_models_api.api_key_env;
  const hasPricingCredential = typeof process.env[apiKeyEnv] === "string" && process.env[apiKeyEnv]!.trim().length > 0;
  const shouldSyncPricing = options.sync_pricing ?? hasPricingCredential;
  if (installed.enabled && configured.config.pricing.openrouter_models_api.enabled && shouldSyncPricing) {
    try { pricing = await syncTokenPricing(installed.root); } catch { pricing = Object.freeze([]); }
  }
  const readiness = await doctorTokenRuntime(installed.root);
  return Object.freeze({ command: "setup", root_path: installed.root, config_created: configured.created, ledger_created: ledgerCreated, state_preserved: true, collection, pricing, readiness });
}
