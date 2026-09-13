import { DatabaseSync } from "node:sqlite";
import type { UsageCounts } from "../protocol/types.js";
import type { CollectorDetection, CollectorScanRequest, CollectorScanResult, TokenCollector } from "./types.js";
import {
  LocalCollectorError,
  asRecord,
  buildLocalEvent,
  correlations,
  discoverFiles,
  isoTime,
  nonNegativeInt,
  normalizeSource,
  optionalText,
  regularFileStatus,
  type LocalDbSource
} from "./local-common.js";

export interface OpenCodeDiscoveryOptions {
  readonly data_dir: string;
}

interface OpenCodeCursor {
  readonly time: number;
  readonly id: string;
}

const ID = "opencode-local";
const VERSION = "0.1.0";
const REQUIRED_COLUMNS = Object.freeze(["id", "session_id", "time_created", "data"]);

type SqlRow = Record<string, unknown>;

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
    throw new LocalCollectorError("OPENCODE_DB_OPEN_FAILED", `failed to open OpenCode database read-only: ${path}`, { cause: error });
  }
}

function columns(db: DatabaseSync): Set<string> {
  try {
    return new Set(db.prepare("PRAGMA table_info(message)").all().map((value) => {
      const row = value as SqlRow;
      return typeof row.name === "string" ? row.name : "";
    }).filter(Boolean));
  } catch {
    return new Set();
  }
}

function schemaReady(db: DatabaseSync): boolean {
  const found = columns(db);
  return REQUIRED_COLUMNS.every((name) => found.has(name));
}

function decodeCursor(value: string | null): OpenCodeCursor | null {
  if (value === null) return null;
  try {
    const row = asRecord(JSON.parse(value));
    if (row === null || !Number.isFinite(row.time) || typeof row.id !== "string" || row.id.length < 1 || row.id.includes("\u0000")) {
      throw new Error("invalid cursor");
    }
    return Object.freeze({ time: Number(row.time), id: row.id });
  } catch (error) {
    throw new LocalCollectorError("OPENCODE_CHECKPOINT_INVALID", "OpenCode checkpoint is invalid", { cause: error });
  }
}

function encodeCursor(time: number, id: string): string {
  return JSON.stringify({ time, id });
}

function dataObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch (error) {
    throw new LocalCollectorError("OPENCODE_MESSAGE_INVALID", "OpenCode message.data is invalid JSON", { cause: error });
  }
}

function parseUsage(tokens: Record<string, unknown>): UsageCounts {
  const cache = asRecord(tokens.cache);
  const total = nonNegativeInt(tokens.total, "OpenCode tokens.total");
  const input = nonNegativeInt(tokens.input, "OpenCode tokens.input");
  const output = nonNegativeInt(tokens.output, "OpenCode tokens.output");
  const reasoning = nonNegativeInt(tokens.reasoning, "OpenCode tokens.reasoning");
  const cacheRead = cache === null ? null : nonNegativeInt(cache.read, "OpenCode tokens.cache.read");
  const cacheWrite = cache === null ? null : nonNegativeInt(cache.write, "OpenCode tokens.cache.write");
  return {
    ...(input === null ? {} : { input_tokens: input }),
    ...(output === null ? {} : { output_tokens: output }),
    ...(reasoning === null ? {} : { reasoning_tokens: reasoning }),
    ...(cacheRead === null ? {} : { cache_read_tokens: cacheRead }),
    ...(cacheWrite === null ? {} : { cache_write_tokens: cacheWrite }),
    ...(total === null ? {} : { total_tokens_reported: total })
  };
}

function detect(sourceValue: LocalDbSource): CollectorDetection {
  const source = normalizeSource(sourceValue);
  const status = regularFileStatus(source.path);
  if (status === "missing") return Object.freeze({ status: "unavailable", code: "OPENCODE_DB_NOT_FOUND" });
  if (status === "unsafe") return Object.freeze({ status: "unavailable", code: "OPENCODE_DB_UNSAFE" });
  let db: DatabaseSync | undefined;
  try {
    db = openReadOnly(source.path);
    return schemaReady(db)
      ? Object.freeze({ status: "available", code: "OPENCODE_DB_READY" })
      : Object.freeze({ status: "unavailable", code: "OPENCODE_SCHEMA_UNSUPPORTED" });
  } catch {
    return Object.freeze({ status: "unavailable", code: "OPENCODE_DB_OPEN_FAILED" });
  } finally {
    if (db?.isOpen) db.close();
  }
}

function collect(request: CollectorScanRequest<LocalDbSource>): CollectorScanResult {
  const source = normalizeSource(request.source);
  const checkpoint = decodeCursor(request.checkpoint_cursor);
  let db: DatabaseSync | undefined;
  try {
    db = openReadOnly(source.path);
    if (!schemaReady(db)) throw new LocalCollectorError("OPENCODE_SCHEMA_UNSUPPORTED", "OpenCode message schema is unsupported");
    const rows = db.prepare(`
      SELECT id, session_id, time_created, data
      FROM message
      WHERE (? IS NULL OR time_created > ? OR (time_created = ? AND id > ?))
        AND (
          json_valid(data) = 0
          OR (json_extract(data, '$.role') = 'assistant' AND json_type(data, '$.tokens') IS NOT NULL)
        )
      ORDER BY time_created ASC, id ASC
      LIMIT ?
    `).all(
      checkpoint === null ? null : checkpoint.time,
      checkpoint === null ? null : checkpoint.time,
      checkpoint === null ? null : checkpoint.time,
      checkpoint === null ? null : checkpoint.id,
      request.max_events + 1
    );

    const emissions = [];
    const remainingAssistantRows = rows.length > request.max_events;
    for (const raw of rows.slice(0, request.max_events)) {
      const row = raw as SqlRow;
      const id = optionalText(row.id, 500);
      const sessionId = optionalText(row.session_id, 500);
      const time = Number(row.time_created);
      if (id === null || sessionId === null || !Number.isFinite(time) || time < 0) {
        throw new LocalCollectorError("OPENCODE_MESSAGE_INVALID", "OpenCode message row has invalid identity/time fields");
      }
      const data = dataObject(row.data);
      if (data?.role !== "assistant") continue;
      const tokens = asRecord(data.tokens);
      if (tokens === null) continue;
      const observed = isoTime(time, "OpenCode time_created");
      if (observed === null) throw new LocalCollectorError("OPENCODE_MESSAGE_INVALID", "OpenCode message timestamp is missing");
      const provider = optionalText(data.providerID ?? data.providerId ?? data.provider, 200);
      const model = optionalText(data.modelID ?? data.modelId ?? data.model, 500);
      const usage = parseUsage(tokens);
      const event = buildLocalEvent({
        collectorId: ID,
        collectorVersion: VERSION,
        runtime: "opencode",
        sourceType: "opencode.message-db",
        sourceId: source.source_id,
        sourceRecordKey: id,
        eventDiscriminator: id,
        observedAt: observed,
        requestId: id,
        sessionId,
        sourcePlatform: provider,
        identity: {
          billing_platform: provider,
          inference_provider: provider,
          requested_model: model,
          resolved_model: null
        },
        usage,
        timing: {},
        timingQuality: "unknown"
      });
      emissions.push(Object.freeze({
        event,
        checkpoint_cursor: encodeCursor(time, id),
        correlation_keys: correlations([
          { kind: "opencode_message", value: id },
          { kind: "opencode_session", value: sessionId }
        ])
      }));
    }
    return Object.freeze({ emissions: Object.freeze(emissions), complete: !remainingAssistantRows });
  } finally {
    if (db?.isOpen) db.close();
  }
}

export function discoverOpenCodeSources(options: OpenCodeDiscoveryOptions): readonly LocalDbSource[] {
  return discoverFiles(options.data_dir, (_path, name) => /^opencode(?:[^/]*)\.db$/i.test(name), "opencode");
}

export const OPENCODE_COLLECTOR: TokenCollector<LocalDbSource> = Object.freeze({
  definition: Object.freeze({ id: ID, version: VERSION, runtimes: Object.freeze(["opencode"]) }),
  detect,
  collect
});
