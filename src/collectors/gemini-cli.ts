import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
  type LocalFileSource
} from "./local-common.js";

export interface GeminiCliDiscoveryOptions {
  readonly gemini_home: string;
}

interface GeminiCursor {
  readonly index: number;
  readonly id: string;
}

const ID = "gemini-cli-local";
const VERSION = "0.1.0";
const MAX_SESSION_BYTES = 128 * 1024 * 1024;

function decodeCursor(value: string | null): GeminiCursor | null {
  if (value === null) return null;
  try {
    const row = asRecord(JSON.parse(value));
    if (row === null || !Number.isSafeInteger(row.index) || (row.index as number) < 0 || typeof row.id !== "string" || row.id.length < 1) {
      throw new Error("invalid cursor");
    }
    return Object.freeze({ index: row.index as number, id: row.id });
  } catch (error) {
    throw new LocalCollectorError("GEMINI_CHECKPOINT_INVALID", "Gemini CLI checkpoint is invalid", { cause: error });
  }
}

function encodeCursor(index: number, id: string): string {
  return JSON.stringify({ index, id });
}

function load(path: string): Record<string, unknown> {
  const size = statSync(path).size;
  if (size > MAX_SESSION_BYTES) {
    throw new LocalCollectorError("GEMINI_SESSION_TOO_LARGE", `Gemini CLI session exceeds ${MAX_SESSION_BYTES} bytes`);
  }
  try {
    const record = asRecord(JSON.parse(readFileSync(path, "utf8")));
    if (record === null) throw new Error("object required");
    return record;
  } catch (error) {
    if (error instanceof LocalCollectorError) throw error;
    throw new LocalCollectorError("GEMINI_SESSION_INVALID", "Gemini CLI session JSON is invalid", { cause: error });
  }
}

function usage(tokens: Record<string, unknown>): UsageCounts {
  const input = nonNegativeInt(tokens.input, "Gemini tokens.input");
  const output = nonNegativeInt(tokens.output, "Gemini tokens.output");
  const cached = nonNegativeInt(tokens.cached, "Gemini tokens.cached");
  const thoughts = nonNegativeInt(tokens.thoughts, "Gemini tokens.thoughts");
  const total = nonNegativeInt(tokens.total, "Gemini tokens.total");
  return {
    ...(input === null ? {} : { input_tokens: input }),
    ...(output === null ? {} : { output_tokens: output }),
    ...(cached === null ? {} : { cached_input_tokens: cached }),
    ...(thoughts === null ? {} : { reasoning_tokens: thoughts }),
    ...(total === null ? {} : { total_tokens_reported: total })
  };
}

function detect(sourceValue: LocalFileSource): CollectorDetection {
  const source = normalizeSource(sourceValue);
  const status = regularFileStatus(source.path);
  if (status === "missing") return Object.freeze({ status: "unavailable", code: "GEMINI_SESSION_NOT_FOUND" });
  if (status === "unsafe") return Object.freeze({ status: "unavailable", code: "GEMINI_SESSION_UNSAFE" });
  try {
    const doc = load(source.path);
    return Array.isArray(doc.messages)
      ? Object.freeze({ status: "available", code: "GEMINI_SESSION_READY" })
      : Object.freeze({ status: "unavailable", code: "GEMINI_SCHEMA_UNSUPPORTED" });
  } catch {
    return Object.freeze({ status: "unavailable", code: "GEMINI_SESSION_INVALID" });
  }
}

function collect(request: CollectorScanRequest<LocalFileSource>): CollectorScanResult {
  const source = normalizeSource(request.source);
  const document = load(source.path);
  const messages = document.messages;
  if (!Array.isArray(messages)) throw new LocalCollectorError("GEMINI_SCHEMA_UNSUPPORTED", "Gemini CLI session has no messages array");
  const sessionId = optionalText(document.sessionId ?? document.session_id, 500);
  const checkpoint = decodeCursor(request.checkpoint_cursor);
  if (checkpoint !== null) {
    if (checkpoint.index >= messages.length) {
      throw new LocalCollectorError("GEMINI_SOURCE_REWOUND", "Gemini CLI session is shorter than the saved checkpoint");
    }
    const previous = asRecord(messages[checkpoint.index]);
    const previousId = previous === null ? null : optionalText(previous.id, 500);
    if (previousId !== checkpoint.id) {
      throw new LocalCollectorError("GEMINI_SOURCE_CHANGED", "Gemini CLI message identity changed at the saved checkpoint");
    }
  }

  const emissions = [];
  let remaining = false;
  const start = checkpoint === null ? 0 : checkpoint.index + 1;
  for (let index = start; index < messages.length; index += 1) {
    const message = asRecord(messages[index]);
    if (message === null || message.type !== "gemini") continue;
    const tokens = asRecord(message.tokens);
    if (tokens === null) continue;
    if (emissions.length >= request.max_events) {
      remaining = true;
      break;
    }
    const id = optionalText(message.id, 500) ?? `message:${index}`;
    const observed = isoTime(message.timestamp, "Gemini message timestamp");
    if (observed === null) throw new LocalCollectorError("GEMINI_TIMESTAMP_MISSING", "Gemini usage message has no timestamp");
    const model = optionalText(message.model, 500);
    const event = buildLocalEvent({
      collectorId: ID,
      collectorVersion: VERSION,
      runtime: "gemini-cli",
      sourceType: "gemini-cli.session-json",
      sourceId: source.source_id,
      sourceRecordKey: id,
      eventDiscriminator: `message:${index}:${id}`,
      observedAt: observed,
      requestId: id,
      sessionId,
      sourcePlatform: "google",
      identity: {
        billing_platform: "google",
        inference_provider: "google",
        requested_model: model,
        resolved_model: null
      },
      usage: usage(tokens),
      timing: {},
      timingQuality: "unknown"
    });
    emissions.push(Object.freeze({
      event,
      checkpoint_cursor: encodeCursor(index, id),
      correlation_keys: correlations([
        { kind: "gemini_message", value: id },
        sessionId === null ? null : { kind: "gemini_session", value: sessionId }
      ])
    }));
  }
  return Object.freeze({ emissions: Object.freeze(emissions), complete: !remaining });
}

export function discoverGeminiCliSources(options: GeminiCliDiscoveryOptions): readonly LocalFileSource[] {
  return discoverFiles(join(options.gemini_home, "tmp"), (path, name) => path.includes(`${join("chats", "").replace(/\\/g, "/")}`) && /^session-.*\.json$/i.test(name), "gemini");
}

export const GEMINI_CLI_COLLECTOR: TokenCollector<LocalFileSource> = Object.freeze({
  definition: Object.freeze({ id: ID, version: VERSION, runtimes: Object.freeze(["gemini-cli"]) }),
  detect,
  collect
});
