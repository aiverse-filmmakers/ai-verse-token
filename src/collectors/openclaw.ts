import { join } from "node:path";
import type { UsageCounts } from "../protocol/types.js";
import type { CollectorDetection, CollectorScanRequest, CollectorScanResult, TokenCollector } from "./types.js";
import {
  LocalCollectorError,
  asRecord,
  buildLocalEvent,
  correlations,
  discoverFiles,
  filenameSessionId,
  isoTime,
  nonNegativeInt,
  normalizeSource,
  optionalText,
  regularFileStatus,
  scanJsonl,
  type JsonlParser,
  type LocalFileSource,
  type ParsedLocalEmission
} from "./local-common.js";

export interface OpenClawDiscoveryOptions {
  readonly state_dir: string;
}

const ID = "openclaw-local";
const VERSION = "0.1.0";
type EmptyState = Record<string, never>;

function firstInt(usage: Record<string, unknown>, names: readonly string[], label: string): number | null {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(usage, name)) return nonNegativeInt(usage[name], `${label}.${name}`);
  }
  return null;
}

function parseUsage(usage: Record<string, unknown>): { counts: UsageCounts; quality: "runtime_reported" | "unknown" } {
  const input = firstInt(usage, ["input", "inputTokens", "input_tokens"], "OpenClaw usage");
  const output = firstInt(usage, ["output", "outputTokens", "output_tokens"], "OpenClaw usage");
  const cacheRead = firstInt(usage, ["cacheRead", "cacheReadInputTokens", "cache_read_input_tokens"], "OpenClaw usage");
  const cacheWrite = firstInt(usage, ["cacheWrite", "cacheWriteInputTokens", "cache_write_input_tokens"], "OpenClaw usage");
  const total = firstInt(usage, ["totalTokens", "total", "total_tokens"], "OpenClaw usage");
  const allZero = [input, output, cacheRead, cacheWrite, total].some((value) => value !== null)
    && [input, output, cacheRead, cacheWrite, total].every((value) => value === null || value === 0);
  return {
    quality: allZero ? "unknown" : "runtime_reported",
    counts: {
      ...(input === null ? {} : { input_tokens: input }),
      ...(output === null ? {} : { output_tokens: output }),
      ...(cacheRead === null ? {} : { cache_read_tokens: cacheRead }),
      ...(cacheWrite === null ? {} : { cache_write_tokens: cacheWrite }),
      ...(total === null ? {} : { total_tokens_reported: total })
    }
  };
}

function parser(source: LocalFileSource): JsonlParser<EmptyState> {
  const sessionId = filenameSessionId(source.path);
  return {
    initialState: () => ({}),
    restoreState: () => ({}),
    snapshotState: () => null,
    parse(record, context): readonly ParsedLocalEmission[] {
      if (record.type !== "message") return [];
      const message = asRecord(record.message);
      if (message?.role !== "assistant") return [];
      const usage = asRecord(message.usage);
      if (usage === null) return [];
      const parsed = parseUsage(usage);
      if (Object.keys(parsed.counts).length === 0) return [];
      const observed = isoTime(record.timestamp ?? message.timestamp, "OpenClaw assistant timestamp");
      if (observed === null) throw new LocalCollectorError("OPENCLAW_TIMESTAMP_MISSING", "OpenClaw usage record has no timestamp");
      const id = optionalText(record.id ?? message.id, 500) ?? `line:${context.line}`;
      const provider = optionalText(message.provider, 200);
      const model = optionalText(message.model, 500);
      const api = optionalText(message.api, 200);
      const event = buildLocalEvent({
        collectorId: ID,
        collectorVersion: VERSION,
        runtime: "openclaw",
        sourceType: "openclaw.session-jsonl",
        sourceId: source.source_id,
        sourceRecordKey: id,
        eventDiscriminator: `line:${context.line}:${id}`,
        observedAt: observed,
        requestId: id,
        sessionId,
        sourcePlatform: provider,
        identity: {
          billing_platform: provider,
          inference_provider: provider,
          requested_model: model,
          resolved_model: null,
          ...(api === null ? {} : { billing_mode: api })
        },
        usage: parsed.counts,
        timing: {},
        usageQuality: parsed.quality,
        timingQuality: "unknown"
      });
      return Object.freeze([Object.freeze({
        event,
        correlation_keys: correlations([
          { kind: "openclaw_message", value: id },
          { kind: "openclaw_session", value: sessionId }
        ])
      })]);
    }
  };
}

function detect(sourceValue: LocalFileSource): CollectorDetection {
  const source = normalizeSource(sourceValue);
  const status = regularFileStatus(source.path);
  if (status === "missing") return Object.freeze({ status: "unavailable", code: "OPENCLAW_SESSION_NOT_FOUND" });
  if (status === "unsafe") return Object.freeze({ status: "unavailable", code: "OPENCLAW_SESSION_UNSAFE" });
  return Object.freeze({ status: "available", code: "OPENCLAW_SESSION_READY" });
}

function collect(request: CollectorScanRequest<LocalFileSource>): CollectorScanResult {
  return scanJsonl({
    source: request.source,
    checkpoint: request.checkpoint_cursor,
    maxEvents: request.max_events,
    parser: parser(normalizeSource(request.source))
  });
}

export function discoverOpenClawSources(options: OpenClawDiscoveryOptions): readonly LocalFileSource[] {
  return discoverFiles(join(options.state_dir, "agents"), (_path, name) => name.endsWith(".jsonl") && !name.endsWith(".trajectory.jsonl"), "openclaw");
}

export const OPENCLAW_COLLECTOR: TokenCollector<LocalFileSource> = Object.freeze({
  definition: Object.freeze({ id: ID, version: VERSION, runtimes: Object.freeze(["openclaw"]) }),
  detect,
  collect
});
