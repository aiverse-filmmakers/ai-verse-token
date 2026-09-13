import { validateUsageEvent } from "../protocol/validation.js";
import type { IngestUsageEventResult } from "../storage/index.js";
import { CollectorRegistry } from "./registry.js";
import type {
  CollectorDetection,
  CollectorEmission,
  CollectorHealth,
  CollectorRunRequest,
  CollectorRunResult,
  CollectorRuntimeScope,
  CollectorScanResult
} from "./types.js";

const DEFAULT_MAX_EVENTS = 1_000;
const HARD_MAX_EVENTS = 10_000;
const SAFE_CODE_RE = /^[A-Z][A-Z0-9_]{0,79}$/;

export type CollectorExecutionErrorCode =
  | "COLLECTOR_DETECTION_INVALID"
  | "COLLECTOR_SCAN_INVALID"
  | "COLLECTOR_PROVENANCE_MISMATCH"
  | "COLLECTOR_RUNTIME_MISMATCH"
  | "COLLECTOR_LIMIT_EXCEEDED"
  | "COLLECTOR_FAILED";

export class CollectorExecutionError extends Error {
  readonly code: CollectorExecutionErrorCode;

  constructor(code: CollectorExecutionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CollectorExecutionError";
    this.code = code;
  }
}

function bounded(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.includes("\u0000")) {
    throw new CollectorExecutionError("COLLECTOR_SCAN_INVALID", `${label} must be a non-empty string up to ${max} characters`);
  }
  return value;
}

function maxEvents(value: number | undefined): number {
  const result = value ?? DEFAULT_MAX_EVENTS;
  if (!Number.isSafeInteger(result) || result < 1 || result > HARD_MAX_EVENTS) {
    throw new CollectorExecutionError("COLLECTOR_LIMIT_EXCEEDED", `max_events must be in 1..${HARD_MAX_EVENTS}`);
  }
  return result;
}

function detection(value: CollectorDetection): CollectorDetection {
  if (value.status !== "available" && value.status !== "unavailable" && value.status !== "degraded") {
    throw new CollectorExecutionError("COLLECTOR_DETECTION_INVALID", "collector detection status is invalid");
  }
  if (typeof value.code !== "string" || !SAFE_CODE_RE.test(value.code)) {
    throw new CollectorExecutionError("COLLECTOR_DETECTION_INVALID", "collector detection code must be a stable uppercase code");
  }
  return Object.freeze({ status: value.status, code: value.code });
}

function runtimeAllowed(scope: CollectorRuntimeScope, runtime: string): boolean {
  return scope === "*" || scope.includes(runtime);
}

function scanResult(value: CollectorScanResult, limit: number): CollectorScanResult {
  if (typeof value !== "object" || value === null || !Array.isArray(value.emissions) || typeof value.complete !== "boolean") {
    throw new CollectorExecutionError("COLLECTOR_SCAN_INVALID", "collector scan result is invalid");
  }
  if (value.emissions.length > limit) {
    throw new CollectorExecutionError("COLLECTOR_LIMIT_EXCEEDED", "collector emitted more events than requested max_events");
  }
  return value;
}

function health(collectorId: string, status: CollectorHealth["status"], code: string): CollectorHealth {
  return Object.freeze({ collector_id: collectorId, status, code });
}

function normalizeEmission(
  emission: CollectorEmission,
  collectorId: string,
  collectorVersion: string,
  runtimes: CollectorRuntimeScope
): { event: ReturnType<typeof validateUsageEvent>; checkpoint: string; correlations: CollectorEmission["correlation_keys"] } {
  if (typeof emission !== "object" || emission === null) {
    throw new CollectorExecutionError("COLLECTOR_SCAN_INVALID", "collector emission must be an object");
  }
  const event = validateUsageEvent(emission.event);
  if (event.provenance.collector_id !== collectorId) {
    throw new CollectorExecutionError(
      "COLLECTOR_PROVENANCE_MISMATCH",
      `collector '${collectorId}' emitted provenance for '${event.provenance.collector_id}'`
    );
  }
  if (event.provenance.collector_version !== undefined
    && event.provenance.collector_version !== null
    && event.provenance.collector_version !== collectorVersion) {
    throw new CollectorExecutionError(
      "COLLECTOR_PROVENANCE_MISMATCH",
      `collector '${collectorId}' emitted version '${event.provenance.collector_version}' instead of '${collectorVersion}'`
    );
  }
  if (!runtimeAllowed(runtimes, event.source.runtime)) {
    throw new CollectorExecutionError(
      "COLLECTOR_RUNTIME_MISMATCH",
      `collector '${collectorId}' is not registered for runtime '${event.source.runtime}'`
    );
  }
  const checkpoint = bounded(emission.checkpoint_cursor, "checkpoint_cursor", 4096);
  return { event, checkpoint, correlations: emission.correlation_keys };
}

export class CollectorRunner {
  readonly #registry: CollectorRegistry;

  constructor(registry: CollectorRegistry) {
    this.#registry = registry;
  }

  async run<TSource>(request: CollectorRunRequest<TSource>): Promise<CollectorRunResult> {
    const collector = this.#registry.require(request.collector_id);
    const checkpointKey = bounded(request.checkpoint_key ?? "default", "checkpoint_key", 200);
    const limit = maxEvents(request.max_events);
    const beforeState = request.ledger.collectorCheckpoint(collector.definition.id, checkpointKey);
    const before = beforeState?.cursor ?? null;

    let detected: CollectorDetection;
    try {
      detected = detection(await collector.detect(request.source));
    } catch (error) {
      if (error instanceof CollectorExecutionError) throw error;
      throw new CollectorExecutionError("COLLECTOR_FAILED", `collector '${collector.definition.id}' detection failed`, { cause: error });
    }

    if (detected.status === "unavailable") {
      return Object.freeze({
        collector_id: collector.definition.id,
        detection: detected,
        health: health(collector.definition.id, "unavailable", detected.code),
        emitted: 0,
        inserted: 0,
        duplicates: 0,
        complete: true,
        checkpoint_before: before,
        checkpoint_after: before
      });
    }

    let scan: CollectorScanResult;
    try {
      scan = scanResult(await collector.collect({
        source: request.source,
        checkpoint_key: checkpointKey,
        checkpoint_cursor: before,
        max_events: limit
      }), limit);
    } catch (error) {
      if (error instanceof CollectorExecutionError) throw error;
      throw new CollectorExecutionError("COLLECTOR_FAILED", `collector '${collector.definition.id}' scan failed`, { cause: error });
    }

    const normalized = scan.emissions.map((emission) => normalizeEmission(
      emission,
      collector.definition.id,
      collector.definition.version,
      collector.definition.runtimes
    ));

    let inserted = 0;
    let duplicates = 0;
    let after = before;
    for (const emission of normalized) {
      let result: IngestUsageEventResult;
      try {
        result = request.ledger.ingestUsageEvent(emission.event, {
          checkpoint: { key: checkpointKey, cursor: emission.checkpoint },
          ...(emission.correlations === undefined ? {} : { correlationKeys: emission.correlations })
        });
      } catch (error) {
        throw new CollectorExecutionError("COLLECTOR_FAILED", `collector '${collector.definition.id}' ingest failed`, { cause: error });
      }
      if (result.status === "inserted") inserted += 1;
      else duplicates += 1;
      after = emission.checkpoint;
    }

    const status: CollectorHealth["status"] = detected.status === "degraded" ? "degraded" : "healthy";
    return Object.freeze({
      collector_id: collector.definition.id,
      detection: detected,
      health: health(collector.definition.id, status, detected.code),
      emitted: normalized.length,
      inserted,
      duplicates,
      complete: scan.complete,
      checkpoint_before: before,
      checkpoint_after: after
    });
  }
}

export const COLLECTOR_RUN_LIMITS = Object.freeze({
  default_max_events: DEFAULT_MAX_EVENTS,
  hard_max_events: HARD_MAX_EVENTS
});
