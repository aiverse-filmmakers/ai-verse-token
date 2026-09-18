import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDefaultActualCostSourceRegistry } from "../cost/actual.js";
import { sealTrustedActualChargeEvent } from "../cost/trusted-actual-admission.js";
import { validateUsageEvent } from "../protocol/validation.js";
import type { UsageEvent } from "../protocol/types.js";
import type {
  CollectorDetection,
  CollectorEmission,
  CollectorScanRequest,
  CollectorScanResult,
  TokenCollector
} from "./types.js";

export interface HermesStateSource {
  readonly path: string;
  readonly source_id: string;
  readonly finalization_grace_seconds?: number;
}

export interface HermesStateDiscoveryOptions {
  readonly hermes_home: string;
  readonly finalization_grace_seconds?: number;
}

export class HermesCollectorError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HermesCollectorError";
    this.code = code;
  }
}

const HERMES_COLLECTOR_ID = "hermes-passive";
const HERMES_COLLECTOR_VERSION = "0.1.0";
const DEFAULT_FINALIZATION_GRACE_SECONDS = 60;
const MAX_SOURCE_ID = 200;
const MAX_SOURCE_TEXT = 500;
const actualCostRegistry = createDefaultActualCostSourceRegistry();

const MODEL_USAGE_COLUMNS = Object.freeze([
  "session_id", "model", "billing_provider", "billing_base_url", "billing_mode", "task",
  "api_call_count", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
  "reasoning_tokens", "actual_cost_usd", "cost_status", "cost_source", "first_seen", "last_seen"
]);

const SESSION_FALLBACK_COLUMNS = Object.freeze([
  "id", "source", "model", "started_at", "ended_at", "input_tokens", "output_tokens",
  "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "billing_provider",
  "billing_base_url", "billing_mode", "actual_cost_usd", "cost_status", "cost_source", "api_call_count"
]);

type SqlRecord = Record<string, unknown>;

interface HermesCursor {
  readonly ended: number;
  readonly row: readonly string[];
}

interface HermesCandidate {
  readonly ended: number;
  readonly rowKey: readonly string[];
  readonly emission: CollectorEmission;
}

function bounded(value: unknown, label: string, max = MAX_SOURCE_TEXT): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.includes("\u0000")) {
    throw new HermesCollectorError("HERMES_SOURCE_INVALID", `${label} must be a non-empty string up to ${max} characters without NUL`);
  }
  return value;
}

function optionalString(value: unknown, label: string, max = MAX_SOURCE_TEXT): string | null {
  if (value === null || value === undefined || value === "") return null;
  return bounded(value, label, max);
}

function source(value: HermesStateSource): Required<Pick<HermesStateSource, "path" | "source_id">> & { readonly finalization_grace_seconds: number } {
  const path = bounded(value.path, "source.path", 4096);
  const sourceId = bounded(value.source_id, "source.source_id", MAX_SOURCE_ID);
  const grace = value.finalization_grace_seconds ?? DEFAULT_FINALIZATION_GRACE_SECONDS;
  if (!Number.isFinite(grace) || grace < 0 || grace > 3600) {
    throw new HermesCollectorError("HERMES_SOURCE_INVALID", "source.finalization_grace_seconds must be in 0..3600");
  }
  return Object.freeze({ path, source_id: sourceId, finalization_grace_seconds: grace });
}

function openReadOnly(path: string): DatabaseSync {
  try {
    return new DatabaseSync(path, {
      readOnly: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      timeout: 5_000
    });
  } catch (error) {
    throw new HermesCollectorError("HERMES_DB_OPEN_FAILED", `failed to open Hermes database read-only: ${path}`, { cause: error });
  }
}

function record(value: unknown, label: string): SqlRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HermesCollectorError("HERMES_SCHEMA_INVALID", `${label} is not a SQLite row object`);
  }
  return value as SqlRecord;
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table) !== undefined;
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => {
    const item = record(row, `${table} column`);
    return typeof item.name === "string" ? item.name : "";
  }).filter(Boolean));
}

function hasColumns(actual: ReadonlySet<string>, required: readonly string[]): boolean {
  return required.every((column) => actual.has(column));
}

function schemaMode(db: DatabaseSync): "model-usage" | "sessions" | "unsupported" {
  const sessions = tableColumns(db, "sessions");
  if (!hasColumns(sessions, SESSION_FALLBACK_COLUMNS)) return "unsupported";
  const model = tableColumns(db, "session_model_usage");
  return hasColumns(model, MODEL_USAGE_COLUMNS) ? "model-usage" : "sessions";
}

function detectionForSource(input: HermesStateSource): CollectorDetection {
  const normalized = source(input);
  if (!existsSync(normalized.path)) return Object.freeze({ status: "unavailable", code: "HERMES_DB_NOT_FOUND" });
  try {
    const info = lstatSync(normalized.path);
    if (info.isSymbolicLink() || !info.isFile()) return Object.freeze({ status: "unavailable", code: "HERMES_DB_UNSAFE" });
  } catch {
    return Object.freeze({ status: "unavailable", code: "HERMES_DB_UNSAFE" });
  }
  let db: DatabaseSync | undefined;
  try {
    db = openReadOnly(normalized.path);
    const mode = schemaMode(db);
    if (mode === "model-usage") return Object.freeze({ status: "available", code: "HERMES_MODEL_USAGE_READY" });
    if (mode === "sessions") return Object.freeze({ status: "degraded", code: "HERMES_SESSION_SUMMARY_FALLBACK" });
    return Object.freeze({ status: "unavailable", code: "HERMES_SCHEMA_UNSUPPORTED" });
  } catch (error) {
    if (error instanceof HermesCollectorError) return Object.freeze({ status: "unavailable", code: error.code });
    return Object.freeze({ status: "unavailable", code: "HERMES_DB_OPEN_FAILED" });
  } finally {
    if (db?.isOpen) db.close();
  }
}

function finiteNonNegativeInteger(value: unknown, label: string): number {
  const number = value === null || value === undefined ? 0 : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new HermesCollectorError("HERMES_ROW_INVALID", `${label} must be a non-negative safe integer`);
  }
  return number;
}

function finiteEpoch(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new HermesCollectorError("HERMES_ROW_INVALID", `${label} must be a non-negative epoch timestamp`);
  }
  return number;
}

function isoFromEpoch(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function hash(parts: readonly string[]): string {
  const h = createHash("sha256");
  for (const part of parts) {
    h.update(String(part.length));
    h.update(":");
    h.update(part);
    h.update("|");
  }
  return h.digest("hex");
}

function encodeCursor(ended: number, row: readonly string[]): string {
  return JSON.stringify({ ended, row });
}

function decodeCursor(value: string | null): HermesCursor | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("object required");
    const item = parsed as { ended?: unknown; row?: unknown };
    if (typeof item.ended !== "number" || !Number.isFinite(item.ended) || item.ended < 0) throw new Error("ended invalid");
    if (!Array.isArray(item.row) || item.row.length < 1 || item.row.some((part) => typeof part !== "string" || part.includes("\u0000"))) {
      throw new Error("row invalid");
    }
    return Object.freeze({ ended: item.ended, row: Object.freeze([...item.row]) });
  } catch (error) {
    throw new HermesCollectorError("HERMES_CHECKPOINT_INVALID", "Hermes checkpoint cursor is invalid", { cause: error });
  }
}

function billingPlatform(value: unknown): string | null {
  const result = optionalString(value, "billing_provider", 200);
  if (result === null || result === "unknown") return null;
  return result;
}

function modelText(value: unknown): string | null {
  const result = optionalString(value, "model", 500);
  if (result === null || result === "unknown") return null;
  return result;
}

function sourceSurface(value: unknown): string | null {
  return optionalString(value, "session.source", 200);
}

function baseEvent(args: {
  sourceId: string;
  sourceType: string;
  sourceRecordKey: readonly string[];
  sessionId: string;
  task: string | null;
  surface: string | null;
  model: string | null;
  provider: string | null;
  billingMode: string | null;
  usage: UsageEvent["usage"];
  observedAt: string;
}): UsageEvent {
  const fingerprint = hash([args.sourceId, args.sourceType, ...args.sourceRecordKey]);
  const eventHash = hash(["hermes", args.sourceId, args.sourceType, ...args.sourceRecordKey]);
  return validateUsageEvent({
    schema_version: "ai-verse-token/0.1",
    event_id: `evt_hermes_${eventHash.slice(0, 40)}`,
    session_id: args.sessionId,
    ...(args.task === null ? {} : { task_id: args.task }),
    source: {
      runtime: "hermes",
      source_type: args.sourceType,
      source_record_id: `hermes:${eventHash.slice(0, 32)}`,
      ...(args.surface === null ? {} : { source_platform: args.surface })
    },
    observed_at: args.observedAt,
    identity: {
      billing_platform: args.provider,
      requested_model: args.model,
      resolved_model: null,
      billing_mode: args.billingMode
    },
    usage: args.usage,
    timing: {},
    provenance: {
      collector_id: HERMES_COLLECTOR_ID,
      collector_version: HERMES_COLLECTOR_VERSION,
      source_type: args.sourceType,
      source_record_fingerprint: fingerprint,
      usage_quality: "runtime_reported",
      timing_quality: "unknown",
      content_stored: false
    }
  });
}

function attachHermesActualIfUnambiguous(event: UsageEvent, row: SqlRecord, recordKey: string): UsageEvent {
  const status = optionalString(row.cost_status, "cost_status", 100)?.toLowerCase() ?? null;
  const costSource = optionalString(row.cost_source, "cost_source", 200);
  if (status !== "actual" || costSource === null || row.actual_cost_usd === null || row.actual_cost_usd === undefined) return event;
  const actual = Number(row.actual_cost_usd);
  if (!Number.isFinite(actual) || actual < 0) return event;
  const attached = actualCostRegistry.attach(event, {
    source_id: "hermes-state-db",
    amount: actual,
    currency: "USD",
    external_charge_id: recordKey,
    reported_at: event.observed_at
  });
  return sealTrustedActualChargeEvent(attached.event, attached.source.source_id);
}

function modelUsageCandidates(
  db: DatabaseSync,
  state: ReturnType<typeof source>,
  cutoff: number,
  checkpoint: HermesCursor | null,
  limit: number
): HermesCandidate[] {
  const cursorRow = checkpoint === null
    ? ["", "", "", "", "", ""]
    : Array.from({ length: 6 }, (_, index) => checkpoint.row[index] ?? "");
  const rows = db.prepare(`
    SELECT
      u.session_id, u.model, u.billing_provider, u.billing_base_url, u.billing_mode, u.task,
      u.api_call_count, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens,
      u.reasoning_tokens, u.actual_cost_usd, u.cost_status, u.cost_source, u.first_seen, u.last_seen,
      s.source AS session_source, s.ended_at AS session_ended_at
    FROM session_model_usage AS u
    JOIN sessions AS s ON s.id = u.session_id
    WHERE s.ended_at IS NOT NULL AND s.ended_at > 0 AND s.ended_at <= ?
      AND (
        ? IS NULL
        OR s.ended_at > ?
        OR (
          s.ended_at = ? AND
          (
            COALESCE(u.session_id, ''), COALESCE(u.model, ''), COALESCE(u.billing_provider, ''),
            COALESCE(u.billing_base_url, ''), COALESCE(u.billing_mode, ''), COALESCE(u.task, '')
          ) > (?, ?, ?, ?, ?, ?)
        )
      )
    ORDER BY s.ended_at ASC, u.session_id ASC, u.model ASC, u.billing_provider ASC,
             u.billing_base_url ASC, u.billing_mode ASC, u.task ASC
    LIMIT ?
  `).all(
    cutoff,
    checkpoint === null ? null : checkpoint.ended,
    checkpoint === null ? null : checkpoint.ended,
    checkpoint === null ? null : checkpoint.ended,
    ...cursorRow,
    limit
  );

  return rows.map((raw) => {
    const row = record(raw, "Hermes model usage row");
    const sessionId = bounded(row.session_id, "session_id", 500);
    const model = modelText(row.model);
    const provider = billingPlatform(row.billing_provider);
    const baseUrl = optionalString(row.billing_base_url, "billing_base_url", 1000) ?? "";
    const mode = optionalString(row.billing_mode, "billing_mode", 200);
    const task = optionalString(row.task, "task", 500);
    const ended = finiteEpoch(row.session_ended_at, "session.ended_at");
    const lastSeen = row.last_seen === null || row.last_seen === undefined ? ended : finiteEpoch(row.last_seen, "last_seen");
    const rowKey = Object.freeze([sessionId, model ?? "", provider ?? "", baseUrl, mode ?? "", task ?? ""]);
    const recordKey = rowKey.join("|");
    let event = baseEvent({
      sourceId: state.source_id,
      sourceType: "hermes.session_model_usage",
      sourceRecordKey: rowKey,
      sessionId,
      task,
      surface: sourceSurface(row.session_source),
      model,
      provider,
      billingMode: mode,
      usage: {
        input_tokens: finiteNonNegativeInteger(row.input_tokens, "input_tokens"),
        output_tokens: finiteNonNegativeInteger(row.output_tokens, "output_tokens"),
        cache_read_tokens: finiteNonNegativeInteger(row.cache_read_tokens, "cache_read_tokens"),
        cache_write_tokens: finiteNonNegativeInteger(row.cache_write_tokens, "cache_write_tokens"),
        reasoning_tokens: finiteNonNegativeInteger(row.reasoning_tokens, "reasoning_tokens"),
        request_units: finiteNonNegativeInteger(row.api_call_count, "api_call_count")
      },
      observedAt: isoFromEpoch(Math.max(ended, lastSeen))
    });
    event = attachHermesActualIfUnambiguous(event, row, `hermes:${state.source_id}:${recordKey}`);
    return Object.freeze({
      ended,
      rowKey,
      emission: Object.freeze({
        event,
        checkpoint_cursor: encodeCursor(ended, rowKey),
        correlation_keys: Object.freeze([
          Object.freeze({ kind: "hermes_session", value: sessionId }),
          Object.freeze({ kind: "hermes_source", value: state.source_id })
        ])
      })
    });
  });
}

function sessionFallbackCandidates(
  db: DatabaseSync,
  state: ReturnType<typeof source>,
  cutoff: number,
  checkpoint: HermesCursor | null,
  limit: number
): HermesCandidate[] {
  const rows = db.prepare(`
    SELECT id, source, model, started_at, ended_at, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, reasoning_tokens, billing_provider,
           billing_base_url, billing_mode, actual_cost_usd, cost_status, cost_source, api_call_count
    FROM sessions
    WHERE ended_at IS NOT NULL AND ended_at > 0 AND ended_at <= ?
      AND (? IS NULL OR ended_at > ? OR (ended_at = ? AND id > ?))
    ORDER BY ended_at ASC, id ASC
    LIMIT ?
  `).all(
    cutoff,
    checkpoint === null ? null : checkpoint.ended,
    checkpoint === null ? null : checkpoint.ended,
    checkpoint === null ? null : checkpoint.ended,
    checkpoint?.row[0] ?? "",
    limit
  );

  return rows.map((raw) => {
    const row = record(raw, "Hermes session row");
    const sessionId = bounded(row.id, "session.id", 500);
    const ended = finiteEpoch(row.ended_at, "session.ended_at");
    const rowKey = Object.freeze([sessionId]);
    let event = baseEvent({
      sourceId: state.source_id,
      sourceType: "hermes.sessions",
      sourceRecordKey: rowKey,
      sessionId,
      task: null,
      surface: sourceSurface(row.source),
      model: modelText(row.model),
      provider: billingPlatform(row.billing_provider),
      billingMode: optionalString(row.billing_mode, "billing_mode", 200),
      usage: {
        input_tokens: finiteNonNegativeInteger(row.input_tokens, "input_tokens"),
        output_tokens: finiteNonNegativeInteger(row.output_tokens, "output_tokens"),
        cache_read_tokens: finiteNonNegativeInteger(row.cache_read_tokens, "cache_read_tokens"),
        cache_write_tokens: finiteNonNegativeInteger(row.cache_write_tokens, "cache_write_tokens"),
        reasoning_tokens: finiteNonNegativeInteger(row.reasoning_tokens, "reasoning_tokens"),
        request_units: finiteNonNegativeInteger(row.api_call_count, "api_call_count")
      },
      observedAt: isoFromEpoch(ended)
    });
    event = attachHermesActualIfUnambiguous(event, row, `hermes:${state.source_id}:${sessionId}`);
    return Object.freeze({
      ended,
      rowKey,
      emission: Object.freeze({
        event,
        checkpoint_cursor: encodeCursor(ended, rowKey),
        correlation_keys: Object.freeze([
          Object.freeze({ kind: "hermes_session", value: sessionId }),
          Object.freeze({ kind: "hermes_source", value: state.source_id })
        ])
      })
    });
  });
}

function collectHermes(request: CollectorScanRequest<HermesStateSource>): CollectorScanResult {
  const state = source(request.source);
  if (!existsSync(state.path)) throw new HermesCollectorError("HERMES_DB_NOT_FOUND", `Hermes database does not exist: ${state.path}`);
  const stateInfo = lstatSync(state.path);
  if (stateInfo.isSymbolicLink() || !stateInfo.isFile()) throw new HermesCollectorError("HERMES_DB_UNSAFE", `Hermes database path is unsafe: ${state.path}`);
  const checkpoint = decodeCursor(request.checkpoint_cursor);
  let db: DatabaseSync | undefined;
  try {
    db = openReadOnly(state.path);
    const mode = schemaMode(db);
    if (mode === "unsupported") throw new HermesCollectorError("HERMES_SCHEMA_UNSUPPORTED", "Hermes database schema is unsupported");
    const cutoff = Date.now() / 1000 - state.finalization_grace_seconds;
    const candidates = mode === "model-usage"
      ? modelUsageCandidates(db, state, cutoff, checkpoint, request.max_events + 1)
      : sessionFallbackCandidates(db, state, cutoff, checkpoint, request.max_events + 1);
    const selected = candidates.slice(0, request.max_events);
    return Object.freeze({
      emissions: Object.freeze(selected.map((candidate) => candidate.emission)),
      complete: candidates.length <= request.max_events
    });
  } finally {
    if (db?.isOpen) db.close();
  }
}

export const HERMES_PASSIVE_COLLECTOR: TokenCollector<HermesStateSource> = Object.freeze({
  definition: Object.freeze({
    id: HERMES_COLLECTOR_ID,
    version: HERMES_COLLECTOR_VERSION,
    runtimes: Object.freeze(["hermes"])
  }),
  detect: detectionForSource,
  collect: collectHermes
});

export function discoverHermesStateSources(options: HermesStateDiscoveryOptions): readonly HermesStateSource[] {
  const home = bounded(options.hermes_home, "options.hermes_home", 4096);
  const grace = options.finalization_grace_seconds;
  const found: HermesStateSource[] = [];
  const main = join(home, "state.db");
  if (existsSync(main) && !lstatSync(main).isSymbolicLink() && lstatSync(main).isFile()) {
    found.push(Object.freeze({ path: main, source_id: "main", ...(grace === undefined ? {} : { finalization_grace_seconds: grace }) }));
  }
  const profiles = join(home, "profiles");
  if (existsSync(profiles) && !lstatSync(profiles).isSymbolicLink() && lstatSync(profiles).isDirectory()) {
    for (const profile of readdirSync(profiles).sort()) {
      if (profile.length < 1 || profile.length > 150 || profile.includes("\u0000") || profile === "." || profile === "..") continue;
      const path = join(profiles, profile, "state.db");
      if (!existsSync(path)) continue;
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      found.push(Object.freeze({
        path,
        source_id: `profile:${profile}`,
        ...(grace === undefined ? {} : { finalization_grace_seconds: grace })
      }));
    }
  }
  return Object.freeze(found);
}
