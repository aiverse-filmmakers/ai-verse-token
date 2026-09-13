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
  scanJsonl,
  type JsonlParser,
  type LocalFileSource,
  type ParsedLocalEmission
} from "./local-common.js";

export interface ClaudeCodeDiscoveryOptions {
  readonly claude_home: string;
}

const ID = "claude-code-local";
const VERSION = "0.1.0";

type EmptyState = Record<string, never>;

function countsFromUsage(usage: Record<string, unknown>): UsageCounts {
  const input = nonNegativeInt(usage.input_tokens, "Claude input_tokens");
  const output = nonNegativeInt(usage.output_tokens, "Claude output_tokens");
  const cacheRead = nonNegativeInt(usage.cache_read_input_tokens, "Claude cache_read_input_tokens");
  const cacheWrite = nonNegativeInt(usage.cache_creation_input_tokens, "Claude cache_creation_input_tokens");
  const total = [input, output, cacheRead, cacheWrite].every((value) => value === null)
    ? null
    : (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  return {
    ...(input === null && cacheRead === null && cacheWrite === null ? {} : { context_input_tokens: (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) }),
    ...(input === null ? {} : { input_tokens: input }),
    ...(output === null ? {} : { output_tokens: output }),
    ...(cacheRead === null ? {} : { cache_read_tokens: cacheRead }),
    ...(cacheWrite === null ? {} : { cache_write_tokens: cacheWrite }),
    ...(total === null ? {} : { total_tokens_reported: total })
  };
}

function hasUsage(counts: UsageCounts): boolean {
  return Object.values(counts).some((value) => typeof value === "number");
}

function usageRecords(usage: Record<string, unknown>): readonly Record<string, unknown>[] {
  const iterations = usage.iterations;
  if (Array.isArray(iterations)) {
    const records = iterations.map(asRecord).filter((item): item is Record<string, unknown> => item !== null);
    if (records.length > 0) return records;
  }
  return Object.freeze([usage]);
}

function parser(source: LocalFileSource): JsonlParser<EmptyState> {
  return {
    initialState: () => ({}),
    restoreState: () => ({}),
    snapshotState: () => null,
    parse(record, context): readonly ParsedLocalEmission[] {
      const message = asRecord(record.message);
      if (message === null || (record.type !== "assistant" && message.role !== "assistant")) return [];
      const usage = asRecord(message.usage);
      if (usage === null) return [];
      const observed = isoTime(record.timestamp ?? message.timestamp, "Claude assistant timestamp");
      if (observed === null) throw new LocalCollectorError("CLAUDE_TIMESTAMP_MISSING", "Claude usage record has no timestamp");
      const sessionId = optionalText(record.sessionId ?? record.session_id, 500);
      const model = optionalText(message.model, 500);
      const provider = optionalText(message.provider ?? record.provider, 200) ?? "anthropic";
      const serviceTier = optionalText(usage.service_tier, 200);
      const requestKey = optionalText(record.requestId ?? record.request_id ?? message.id, 500)
        ?? `line:${context.line}`;
      const items = usageRecords(usage);
      const emissions: ParsedLocalEmission[] = [];
      items.forEach((usageRecord, index) => {
        const counts = countsFromUsage(usageRecord);
        if (!hasUsage(counts)) return;
        const key = `${requestKey}:iteration:${index}`;
        const event = buildLocalEvent({
          collectorId: ID,
          collectorVersion: VERSION,
          runtime: "claude-code",
          sourceType: "claude-code.session-jsonl",
          sourceId: source.source_id,
          sourceRecordKey: key,
          eventDiscriminator: `line:${context.line}:iteration:${index}`,
          observedAt: observed,
          requestId: requestKey,
          sessionId,
          identity: {
            billing_platform: provider,
            inference_provider: provider === "anthropic" ? "anthropic" : null,
            requested_model: model,
            resolved_model: null,
            ...(serviceTier === null ? {} : { service_tier: serviceTier })
          },
          usage: counts,
          timing: {},
          timingQuality: "unknown"
        });
        emissions.push(Object.freeze({
          event,
          correlation_keys: correlations([
            { kind: "claude_request", value: requestKey },
            sessionId === null ? null : { kind: "claude_session", value: sessionId }
          ])
        }));
      });
      return Object.freeze(emissions);
    }
  };
}

function detect(sourceValue: LocalFileSource): CollectorDetection {
  const source = normalizeSource(sourceValue);
  const status = regularFileStatus(source.path);
  if (status === "missing") return Object.freeze({ status: "unavailable", code: "CLAUDE_SESSION_NOT_FOUND" });
  if (status === "unsafe") return Object.freeze({ status: "unavailable", code: "CLAUDE_SESSION_UNSAFE" });
  return Object.freeze({ status: "available", code: "CLAUDE_SESSION_READY" });
}

function collect(request: CollectorScanRequest<LocalFileSource>): CollectorScanResult {
  return scanJsonl({
    source: request.source,
    checkpoint: request.checkpoint_cursor,
    maxEvents: request.max_events,
    parser: parser(normalizeSource(request.source))
  });
}

export function discoverClaudeCodeSources(options: ClaudeCodeDiscoveryOptions): readonly LocalFileSource[] {
  return discoverFiles(join(options.claude_home, "projects"), (_path, name) => name.endsWith(".jsonl"), "claude");
}

export const CLAUDE_CODE_COLLECTOR: TokenCollector<LocalFileSource> = Object.freeze({
  definition: Object.freeze({ id: ID, version: VERSION, runtimes: Object.freeze(["claude-code"]) }),
  detect,
  collect
});
