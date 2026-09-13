import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  statSync
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { validateUsageEvent } from "../protocol/validation.js";
import type { UsageCounts, UsageEvent, UsageIdentity, UsageTiming } from "../protocol/types.js";
import type { CorrelationKey } from "../storage/index.js";
import type { CollectorEmission, CollectorScanResult } from "./types.js";

export interface LocalFileSource {
  readonly path: string;
  readonly source_id: string;
}

export interface LocalDbSource extends LocalFileSource {}

export interface LocalDiscoveryRoot {
  readonly root: string;
}

export class LocalCollectorError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalCollectorError";
    this.code = code;
  }
}

export interface LocalEventArgs {
  readonly collectorId: string;
  readonly collectorVersion: string;
  readonly runtime: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly sourceRecordKey: string;
  readonly eventDiscriminator: string;
  readonly observedAt: string;
  readonly requestId?: string | null;
  readonly sessionId?: string | null;
  readonly runId?: string | null;
  readonly taskId?: string | null;
  readonly sourcePlatform?: string | null;
  readonly identity: UsageIdentity;
  readonly usage: UsageCounts;
  readonly timing?: UsageTiming;
  readonly usageQuality?: UsageEvent["provenance"]["usage_quality"];
  readonly timingQuality?: UsageEvent["provenance"]["timing_quality"];
}

export interface ParsedLocalEmission {
  readonly event: UsageEvent;
  readonly correlation_keys?: readonly CorrelationKey[];
}

interface JsonlCursor {
  readonly offset: number;
  readonly line: number;
  readonly sub: number;
  readonly state?: unknown;
}

export interface JsonlParseContext {
  readonly line: number;
  readonly line_start: number;
  readonly line_end: number;
}

export interface JsonlParser<TState> {
  initialState(): TState;
  restoreState(value: unknown): TState;
  snapshotState(value: TState): unknown;
  parse(record: Record<string, unknown>, context: JsonlParseContext, state: TState): readonly ParsedLocalEmission[];
}

const MAX_SOURCE_ID = 200;
const MAX_PATH = 4096;
const MAX_JSONL_LINE_BYTES = 8 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_DISCOVERY_FILES = 100_000;
const MAX_DISCOVERY_DEPTH = 12;

export function hashParts(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(part.length));
    hash.update(":");
    hash.update(part);
    hash.update("|");
  }
  return hash.digest("hex");
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function optionalText(value: unknown, max = 500): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > max || value.includes("\u0000")) {
    throw new LocalCollectorError("LOCAL_RECORD_INVALID", `expected text up to ${max} characters without NUL`);
  }
  return value;
}

export function nonNegativeInt(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new LocalCollectorError("LOCAL_RECORD_INVALID", `${label} must be a non-negative safe integer`);
  }
  return value as number;
}

export function isoTime(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new LocalCollectorError("LOCAL_RECORD_INVALID", `${label} must be a valid timestamp`);
    }
    const milliseconds = value < 100_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    if (Number.isNaN(date.getTime())) throw new LocalCollectorError("LOCAL_RECORD_INVALID", `${label} is invalid`);
    return date.toISOString();
  }
  if (typeof value !== "string" || value.length > 100 || value.includes("\u0000")) {
    throw new LocalCollectorError("LOCAL_RECORD_INVALID", `${label} must be an ISO timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new LocalCollectorError("LOCAL_RECORD_INVALID", `${label} is invalid`);
  return new Date(milliseconds).toISOString();
}

export function normalizeSource(value: LocalFileSource): LocalFileSource {
  const path = optionalText(value.path, MAX_PATH);
  const sourceId = optionalText(value.source_id, MAX_SOURCE_ID);
  if (path === null || sourceId === null) {
    throw new LocalCollectorError("LOCAL_SOURCE_INVALID", "source path and source_id are required");
  }
  return Object.freeze({ path, source_id: sourceId });
}

export function regularFileStatus(path: string): "ready" | "missing" | "unsafe" {
  if (!existsSync(path)) return "missing";
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isFile()) return "unsafe";
    return "ready";
  } catch {
    return "unsafe";
  }
}

export function stableSourceId(prefix: string, root: string, path: string): string {
  const rel = relative(resolve(root), resolve(path)).split(sep).join("/");
  return `${prefix}:${hashParts([rel]).slice(0, 24)}`;
}

export function discoverFiles(
  rootValue: string,
  predicate: (path: string, name: string) => boolean,
  prefix: string
): readonly LocalFileSource[] {
  const root = resolve(rootValue);
  if (!existsSync(root)) return Object.freeze([]);
  try {
    const rootInfo = lstatSync(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return Object.freeze([]);
  } catch {
    return Object.freeze([]);
  }
  const out: LocalFileSource[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > MAX_DISCOVERY_DEPTH || out.length >= MAX_DISCOVERY_FILES) return;
    let names: string[];
    try {
      names = readdirSync(directory).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (out.length >= MAX_DISCOVERY_FILES) break;
      const path = join(directory, name);
      let entry;
      try {
        entry = lstatSync(path);
      } catch {
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile() && predicate(path, name)) {
        out.push(Object.freeze({ path, source_id: stableSourceId(prefix, root, path) }));
      }
    }
  };
  visit(root, 0);
  return Object.freeze(out);
}

export function buildLocalEvent(args: LocalEventArgs): UsageEvent {
  const recordHash = hashParts([args.runtime, args.sourceId, args.sourceRecordKey]);
  const eventHash = hashParts([args.runtime, args.sourceId, args.eventDiscriminator]);
  const timing = args.timing ?? { started_at: args.observedAt };
  return validateUsageEvent({
    schema_version: "ai-verse-token/0.1",
    event_id: `evt_${args.runtime.replace(/[^a-z0-9]+/gi, "_")}_${eventHash.slice(0, 40)}`,
    ...(args.requestId === undefined ? {} : { request_id: args.requestId }),
    ...(args.sessionId === undefined ? {} : { session_id: args.sessionId }),
    ...(args.runId === undefined ? {} : { run_id: args.runId }),
    ...(args.taskId === undefined ? {} : { task_id: args.taskId }),
    source: {
      runtime: args.runtime,
      source_type: args.sourceType,
      source_record_id: `${args.runtime}:${recordHash.slice(0, 32)}`,
      ...(args.sourcePlatform === undefined || args.sourcePlatform === null ? {} : { source_platform: args.sourcePlatform })
    },
    observed_at: args.observedAt,
    identity: args.identity,
    usage: args.usage,
    timing,
    provenance: {
      collector_id: args.collectorId,
      collector_version: args.collectorVersion,
      source_type: args.sourceType,
      source_record_fingerprint: recordHash,
      usage_quality: args.usageQuality ?? "runtime_reported",
      timing_quality: args.timingQuality ?? "runtime_reported",
      content_stored: false
    }
  });
}

export function correlations(items: readonly (CorrelationKey | null | undefined)[]): readonly CorrelationKey[] {
  return Object.freeze(items.filter((item): item is CorrelationKey => item !== null && item !== undefined));
}

function decodeCursor<TState>(value: string | null, parser: JsonlParser<TState>): JsonlCursor & { state: TState } {
  if (value === null) return { offset: 0, line: 0, sub: 0, state: parser.initialState() };
  try {
    const parsed = JSON.parse(value) as unknown;
    const row = asRecord(parsed);
    if (row === null) throw new Error("object required");
    const offset = row.offset;
    const line = row.line;
    const sub = row.sub;
    if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new Error("offset invalid");
    if (!Number.isSafeInteger(line) || (line as number) < 0) throw new Error("line invalid");
    if (!Number.isSafeInteger(sub) || (sub as number) < 0) throw new Error("sub invalid");
    return {
      offset: offset as number,
      line: line as number,
      sub: sub as number,
      state: parser.restoreState(row.state)
    };
  } catch (error) {
    if (error instanceof LocalCollectorError) throw error;
    throw new LocalCollectorError("LOCAL_CHECKPOINT_INVALID", "local JSONL checkpoint is invalid", { cause: error });
  }
}

function encodeCursor<TState>(offset: number, line: number, sub: number, state: TState, parser: JsonlParser<TState>): string {
  return JSON.stringify({ offset, line, sub, state: parser.snapshotState(state) });
}

function parseJsonLine(buffer: Buffer, line: number): Record<string, unknown> {
  if (buffer.byteLength > MAX_JSONL_LINE_BYTES) {
    throw new LocalCollectorError("LOCAL_LINE_TOO_LARGE", `JSONL line ${line + 1} exceeds ${MAX_JSONL_LINE_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw new LocalCollectorError("LOCAL_JSON_INVALID", `JSONL line ${line + 1} is not valid JSON`, { cause: error });
  }
  const record = asRecord(parsed);
  if (record === null) throw new LocalCollectorError("LOCAL_JSON_INVALID", `JSONL line ${line + 1} must be an object`);
  return record;
}

export function scanJsonl<TState>(args: {
  readonly source: LocalFileSource;
  readonly checkpoint: string | null;
  readonly maxEvents: number;
  readonly parser: JsonlParser<TState>;
}): CollectorScanResult {
  const source = normalizeSource(args.source);
  if (regularFileStatus(source.path) !== "ready") {
    throw new LocalCollectorError("LOCAL_SOURCE_UNAVAILABLE", `source is missing or unsafe: ${source.path}`);
  }
  const cursor = decodeCursor(args.checkpoint, args.parser);
  const size = statSync(source.path).size;
  if (cursor.offset > size) {
    throw new LocalCollectorError("LOCAL_SOURCE_REWOUND", "source is shorter than the saved checkpoint");
  }

  const fd = openSync(source.path, "r");
  const emissions: CollectorEmission[] = [];
  let state = cursor.state;
  let position = cursor.offset;
  let lineNumber = cursor.line;
  let pending = Buffer.alloc(0);
  let pendingStart = position;
  let firstLineSub = cursor.sub;
  let reachedEof = false;

  try {
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    while (emissions.length < args.maxEvents) {
      const bytes = readSync(fd, chunk, 0, chunk.byteLength, position);
      if (bytes === 0) {
        reachedEof = true;
        break;
      }
      const slice = chunk.subarray(0, bytes);
      position += bytes;
      pending = pending.byteLength === 0 ? Buffer.from(slice) : Buffer.concat([pending, slice]);
      if (pending.byteLength > MAX_JSONL_LINE_BYTES && pending.indexOf(0x0a) === -1) {
        throw new LocalCollectorError("LOCAL_LINE_TOO_LARGE", `JSONL line ${lineNumber + 1} exceeds ${MAX_JSONL_LINE_BYTES} bytes`);
      }

      let newline = pending.indexOf(0x0a);
      while (newline !== -1 && emissions.length < args.maxEvents) {
        let lineBuffer = pending.subarray(0, newline);
        if (lineBuffer.byteLength > 0 && lineBuffer[lineBuffer.byteLength - 1] === 0x0d) {
          lineBuffer = lineBuffer.subarray(0, lineBuffer.byteLength - 1);
        }
        const lineEnd = pendingStart + newline + 1;
        if (lineBuffer.byteLength > 0) {
          const record = parseJsonLine(lineBuffer, lineNumber);
          const parsed = args.parser.parse(record, {
            line: lineNumber,
            line_start: pendingStart,
            line_end: lineEnd
          }, state);
          const skip = firstLineSub;
          if (skip > parsed.length) {
            throw new LocalCollectorError("LOCAL_CHECKPOINT_INVALID", "checkpoint sub-index exceeds source record emissions");
          }
          for (let index = skip; index < parsed.length && emissions.length < args.maxEvents; index += 1) {
            const item = parsed[index] as ParsedLocalEmission;
            const isLastFromLine = index === parsed.length - 1;
            const checkpoint = isLastFromLine
              ? encodeCursor(lineEnd, lineNumber + 1, 0, state, args.parser)
              : encodeCursor(pendingStart, lineNumber, index + 1, state, args.parser);
            emissions.push(Object.freeze({
              event: item.event,
              checkpoint_cursor: checkpoint,
              ...(item.correlation_keys === undefined ? {} : { correlation_keys: item.correlation_keys })
            }));
          }
          if (skip === parsed.length) firstLineSub = 0;
        }
        firstLineSub = 0;
        pending = pending.subarray(newline + 1);
        pendingStart = lineEnd;
        lineNumber += 1;
        newline = pending.indexOf(0x0a);
      }

      if (emissions.length >= args.maxEvents) break;
    }
  } finally {
    closeSync(fd);
  }

  // A non-newline-terminated tail is treated as an in-progress writer record and retried later.
  const complete = reachedEof && pending.byteLength === 0;
  return Object.freeze({ emissions: Object.freeze(emissions), complete });
}

export function filenameSessionId(path: string): string {
  return basename(path).replace(/\.jsonl$/i, "").replace(/\.json$/i, "");
}
