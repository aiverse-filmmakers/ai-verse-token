import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TOKEN_PROTOCOL_VERSION } from "../protocol/constants.js";
import type { UsageEvent } from "../protocol/types.js";
import { validateUsageEvent } from "../protocol/validation.js";
import { executeUsageAggregate, executeUsageQuery } from "../query/engine.js";
import type { UsageAggregateRequest, UsageAggregateResult, UsageQueryRequest, UsageQueryResult } from "../query/types.js";
import {
  TOKEN_LEDGER_APPLICATION_ID,
  TOKEN_LEDGER_BUSY_TIMEOUT_MS,
  TOKEN_LEDGER_FORMAT,
  TOKEN_LEDGER_FORMAT_VERSION,
  TOKEN_LEDGER_METADATA_KEYS
} from "./constants.js";
import { TokenLedgerError } from "./errors.js";

export type TokenLedgerOpenMode = "create-or-open" | "open-existing" | "read-only";
export type IntegrityCheckMode = "quick" | "full";

export interface TokenLedgerOpenOptions {
  readonly path: string;
  readonly mode?: TokenLedgerOpenMode;
}

export interface TokenLedgerMetadata {
  readonly format: typeof TOKEN_LEDGER_FORMAT;
  readonly formatVersion: typeof TOKEN_LEDGER_FORMAT_VERSION;
  readonly protocolVersion: typeof TOKEN_PROTOCOL_VERSION;
  readonly createdAt: string;
}

export interface TokenLedgerIntegrityResult {
  readonly ok: boolean;
  readonly mode: IntegrityCheckMode;
  readonly details: readonly string[];
}

export interface TokenLedgerDiagnostics {
  readonly path: string;
  readonly readOnly: boolean;
  readonly journalMode: string;
  readonly foreignKeys: boolean;
  readonly applicationId: number;
  readonly userVersion: number;
  readonly metadata: TokenLedgerMetadata;
}

export interface CorrelationKey {
  readonly kind: string;
  readonly value: string;
}

export interface CollectorCheckpointWrite {
  readonly key?: string;
  readonly cursor: string;
}

export interface CollectorCheckpointState {
  readonly collectorId: string;
  readonly key: string;
  readonly cursor: string;
  readonly updatedAt: string;
}

export interface IngestUsageEventOptions {
  readonly correlationKeys?: readonly CorrelationKey[];
  readonly checkpoint?: CollectorCheckpointWrite;
}

export interface IngestUsageEventResult {
  readonly status: "inserted" | "duplicate";
  readonly eventId: string;
  readonly duplicateOf: string | null;
  readonly correlationKeysAdded: number;
  readonly checkpointUpdated: boolean;
}

type SqlRecord = Record<string, unknown>;

const CREATE_SCHEMA_SQL = `
CREATE TABLE token_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE usage_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  schema_version TEXT NOT NULL,
  request_id TEXT,
  session_id TEXT,
  run_id TEXT,
  task_id TEXT,

  runtime TEXT NOT NULL,
  runtime_version TEXT,
  source_type TEXT NOT NULL,
  source_record_id TEXT,
  source_platform TEXT,
  observed_at TEXT NOT NULL,

  billing_platform TEXT,
  inference_provider TEXT,
  requested_model TEXT,
  resolved_model TEXT,
  provider_model_id TEXT,
  service_tier TEXT,
  region TEXT,
  billing_mode TEXT,
  alias_rule_id TEXT,

  system_id TEXT,
  workspace_id TEXT,
  project_id TEXT,
  agent_id TEXT,
  bot_id TEXT,
  worker_id TEXT,
  skill_id TEXT,
  automation_id TEXT,
  tool_id TEXT,

  context_input_tokens INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cached_input_tokens INTEGER,
  audio_input_tokens INTEGER,
  audio_output_tokens INTEGER,
  image_input_units REAL,
  image_output_units REAL,
  web_search_units REAL,
  request_units REAL,
  total_tokens_reported INTEGER,

  started_at TEXT,
  first_byte_at TEXT,
  first_token_at TEXT,
  last_token_at TEXT,
  ended_at TEXT,
  wall_ms REAL,
  ttft_ms REAL,
  generation_ms REAL,
  queue_ms REAL,
  provider_ms REAL,
  gateway_overhead_ms REAL,
  tool_wait_ms REAL,
  network_ms REAL,

  actual_charge_amount TEXT,
  actual_charge_currency TEXT,
  actual_charge_source TEXT,
  actual_charge_external_id TEXT,
  actual_charge_reported_at TEXT,

  collector_id TEXT NOT NULL,
  collector_version TEXT,
  provenance_source_type TEXT,
  source_record_fingerprint TEXT NOT NULL,
  usage_quality TEXT NOT NULL,
  timing_quality TEXT NOT NULL,
  content_stored INTEGER NOT NULL DEFAULT 0 CHECK (content_stored = 0),

  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  ingested_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_usage_events_observed_at ON usage_events(observed_at, event_id);
CREATE INDEX idx_usage_events_request ON usage_events(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX idx_usage_events_session ON usage_events(session_id, observed_at) WHERE session_id IS NOT NULL;
CREATE INDEX idx_usage_events_runtime ON usage_events(runtime, observed_at);
CREATE INDEX idx_usage_events_billing_model ON usage_events(billing_platform, resolved_model, observed_at);
CREATE INDEX idx_usage_events_workspace ON usage_events(workspace_id, observed_at) WHERE workspace_id IS NOT NULL;
CREATE INDEX idx_usage_events_agent ON usage_events(agent_id, observed_at) WHERE agent_id IS NOT NULL;
CREATE UNIQUE INDEX uq_usage_events_source_fingerprint
  ON usage_events(collector_id, source_record_fingerprint);

CREATE TABLE event_correlations (
  event_id TEXT NOT NULL REFERENCES usage_events(event_id) ON DELETE RESTRICT,
  key_kind TEXT NOT NULL,
  key_value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(event_id, key_kind, key_value)
) STRICT;

CREATE INDEX idx_event_correlations_lookup
  ON event_correlations(key_kind, key_value, event_id);

CREATE TABLE event_supersessions (
  event_id TEXT PRIMARY KEY NOT NULL REFERENCES usage_events(event_id) ON DELETE RESTRICT,
  canonical_event_id TEXT NOT NULL REFERENCES usage_events(event_id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (event_id <> canonical_event_id)
) STRICT;

CREATE INDEX idx_event_supersessions_canonical
  ON event_supersessions(canonical_event_id, event_id);

CREATE TABLE collector_checkpoints (
  collector_id TEXT NOT NULL,
  checkpoint_key TEXT NOT NULL,
  cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(collector_id, checkpoint_key)
) STRICT;

CREATE TRIGGER usage_events_no_update
BEFORE UPDATE ON usage_events
BEGIN
  SELECT RAISE(ABORT, 'usage_events are immutable');
END;

CREATE TRIGGER usage_events_no_delete
BEFORE DELETE ON usage_events
BEGIN
  SELECT RAISE(ABORT, 'usage_events are immutable');
END;

CREATE TRIGGER event_correlations_no_update
BEFORE UPDATE ON event_correlations
BEGIN
  SELECT RAISE(ABORT, 'event_correlations are append-only');
END;

CREATE TRIGGER event_correlations_no_delete
BEFORE DELETE ON event_correlations
BEGIN
  SELECT RAISE(ABORT, 'event_correlations are append-only');
END;

CREATE TRIGGER event_supersessions_no_update
BEFORE UPDATE ON event_supersessions
BEGIN
  SELECT RAISE(ABORT, 'event_supersessions are append-only');
END;

CREATE TRIGGER event_supersessions_no_delete
BEFORE DELETE ON event_supersessions
BEGIN
  SELECT RAISE(ABORT, 'event_supersessions are append-only');
END;
`;

function asRecord(value: unknown, context: string): SqlRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TokenLedgerError("OPEN_FAILED", `${context} returned an unexpected SQLite result`);
  }
  return value as SqlRecord;
}

function firstValue(value: unknown, context: string): unknown {
  const record = asRecord(value, context);
  const values = Object.values(record);
  if (values.length !== 1) {
    throw new TokenLedgerError("OPEN_FAILED", `${context} returned an unexpected SQLite result`);
  }
  return values[0];
}

function pragmaNumber(db: DatabaseSync, pragma: string): number {
  const value = firstValue(db.prepare(`PRAGMA ${pragma}`).get(), `PRAGMA ${pragma}`);
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TokenLedgerError("OPEN_FAILED", `PRAGMA ${pragma} did not return an integer`);
  }
  return value;
}

function pragmaText(db: DatabaseSync, pragma: string): string {
  const value = firstValue(db.prepare(`PRAGMA ${pragma}`).get(), `PRAGMA ${pragma}`);
  if (typeof value !== "string") {
    throw new TokenLedgerError("OPEN_FAILED", `PRAGMA ${pragma} did not return text`);
  }
  return value;
}

function configureConnection(db: DatabaseSync, readOnly: boolean): void {
  db.exec(`PRAGMA busy_timeout = ${TOKEN_LEDGER_BUSY_TIMEOUT_MS};`);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA trusted_schema = OFF;");
  db.aggregate("ai_verse_exact_int_sum", {
    start: 0n,
    step: (total: bigint, value: unknown) => {
      if (value === null || value === undefined) return total;
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new TokenLedgerError("FORMAT_MISMATCH", "Exact integer aggregate received a non-safe integer");
      }
      return total + BigInt(value);
    },
    result: (total: bigint) => total.toString()
  });
  db.exec("PRAGMA recursive_triggers = ON;");

  if (readOnly) {
    db.exec("PRAGMA query_only = ON;");
    return;
  }

  const journalMode = pragmaText(db, "journal_mode = WAL").toLowerCase();
  if (journalMode !== "wal") {
    throw new TokenLedgerError("OPEN_FAILED", `SQLite refused WAL mode and returned ${journalMode}`);
  }
  db.exec("PRAGMA synchronous = FULL;");
}

function listUserTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  return rows.map((row) => {
    const name = asRecord(row, "sqlite_master row").name;
    if (typeof name !== "string") {
      throw new TokenLedgerError("OPEN_FAILED", "sqlite_master returned an invalid table name");
    }
    return name;
  });
}

function readMetadataRows(db: DatabaseSync): Map<string, string> {
  const rows = db.prepare("SELECT key, value FROM token_metadata ORDER BY key").all();
  const metadata = new Map<string, string>();
  for (const row of rows) {
    const record = asRecord(row, "token_metadata row");
    if (typeof record.key !== "string" || typeof record.value !== "string") {
      throw new TokenLedgerError("FORMAT_MISMATCH", "Ledger metadata contains invalid values");
    }
    metadata.set(record.key, record.value);
  }
  return metadata;
}

function parseMetadata(db: DatabaseSync): TokenLedgerMetadata {
  const metadata = readMetadataRows(db);
  const format = metadata.get(TOKEN_LEDGER_METADATA_KEYS.format);
  if (format !== TOKEN_LEDGER_FORMAT) {
    throw new TokenLedgerError("FORMAT_MISMATCH", `Expected ledger format ${TOKEN_LEDGER_FORMAT}`);
  }

  const rawFormatVersion = metadata.get(TOKEN_LEDGER_METADATA_KEYS.formatVersion);
  const formatVersion = rawFormatVersion === undefined ? Number.NaN : Number(rawFormatVersion);
  if (formatVersion !== TOKEN_LEDGER_FORMAT_VERSION) {
    throw new TokenLedgerError(
      "VERSION_UNSUPPORTED",
      `Ledger format version ${String(rawFormatVersion)} is unsupported; expected ${TOKEN_LEDGER_FORMAT_VERSION}`
    );
  }

  const protocolVersion = metadata.get(TOKEN_LEDGER_METADATA_KEYS.protocolVersion);
  if (protocolVersion !== TOKEN_PROTOCOL_VERSION) {
    throw new TokenLedgerError(
      "VERSION_UNSUPPORTED",
      `Ledger protocol version ${String(protocolVersion)} is unsupported; expected ${TOKEN_PROTOCOL_VERSION}`
    );
  }

  const createdAt = metadata.get(TOKEN_LEDGER_METADATA_KEYS.createdAt);
  if (createdAt === undefined || Number.isNaN(Date.parse(createdAt))) {
    throw new TokenLedgerError("FORMAT_MISMATCH", "Ledger metadata has an invalid created_at value");
  }

  return {
    format: TOKEN_LEDGER_FORMAT,
    formatVersion: TOKEN_LEDGER_FORMAT_VERSION,
    protocolVersion: TOKEN_PROTOCOL_VERSION,
    createdAt
  };
}

function initializeNewLedger(db: DatabaseSync): void {
  const tables = listUserTables(db);
  if (tables.length > 0) {
    throw new TokenLedgerError(
      "FOREIGN_DATABASE",
      `Refusing to initialize a non-empty SQLite database containing: ${tables.join(", ")}`
    );
  }

  const applicationId = pragmaNumber(db, "application_id");
  const userVersion = pragmaNumber(db, "user_version");
  if (applicationId !== 0 || userVersion !== 0) {
    throw new TokenLedgerError(
      "FOREIGN_DATABASE",
      `Refusing to initialize SQLite metadata application_id=${applicationId}, user_version=${userVersion}`
    );
  }

  const createdAt = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.exec(CREATE_SCHEMA_SQL);
    const insert = db.prepare("INSERT INTO token_metadata(key, value) VALUES (?, ?)");
    insert.run(TOKEN_LEDGER_METADATA_KEYS.format, TOKEN_LEDGER_FORMAT);
    insert.run(TOKEN_LEDGER_METADATA_KEYS.formatVersion, String(TOKEN_LEDGER_FORMAT_VERSION));
    insert.run(TOKEN_LEDGER_METADATA_KEYS.protocolVersion, TOKEN_PROTOCOL_VERSION);
    insert.run(TOKEN_LEDGER_METADATA_KEYS.createdAt, createdAt);
    db.exec(`PRAGMA application_id = ${TOKEN_LEDGER_APPLICATION_ID};`);
    db.exec(`PRAGMA user_version = ${TOKEN_LEDGER_FORMAT_VERSION};`);
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the initialization error.
    }
    throw error;
  }
}

const REQUIRED_SCHEMA_OBJECTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  table: ["token_metadata", "usage_events", "event_correlations", "event_supersessions", "collector_checkpoints"],
  trigger: [
    "usage_events_no_update",
    "usage_events_no_delete",
    "event_correlations_no_update",
    "event_correlations_no_delete",
    "event_supersessions_no_update",
    "event_supersessions_no_delete"
  ],
  index: [
    "uq_usage_events_source_fingerprint",
    "idx_usage_events_observed_at",
    "idx_event_correlations_lookup",
    "idx_event_supersessions_canonical"
  ]
});

function verifyRequiredSchemaObjects(db: DatabaseSync): void {
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(CREATE_SCHEMA_SQL);
    const normalizeSql = (value: unknown): string => {
      if (typeof value !== "string") throw new TokenLedgerError("FORMAT_MISMATCH", "SQLite schema object has no SQL definition");
      return value.replace(/\s+/g, " ").trim().replace(/;$/, "").toLowerCase();
    };
  for (const [type, required] of Object.entries(REQUIRED_SCHEMA_OBJECTS)) {
    for (const name of required) {
      const actualRow = db.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(type, name);
      if (actualRow === undefined) {
        throw new TokenLedgerError("FORMAT_MISMATCH", `Required ledger ${type} is missing: ${name}`);
      }
      const expectedRow = expected.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(type, name);
      if (expectedRow === undefined) throw new TokenLedgerError("FORMAT_MISMATCH", `Internal expected ${type} is missing: ${name}`);
      const actualSql = normalizeSql(asRecord(actualRow, `sqlite_master ${type}.${name}`).sql);
      const expectedSql = normalizeSql(asRecord(expectedRow, `expected sqlite_master ${type}.${name}`).sql);
      if (actualSql !== expectedSql) {
        throw new TokenLedgerError("FORMAT_MISMATCH", `Required ledger ${type} definition does not match: ${name}`);
      }
    }
  }
  } finally {
    expected.close();
  }
}

function verifyLedgerIdentity(db: DatabaseSync): TokenLedgerMetadata {
  const tables = listUserTables(db);
  if (!tables.includes("token_metadata")) {
    throw new TokenLedgerError("FOREIGN_DATABASE", "SQLite database is not an AI-Verse Token ledger");
  }

  const applicationId = pragmaNumber(db, "application_id");
  if (applicationId !== TOKEN_LEDGER_APPLICATION_ID) {
    throw new TokenLedgerError(
      "FORMAT_MISMATCH",
      `Ledger application_id ${applicationId} does not match ${TOKEN_LEDGER_APPLICATION_ID}`
    );
  }

  const userVersion = pragmaNumber(db, "user_version");
  if (userVersion !== TOKEN_LEDGER_FORMAT_VERSION) {
    throw new TokenLedgerError(
      "VERSION_UNSUPPORTED",
      `Ledger user_version ${userVersion} is unsupported; expected ${TOKEN_LEDGER_FORMAT_VERSION}`
    );
  }

  verifyRequiredSchemaObjects(db);
  return parseMetadata(db);
}

function runIntegrityCheck(db: DatabaseSync, mode: IntegrityCheckMode): TokenLedgerIntegrityResult {
  const pragma = mode === "full" ? "integrity_check" : "quick_check";
  const rows = db.prepare(`PRAGMA ${pragma}`).all();
  const details = rows.map((row) => String(firstValue(row, `PRAGMA ${pragma}`)));
  return { ok: details.length === 1 && details[0] === "ok", mode, details };
}

const CORRELATION_KIND_RE = /^[a-z][a-z0-9_.:-]{0,63}$/;

function ingestString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.includes("\u0000")) {
    throw new TokenLedgerError("INGEST_INVALID", `${label} must be a non-empty string up to ${max} characters without NUL`);
  }
  return value;
}

function normalizeCorrelationKeys(
  event: UsageEvent,
  supplied: readonly CorrelationKey[] | undefined
): CorrelationKey[] {
  const candidates: CorrelationKey[] = [];
  if (event.request_id != null) candidates.push({ kind: "request_id", value: event.request_id });
  if (event.actual_charge?.external_charge_id != null) {
    candidates.push({ kind: "external_charge_id", value: event.actual_charge.external_charge_id });
  }
  if (supplied !== undefined) candidates.push(...supplied);

  const deduped = new Map<string, CorrelationKey>();
  for (const candidate of candidates) {
    const kind = ingestString(candidate.kind, "correlation kind", 64);
    if (!CORRELATION_KIND_RE.test(kind)) {
      throw new TokenLedgerError("INGEST_INVALID", `correlation kind is invalid: ${kind}`);
    }
    const value = ingestString(candidate.value, "correlation value", 500);
    deduped.set(`${kind}\u0000${value}`, { kind, value });
  }
  return [...deduped.values()].sort((a, b) =>
    a.kind === b.kind ? a.value.localeCompare(b.value) : a.kind.localeCompare(b.kind)
  );
}

function normalizeCheckpoint(checkpoint: CollectorCheckpointWrite | undefined): { key: string; cursor: string } | null {
  if (checkpoint === undefined) return null;
  const key = ingestString(checkpoint.key ?? "default", "checkpoint key", 200);
  const cursor = ingestString(checkpoint.cursor, "checkpoint cursor", 4096);
  return { key, cursor };
}

function semanticSourceFacts(event: UsageEvent): string {
  const { event_id: _eventId, observed_at: _observedAt, provenance, ...rest } = event;
  const { collector_version: _collectorVersion, source_record_fingerprint: _fingerprint, ...stableProvenance } = provenance;
  return JSON.stringify({ ...rest, provenance: stableProvenance });
}

function parseStoredEvent(eventJson: unknown): UsageEvent {
  if (typeof eventJson !== "string") {
    throw new TokenLedgerError("INGEST_CONFLICT", "Stored event JSON is not text");
  }
  try {
    return validateUsageEvent(JSON.parse(eventJson));
  } catch (error) {
    throw new TokenLedgerError("INGEST_CONFLICT", "Stored event JSON no longer validates against the canonical protocol", error);
  }
}

function usageEventRow(event: UsageEvent, eventJson: string, ingestedAt: string): Record<string, string | number | null> {
  return {
    event_id: event.event_id,
    schema_version: event.schema_version,
    request_id: event.request_id ?? null,
    session_id: event.session_id ?? null,
    run_id: event.run_id ?? null,
    task_id: event.task_id ?? null,
    runtime: event.source.runtime,
    runtime_version: event.source.runtime_version ?? null,
    source_type: event.source.source_type,
    source_record_id: event.source.source_record_id ?? null,
    source_platform: event.source.source_platform ?? null,
    observed_at: event.observed_at,
    billing_platform: event.identity.billing_platform,
    inference_provider: event.identity.inference_provider ?? null,
    requested_model: event.identity.requested_model,
    resolved_model: event.identity.resolved_model,
    provider_model_id: event.identity.provider_model_id ?? null,
    service_tier: event.identity.service_tier ?? null,
    region: event.identity.region ?? null,
    billing_mode: event.identity.billing_mode ?? null,
    alias_rule_id: event.identity.alias_rule_id ?? null,
    system_id: event.scope?.system_id ?? null,
    workspace_id: event.scope?.workspace_id ?? null,
    project_id: event.scope?.project_id ?? null,
    agent_id: event.scope?.agent_id ?? null,
    bot_id: event.scope?.bot_id ?? null,
    worker_id: event.scope?.worker_id ?? null,
    skill_id: event.scope?.skill_id ?? null,
    automation_id: event.scope?.automation_id ?? null,
    tool_id: event.scope?.tool_id ?? null,
    context_input_tokens: event.usage.context_input_tokens ?? null,
    input_tokens: event.usage.input_tokens ?? null,
    output_tokens: event.usage.output_tokens ?? null,
    reasoning_tokens: event.usage.reasoning_tokens ?? null,
    cache_read_tokens: event.usage.cache_read_tokens ?? null,
    cache_write_tokens: event.usage.cache_write_tokens ?? null,
    cached_input_tokens: event.usage.cached_input_tokens ?? null,
    audio_input_tokens: event.usage.audio_input_tokens ?? null,
    audio_output_tokens: event.usage.audio_output_tokens ?? null,
    image_input_units: event.usage.image_input_units ?? null,
    image_output_units: event.usage.image_output_units ?? null,
    web_search_units: event.usage.web_search_units ?? null,
    request_units: event.usage.request_units ?? null,
    total_tokens_reported: event.usage.total_tokens_reported ?? null,
    started_at: event.timing.started_at ?? null,
    first_byte_at: event.timing.first_byte_at ?? null,
    first_token_at: event.timing.first_token_at ?? null,
    last_token_at: event.timing.last_token_at ?? null,
    ended_at: event.timing.ended_at ?? null,
    wall_ms: event.timing.wall_ms ?? null,
    ttft_ms: event.timing.ttft_ms ?? null,
    generation_ms: event.timing.generation_ms ?? null,
    queue_ms: event.timing.queue_ms ?? null,
    provider_ms: event.timing.provider_ms ?? null,
    gateway_overhead_ms: event.timing.gateway_overhead_ms ?? null,
    tool_wait_ms: event.timing.tool_wait_ms ?? null,
    network_ms: event.timing.network_ms ?? null,
    actual_charge_amount: event.actual_charge?.amount ?? null,
    actual_charge_currency: event.actual_charge?.currency ?? null,
    actual_charge_source: event.actual_charge?.source ?? null,
    actual_charge_external_id: event.actual_charge?.external_charge_id ?? null,
    actual_charge_reported_at: event.actual_charge?.reported_at ?? null,
    collector_id: event.provenance.collector_id,
    collector_version: event.provenance.collector_version ?? null,
    provenance_source_type: event.provenance.source_type ?? null,
    source_record_fingerprint: event.provenance.source_record_fingerprint,
    usage_quality: event.provenance.usage_quality,
    timing_quality: event.provenance.timing_quality,
    content_stored: 0,
    event_json: eventJson,
    ingested_at: ingestedAt
  };
}

function insertUsageEvent(db: DatabaseSync, event: UsageEvent, eventJson: string, ingestedAt: string): void {
  const row = usageEventRow(event, eventJson, ingestedAt);
  const columns = Object.keys(row);
  const placeholders = columns.map(() => "?").join(", ");
  db.prepare(`INSERT INTO usage_events (${columns.join(", ")}) VALUES (${placeholders})`).run(...Object.values(row));
}

function addCorrelationKeys(
  db: DatabaseSync,
  eventId: string,
  keys: readonly CorrelationKey[],
  createdAt: string
): number {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO event_correlations(event_id, key_kind, key_value, created_at) VALUES (?, ?, ?, ?)"
  );
  let added = 0;
  for (const key of keys) {
    const result = insert.run(eventId, key.kind, key.value, createdAt);
    added += Number(result.changes);
  }
  return added;
}

const STRONG_CORRELATION_KINDS = [
  "request_id",
  "response_id",
  "upstream_request_id",
  "external_charge_id"
] as const;

const USAGE_FIELDS = [
  "context_input_tokens",
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cached_input_tokens",
  "audio_input_tokens",
  "audio_output_tokens",
  "image_input_units",
  "image_output_units",
  "web_search_units",
  "request_units",
  "total_tokens_reported"
] as const;

const SCOPE_FIELDS = [
  "system_id",
  "workspace_id",
  "project_id",
  "agent_id",
  "bot_id",
  "worker_id",
  "skill_id",
  "automation_id",
  "tool_id"
] as const;

const IDENTITY_EXACT_FIELDS = [
  "billing_platform",
  "inference_provider",
  "resolved_model",
  "provider_model_id",
  "service_tier",
  "region",
  "billing_mode"
] as const;

function correlationDigest(parts: readonly string[]): string {
  const digest = createHash("sha256");
  for (const part of parts) digest.update(`${part.length}:${part}|`);
  return digest.digest("hex");
}

function mergeExact<T>(left: T | null | undefined, right: T | null | undefined, label: string): T | null {
  const a = left ?? null;
  const b = right ?? null;
  if (a !== null && b !== null && a !== b) {
    throw new TokenLedgerError("INGEST_CONFLICT", `Strongly correlated observations disagree on ${label}`);
  }
  return a ?? b;
}

function usageRank(event: UsageEvent): number {
  let rank = 0;
  switch (event.provenance.usage_quality) {
    case "provider_reported": rank = 40; break;
    case "runtime_reported": rank = 30; break;
    case "derived_exact": rank = 20; break;
    case "estimated": rank = 10; break;
    default: rank = 0;
  }
  if (event.source.runtime === "opentelemetry") rank -= 1;
  if (event.source.runtime === "ai-verse-token") rank -= 2;
  return rank;
}

function mergeUsage(left: UsageEvent, right: UsageEvent): UsageEvent["usage"] {
  for (const field of USAGE_FIELDS) {
    const a = left.usage[field];
    const b = right.usage[field];
    if (a !== null && a !== undefined && b !== null && b !== undefined && a !== b) {
      throw new TokenLedgerError("INGEST_CONFLICT", `Strongly correlated observations disagree on usage.${field}`);
    }
  }
  const leftTotal = left.usage.total_tokens_reported;
  const rightTotal = right.usage.total_tokens_reported;
  if (leftTotal != null && rightTotal != null && leftTotal !== rightTotal) {
    throw new TokenLedgerError("INGEST_CONFLICT", "Strongly correlated observations disagree on total token usage");
  }
  const preferred = usageRank(right) > usageRank(left) ? right : left;
  const fallback = preferred === left ? right : left;
  if (Object.values(preferred.usage).some((value) => value !== null && value !== undefined)) {
    return preferred.usage;
  }
  return fallback.usage;
}

function mergeScope(left: UsageEvent["scope"], right: UsageEvent["scope"]): UsageEvent["scope"] | undefined {
  const merged: Record<string, string> = {};
  for (const field of SCOPE_FIELDS) {
    const value = mergeExact(left?.[field], right?.[field], `scope.${field}`);
    if (value !== null) merged[field] = value;
  }
  return Object.keys(merged).length === 0 ? undefined : merged;
}

function mergeIdentity(left: UsageEvent, right: UsageEvent): UsageEvent["identity"] {
  const exact: Record<string, string | null> = {};
  for (const field of IDENTITY_EXACT_FIELDS) {
    exact[field] = mergeExact(left.identity[field], right.identity[field], `identity.${field}`);
  }
  return {
    billing_platform: exact.billing_platform ?? null,
    inference_provider: exact.inference_provider ?? null,
    requested_model: left.identity.requested_model ?? right.identity.requested_model ?? null,
    resolved_model: exact.resolved_model ?? null,
    provider_model_id: exact.provider_model_id ?? null,
    service_tier: exact.service_tier ?? null,
    region: exact.region ?? null,
    billing_mode: exact.billing_mode ?? null,
    alias_rule_id: left.identity.alias_rule_id ?? right.identity.alias_rule_id ?? null
  };
}

function timingRank(event: UsageEvent): number {
  switch (event.provenance.timing_quality) {
    case "provider_reported": return 4;
    case "runtime_reported": return 3;
    case "derived_exact": return 2;
    case "estimated": return 1;
    default: return 0;
  }
}

function mergeTiming(left: UsageEvent, right: UsageEvent): UsageEvent["timing"] {
  const preferred = timingRank(right) > timingRank(left) ? right.timing : left.timing;
  const fallback = preferred === left.timing ? right.timing : left.timing;
  const merged = { ...fallback } as Record<string, string | number | null | undefined>;
  for (const [key, value] of Object.entries(preferred)) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  return merged;
}

function mergeActualCharge(left: UsageEvent, right: UsageEvent): UsageEvent["actual_charge"] | undefined {
  const a = left.actual_charge ?? null;
  const b = right.actual_charge ?? null;
  if (a !== null && b !== null && JSON.stringify(a) !== JSON.stringify(b)) {
    throw new TokenLedgerError("INGEST_CONFLICT", "Strongly correlated observations disagree on actual charge");
  }
  return a ?? b ?? undefined;
}

function runtimeRank(event: UsageEvent): number {
  if (event.source.runtime === "ai-verse-token") return 0;
  // A canonical correlation has already selected the best user-facing runtime.
  // Keep that attribution stable when additional provider/gateway observations arrive later.
  if (event.source.source_type === "correlated-call") return 100;
  if (event.provenance.usage_quality === "runtime_reported") return 40;
  if (event.source.runtime === "opentelemetry") return 10;
  if (event.provenance.usage_quality === "provider_reported") return 20;
  return 15;
}

function preferredRuntimeEvent(left: UsageEvent, right: UsageEvent): UsageEvent {
  const leftRank = runtimeRank(left);
  const rightRank = runtimeRank(right);
  if (leftRank !== rightRank) return leftRank > rightRank ? left : right;
  // Stable tie-break so merge order cannot change canonical attribution.
  return left.source.runtime.localeCompare(right.source.runtime) <= 0 ? left : right;
}

function correlatedCanonicalEvent(left: UsageEvent, right: UsageEvent): UsageEvent {
  const constituentIds = [left.event_id, right.event_id].sort();
  const fingerprint = correlationDigest(constituentIds);
  const scope = mergeScope(left.scope, right.scope);
  const actualCharge = mergeActualCharge(left, right);
  const runtimeEvent = preferredRuntimeEvent(left, right);
  const observedAt = Date.parse(left.observed_at) <= Date.parse(right.observed_at)
    ? left.observed_at
    : right.observed_at;
  const requestId = mergeExact(left.request_id, right.request_id, "request_id");
  const sessionId = mergeExact(left.session_id, right.session_id, "session_id");
  const runId = mergeExact(left.run_id, right.run_id, "run_id");
  const taskId = mergeExact(left.task_id, right.task_id, "task_id");

  return validateUsageEvent({
    schema_version: "ai-verse-token/0.1",
    event_id: `evt_correlated_${fingerprint.slice(0, 40)}`,
    ...(requestId === null ? {} : { request_id: requestId }),
    ...(sessionId === null ? {} : { session_id: sessionId }),
    ...(runId === null ? {} : { run_id: runId }),
    ...(taskId === null ? {} : { task_id: taskId }),
    source: {
      runtime: runtimeEvent.source.runtime,
      ...(runtimeEvent.source.runtime_version === undefined ? {} : { runtime_version: runtimeEvent.source.runtime_version }),
      source_type: "correlated-call",
      source_record_id: fingerprint,
      source_platform: left.identity.billing_platform ?? right.identity.billing_platform ?? null
    },
    observed_at: observedAt,
    identity: mergeIdentity(left, right),
    ...(scope === undefined ? {} : { scope }),
    usage: mergeUsage(left, right),
    timing: mergeTiming(left, right),
    ...(actualCharge === undefined ? {} : { actual_charge: actualCharge }),
    provenance: {
      collector_id: "ai-verse-token-correlator",
      collector_version: "0.1.0",
      source_type: "cross-source-exact-correlation",
      source_record_fingerprint: fingerprint,
      usage_quality: "derived_exact",
      timing_quality: "derived_exact",
      content_stored: false
    }
  });
}

function canonicalHead(db: DatabaseSync, eventId: string): string {
  let current = eventId;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(current)) throw new TokenLedgerError("FORMAT_MISMATCH", "Event supersession cycle detected");
    seen.add(current);
    const row = db.prepare("SELECT canonical_event_id FROM event_supersessions WHERE event_id = ?").get(current);
    if (row === undefined) return current;
    const next = asRecord(row, "event supersession").canonical_event_id;
    if (typeof next !== "string") throw new TokenLedgerError("FORMAT_MISMATCH", "Event supersession contains invalid canonical_event_id");
    current = next;
  }
}

function activeStrongCorrelationCandidates(db: DatabaseSync, eventId: string): string[] {
  const placeholders = STRONG_CORRELATION_KINDS.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT DISTINCT peer.event_id AS event_id
    FROM event_correlations mine
    JOIN event_correlations peer
      ON peer.key_kind = mine.key_kind AND peer.key_value = mine.key_value
    JOIN usage_events current ON current.event_id = ?
    JOIN usage_events candidate ON candidate.event_id = peer.event_id
    LEFT JOIN event_supersessions peer_sup ON peer_sup.event_id = peer.event_id
    WHERE mine.event_id = ?
      AND mine.key_kind IN (${placeholders})
      AND peer.event_id <> ?
      AND peer_sup.event_id IS NULL
      AND candidate.collector_id <> current.collector_id
    ORDER BY peer.event_id
  `).all(eventId, eventId, ...STRONG_CORRELATION_KINDS, eventId);
  return rows.map((row) => {
    const value = asRecord(row, "correlation candidate").event_id;
    if (typeof value !== "string") throw new TokenLedgerError("FORMAT_MISMATCH", "Correlation candidate has invalid event_id");
    return value;
  });
}

function readEventById(db: DatabaseSync, eventId: string): UsageEvent {
  const row = db.prepare("SELECT event_json FROM usage_events WHERE event_id = ?").get(eventId);
  if (row === undefined) throw new TokenLedgerError("INGEST_CONFLICT", `Missing correlated event ${eventId}`);
  return parseStoredEvent(asRecord(row, "correlated event").event_json);
}

function correlationsForEvents(db: DatabaseSync, eventIds: readonly string[]): CorrelationKey[] {
  const placeholders = eventIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT DISTINCT key_kind, key_value
    FROM event_correlations
    WHERE event_id IN (${placeholders})
    ORDER BY key_kind, key_value
  `).all(...eventIds);
  return rows.map((row) => {
    const record = asRecord(row, "event correlation");
    if (typeof record.key_kind !== "string" || typeof record.key_value !== "string") {
      throw new TokenLedgerError("FORMAT_MISMATCH", "Event correlation row is invalid");
    }
    return { kind: record.key_kind, value: record.key_value };
  });
}

function markSuperseded(db: DatabaseSync, eventIds: readonly string[], canonicalId: string, now: string): void {
  const insert = db.prepare(`
    INSERT INTO event_supersessions(event_id, canonical_event_id, reason, created_at)
    VALUES (?, ?, 'cross_source_duplicate', ?)
  `);
  for (const eventId of eventIds) {
    if (eventId !== canonicalId) insert.run(eventId, canonicalId, now);
  }
}

function reconcileExactCorrelations(db: DatabaseSync, eventId: string, now: string): string {
  const head = canonicalHead(db, eventId);
  if (head !== eventId) return head;
  let canonicalId = head;

  for (;;) {
    const candidates = activeStrongCorrelationCandidates(db, canonicalId);
    if (candidates.length === 0) return canonicalId;
    const candidateId = candidates[0]!;
    const merged = correlatedCanonicalEvent(readEventById(db, canonicalId), readEventById(db, candidateId));
    const mergedJson = JSON.stringify(merged);
    const existing = db.prepare("SELECT event_json FROM usage_events WHERE event_id = ?").get(merged.event_id);
    if (existing === undefined) {
      insertUsageEvent(db, merged, mergedJson, now);
    } else if (asRecord(existing, "correlated canonical event").event_json !== mergedJson) {
      throw new TokenLedgerError("INGEST_CONFLICT", `Canonical correlation event ${merged.event_id} conflicts with stored data`);
    }
    addCorrelationKeys(db, merged.event_id, correlationsForEvents(db, [canonicalId, candidateId]), now);
    markSuperseded(db, [canonicalId, candidateId], merged.event_id, now);
    canonicalId = merged.event_id;
  }
}

function writeCheckpoint(
  db: DatabaseSync,
  collectorId: string,
  checkpoint: { readonly key: string; readonly cursor: string },
  updatedAt: string
): void {
  db.prepare(`
    INSERT INTO collector_checkpoints(collector_id, checkpoint_key, cursor, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(collector_id, checkpoint_key)
    DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at
  `).run(collectorId, checkpoint.key, checkpoint.cursor, updatedAt);
}

export class TokenLedger {
  readonly path: string;
  readonly readOnly: boolean;
  #db: DatabaseSync;
  #closed = false;

  constructor(path: string, readOnly: boolean, db: DatabaseSync) {
    this.path = path;
    this.readOnly = readOnly;
    this.#db = db;
  }

  get closed(): boolean {
    return this.#closed;
  }

  #assertOpen(): void {
    if (this.#closed || !this.#db.isOpen) {
      throw new TokenLedgerError("CLOSED", "Token ledger is closed");
    }
  }

  metadata(): TokenLedgerMetadata {
    this.#assertOpen();
    return verifyLedgerIdentity(this.#db);
  }

  integrityCheck(mode: IntegrityCheckMode = "quick"): TokenLedgerIntegrityResult {
    this.#assertOpen();
    return runIntegrityCheck(this.#db, mode);
  }

  diagnostics(): TokenLedgerDiagnostics {
    this.#assertOpen();
    return {
      path: this.path,
      readOnly: this.readOnly,
      journalMode: pragmaText(this.#db, "journal_mode").toLowerCase(),
      foreignKeys: pragmaNumber(this.#db, "foreign_keys") === 1,
      applicationId: pragmaNumber(this.#db, "application_id"),
      userVersion: pragmaNumber(this.#db, "user_version"),
      metadata: verifyLedgerIdentity(this.#db)
    };
  }

  ingestUsageEvent(value: unknown, options: IngestUsageEventOptions = {}): IngestUsageEventResult {
    this.#assertOpen();
    if (this.readOnly) {
      throw new TokenLedgerError("READ_ONLY", "Cannot ingest into a read-only Token ledger");
    }

    const event = validateUsageEvent(value);
    const eventJson = JSON.stringify(event);
    const correlations = normalizeCorrelationKeys(event, options.correlationKeys);
    const checkpoint = normalizeCheckpoint(options.checkpoint);
    const now = new Date().toISOString();

    this.#db.exec("BEGIN IMMEDIATE;");
    try {
      const byIdRaw = this.#db.prepare("SELECT event_id, event_json FROM usage_events WHERE event_id = ?").get(event.event_id);
      const byFingerprintRaw = this.#db
        .prepare("SELECT event_id, event_json FROM usage_events WHERE collector_id = ? AND source_record_fingerprint = ?")
        .get(event.provenance.collector_id, event.provenance.source_record_fingerprint);

      const byId = byIdRaw === undefined ? null : asRecord(byIdRaw, "event-id lookup");
      const byFingerprint = byFingerprintRaw === undefined ? null : asRecord(byFingerprintRaw, "fingerprint lookup");
      let status: "inserted" | "duplicate" = "inserted";
      let targetEventId = event.event_id;
      let duplicateOf: string | null = null;

      if (byId !== null) {
        if (byId.event_json !== eventJson) {
          throw new TokenLedgerError("INGEST_CONFLICT", `event_id ${event.event_id} already exists with different canonical data`);
        }
        if (byFingerprint !== null && byFingerprint.event_id !== event.event_id) {
          throw new TokenLedgerError(
            "INGEST_CONFLICT",
            `event_id ${event.event_id} and its source fingerprint resolve to different stored events`
          );
        }
        status = "duplicate";
        duplicateOf = event.event_id;
      } else if (byFingerprint !== null) {
        if (typeof byFingerprint.event_id !== "string") {
          throw new TokenLedgerError("INGEST_CONFLICT", "Fingerprint lookup returned an invalid event_id");
        }
        const stored = parseStoredEvent(byFingerprint.event_json);
        if (semanticSourceFacts(stored) !== semanticSourceFacts(event)) {
          throw new TokenLedgerError(
            "INGEST_CONFLICT",
            `collector ${event.provenance.collector_id} reused a source fingerprint for different source facts`
          );
        }
        status = "duplicate";
        targetEventId = byFingerprint.event_id;
        duplicateOf = byFingerprint.event_id;
      } else {
        insertUsageEvent(this.#db, event, eventJson, now);
      }

      const correlationKeysAdded = addCorrelationKeys(this.#db, targetEventId, correlations, now);
      reconcileExactCorrelations(this.#db, targetEventId, now);
      if (checkpoint !== null) {
        writeCheckpoint(this.#db, event.provenance.collector_id, checkpoint, now);
      }
      this.#db.exec("COMMIT;");
      return {
        status,
        eventId: targetEventId,
        duplicateOf,
        correlationKeysAdded,
        checkpointUpdated: checkpoint !== null
      };
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK;");
      } catch {
        // Preserve the ingest failure.
      }
      if (error instanceof TokenLedgerError) throw error;
      throw new TokenLedgerError("INGEST_CONFLICT", `Failed to ingest usage event ${event.event_id}`, error);
    }
  }

  queryUsage(request: UsageQueryRequest = {}): UsageQueryResult {
    this.#assertOpen();
    return executeUsageQuery(this.#db, request);
  }

  aggregateUsage(request: UsageAggregateRequest): UsageAggregateResult {
    this.#assertOpen();
    return executeUsageAggregate(this.#db, request);
  }

  collectorCheckpoint(collectorId: string, key = "default"): CollectorCheckpointState | null {
    this.#assertOpen();
    const safeCollectorId = ingestString(collectorId, "collector id", 200);
    const safeKey = ingestString(key, "checkpoint key", 200);
    const row = this.#db
      .prepare("SELECT collector_id, checkpoint_key, cursor, updated_at FROM collector_checkpoints WHERE collector_id = ? AND checkpoint_key = ?")
      .get(safeCollectorId, safeKey);
    if (row === undefined) return null;
    const record = asRecord(row, "collector checkpoint");
    if (
      typeof record.collector_id !== "string" ||
      typeof record.checkpoint_key !== "string" ||
      typeof record.cursor !== "string" ||
      typeof record.updated_at !== "string"
    ) {
      throw new TokenLedgerError("FORMAT_MISMATCH", "Collector checkpoint contains invalid values");
    }
    return {
      collectorId: record.collector_id,
      key: record.checkpoint_key,
      cursor: record.cursor,
      updatedAt: record.updated_at
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }
}

function validatePath(path: string): void {
  if (path.length === 0 || path.includes("\u0000") || path === ":memory:" || path.startsWith("file:")) {
    throw new TokenLedgerError("PATH_INVALID", "Ledger path must be a non-empty filesystem path without NUL or SQLite URI modes");
  }
}

function canonicalLedgerPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) {
    throw new TokenLedgerError("PATH_INVALID", "Ledger file must not be a symbolic link");
  }
  const parent = dirname(absolute);
  const canonicalParent = existsSync(parent) ? realpathSync(parent) : parent;
  return join(canonicalParent, basename(absolute));
}

export function openTokenLedger(options: TokenLedgerOpenOptions): TokenLedger {
  validatePath(options.path);
  const ledgerPath = canonicalLedgerPath(options.path);
  const mode = options.mode ?? "create-or-open";
  const existedBefore = existsSync(ledgerPath);

  if ((mode === "open-existing" || mode === "read-only") && !existedBefore) {
    throw new TokenLedgerError("NOT_FOUND", `Token ledger does not exist: ${ledgerPath}`);
  }

  const readOnly = mode === "read-only";
  let db: DatabaseSync | undefined;

  try {
    db = new DatabaseSync(ledgerPath, {
      readOnly,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      timeout: TOKEN_LEDGER_BUSY_TIMEOUT_MS
    });
    configureConnection(db, readOnly);

    if (!existedBefore) {
      if (readOnly) {
        throw new TokenLedgerError("NOT_FOUND", `Token ledger does not exist: ${ledgerPath}`);
      }
      initializeNewLedger(db);
    }

    const metadata = verifyLedgerIdentity(db);
    void metadata;
    const integrity = runIntegrityCheck(db, "quick");
    if (!integrity.ok) {
      throw new TokenLedgerError("INTEGRITY_FAILED", `SQLite quick_check failed: ${integrity.details.join("; ")}`);
    }

    return new TokenLedger(ledgerPath, readOnly, db);
  } catch (error) {
    if (db?.isOpen) {
      try {
        db.close();
      } catch {
        // Preserve the original error.
      }
    }
    if (error instanceof TokenLedgerError) throw error;
    throw new TokenLedgerError("OPEN_FAILED", `Failed to open Token ledger at ${ledgerPath}`, error);
  }
}
