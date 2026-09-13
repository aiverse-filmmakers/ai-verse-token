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

export interface CodexDiscoveryOptions {
  readonly codex_home: string;
}

interface CodexState {
  session_id: string | null;
  provider: string | null;
  model: string | null;
  cli_version: string | null;
  turn_id: string | null;
}

const DURABLE_USAGE_MIN_VERSION = Object.freeze([0, 153, 0] as const);

const ID = "codex-local";
const VERSION = "0.1.0";

function state(value?: Partial<CodexState>): CodexState {
  return {
    session_id: value?.session_id ?? null,
    provider: value?.provider ?? null,
    model: value?.model ?? null,
    cli_version: value?.cli_version ?? null,
    turn_id: value?.turn_id ?? null
  };
}

function restore(value: unknown): CodexState {
  const row = asRecord(value);
  if (row === null) return state();
  return state({
    session_id: optionalText(row.session_id, 500),
    provider: optionalText(row.provider, 200),
    model: optionalText(row.model, 500),
    cli_version: optionalText(row.cli_version, 100),
    turn_id: optionalText(row.turn_id, 500)
  });
}


function codexVersionAtLeast(value: string | null, minimum: readonly [number, number, number]): boolean {
  if (value === null) return false;
  const match = /^(?:codex-cli\s+)?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (match === null) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  for (let index = 0; index < minimum.length; index += 1) {
    const part = actual[index] as number;
    const floor = minimum[index] as number;
    if (part > floor) return true;
    if (part < floor) return false;
  }
  return true;
}

function parseUsage(value: Record<string, unknown>): { usage: UsageCounts; quality: "runtime_reported" | "estimated" } | null {
  const rawInput = nonNegativeInt(value.input_tokens, "Codex input_tokens");
  const cached = nonNegativeInt(value.cached_input_tokens, "Codex cached_input_tokens") ?? 0;
  const cacheWrite = nonNegativeInt(value.cache_write_input_tokens, "Codex cache_write_input_tokens");
  const rawOutput = nonNegativeInt(value.output_tokens, "Codex output_tokens");
  const reasoning = nonNegativeInt(value.reasoning_output_tokens, "Codex reasoning_output_tokens") ?? 0;
  const total = nonNegativeInt(value.total_tokens, "Codex total_tokens");

  if (rawInput === null && rawOutput === null && total === null) return null;
  if (rawInput !== null && cached > rawInput) {
    throw new LocalCollectorError("CODEX_USAGE_INVALID", "cached_input_tokens exceeds input_tokens");
  }
  if (rawOutput !== null && reasoning > rawOutput) {
    throw new LocalCollectorError("CODEX_USAGE_INVALID", "reasoning_output_tokens exceeds output_tokens");
  }

  const breakdownZero = (rawInput ?? 0) === 0
    && cached === 0
    && (cacheWrite ?? 0) === 0
    && (rawOutput ?? 0) === 0
    && reasoning === 0;
  const quality = breakdownZero && (total ?? 0) > 0 ? "estimated" : "runtime_reported";
  return {
    quality,
    usage: {
      ...(rawInput === null ? {} : { context_input_tokens: rawInput, input_tokens: rawInput - cached }),
      ...(cached === 0 && value.cached_input_tokens === undefined ? {} : { cached_input_tokens: cached }),
      ...(cacheWrite === null ? {} : { cache_write_tokens: cacheWrite }),
      ...(rawOutput === null ? {} : { output_tokens: rawOutput - reasoning }),
      ...(value.reasoning_output_tokens === undefined ? {} : { reasoning_tokens: reasoning }),
      ...(total === null ? {} : { total_tokens_reported: total })
    }
  };
}

function parser(source: LocalFileSource): JsonlParser<CodexState> {
  return {
    initialState: () => state(),
    restoreState: restore,
    snapshotState: (value) => ({ ...value }),
    parse(record, context, current): readonly ParsedLocalEmission[] {
      const payload = asRecord(record.payload);
      if (record.type === "session_meta" && payload !== null) {
        current.session_id = optionalText(payload.id ?? payload.session_id, 500) ?? current.session_id;
        current.provider = optionalText(payload.model_provider, 200) ?? current.provider;
        current.cli_version = optionalText(payload.cli_version, 100) ?? current.cli_version;
        const metaModel = optionalText(payload.model, 500);
        if (metaModel !== null) current.model = metaModel;
        return [];
      }
      if (record.type === "turn_context" && payload !== null) {
        current.turn_id = optionalText(payload.turn_id, 500) ?? current.turn_id;
        current.model = optionalText(payload.model, 500) ?? current.model;
        return [];
      }
      if (record.type === "token_usage_record" && payload !== null) {
        const usage = asRecord(payload.usage);
        if (usage === null) return [];
        const parsed = parseUsage(usage);
        if (parsed === null) return [];
        const observed = isoTime(record.timestamp, "Codex token_usage_record timestamp");
        if (observed === null) {
          throw new LocalCollectorError("CODEX_TIMESTAMP_MISSING", "Codex token_usage_record has no timestamp");
        }
        const responseId = optionalText(payload.response_id, 500);
        const sessionId = optionalText(payload.session_id, 500) ?? current.session_id;
        const turnId = optionalText(payload.turn_id, 500) ?? current.turn_id;
        const rootTurnId = optionalText(payload.root_turn_id, 500);
        const lineKey = responseId === null ? `line:${context.line}:durable` : `response:${responseId}`;
        const event = buildLocalEvent({
          collectorId: ID,
          collectorVersion: VERSION,
          runtime: "codex",
          sourceType: "codex.rollout-token-usage-record",
          sourceId: source.source_id,
          sourceRecordKey: lineKey,
          eventDiscriminator: lineKey,
          observedAt: observed,
          requestId: responseId,
          sessionId,
          taskId: turnId,
          sourcePlatform: current.provider,
          identity: {
            billing_platform: current.provider,
            inference_provider: current.provider === "openai" ? "openai" : null,
            requested_model: current.model,
            resolved_model: null
          },
          usage: parsed.usage,
          timing: {},
          usageQuality: parsed.quality,
          timingQuality: "unknown"
        });
        return Object.freeze([Object.freeze({
          event,
          correlation_keys: correlations([
            sessionId === null ? null : { kind: "codex_session", value: sessionId },
            turnId === null ? null : { kind: "codex_turn", value: turnId },
            rootTurnId === null ? null : { kind: "codex_root_turn", value: rootTurnId },
            responseId === null ? null : { kind: "codex_response", value: responseId }
          ])
        })]);
      }

      if (record.type !== "event_msg" || payload?.type !== "token_count") return [];
      // Codex 0.153.0 introduced durable per-response token_usage_record items.
      // Those are more attributable than the legacy token_count stream and may coexist
      // with it, so suppress legacy records for versions guaranteed to persist the new form.
      if (codexVersionAtLeast(current.cli_version, DURABLE_USAGE_MIN_VERSION)) return [];
      const info = asRecord(payload.info);
      const last = info === null ? null : asRecord(info.last_token_usage);
      if (last === null) return [];
      const parsed = parseUsage(last);
      if (parsed === null) return [];
      const observed = isoTime(record.timestamp, "Codex token_count timestamp");
      if (observed === null) throw new LocalCollectorError("CODEX_TIMESTAMP_MISSING", "Codex token_count has no timestamp");
      const lineKey = `line:${context.line}`;
      const event = buildLocalEvent({
        collectorId: ID,
        collectorVersion: VERSION,
        runtime: "codex",
        sourceType: "codex.rollout-jsonl",
        sourceId: source.source_id,
        sourceRecordKey: lineKey,
        eventDiscriminator: lineKey,
        observedAt: observed,
        sessionId: current.session_id,
        taskId: current.turn_id,
        sourcePlatform: current.provider,
        identity: {
          billing_platform: current.provider,
          inference_provider: current.provider === "openai" ? "openai" : null,
          requested_model: current.model,
          resolved_model: null
        },
        usage: parsed.usage,
        timing: {},
        usageQuality: parsed.quality,
        timingQuality: "unknown"
      });
      return Object.freeze([Object.freeze({
        event,
        correlation_keys: correlations([
          current.session_id === null ? null : { kind: "codex_session", value: current.session_id },
          current.turn_id === null ? null : { kind: "codex_turn", value: current.turn_id }
        ])
      })]);
    }
  };
}

function detect(sourceValue: LocalFileSource): CollectorDetection {
  const source = normalizeSource(sourceValue);
  const status = regularFileStatus(source.path);
  if (status === "missing") return Object.freeze({ status: "unavailable", code: "CODEX_ROLLOUT_NOT_FOUND" });
  if (status === "unsafe") return Object.freeze({ status: "unavailable", code: "CODEX_ROLLOUT_UNSAFE" });
  return Object.freeze({ status: "available", code: "CODEX_ROLLOUT_READY" });
}

function collect(request: CollectorScanRequest<LocalFileSource>): CollectorScanResult {
  return scanJsonl({
    source: request.source,
    checkpoint: request.checkpoint_cursor,
    maxEvents: request.max_events,
    parser: parser(normalizeSource(request.source))
  });
}

export function discoverCodexSources(options: CodexDiscoveryOptions): readonly LocalFileSource[] {
  return discoverFiles(join(options.codex_home, "sessions"), (_path, name) => name.startsWith("rollout-") && name.endsWith(".jsonl"), "codex");
}

export const CODEX_COLLECTOR: TokenCollector<LocalFileSource> = Object.freeze({
  definition: Object.freeze({ id: ID, version: VERSION, runtimes: Object.freeze(["codex"]) }),
  detect,
  collect
});
