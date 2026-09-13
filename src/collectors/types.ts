import type { CorrelationKey, TokenLedger } from "../storage/index.js";
import type { UsageEvent } from "../protocol/types.js";

export type CollectorRuntimeScope = readonly string[] | "*";
export type CollectorDetectionStatus = "available" | "unavailable" | "degraded";
export type CollectorHealthStatus = "healthy" | "unavailable" | "degraded" | "error";

export interface CollectorDefinition {
  readonly id: string;
  readonly version: string;
  readonly runtimes: CollectorRuntimeScope;
}

export interface CollectorDetection {
  readonly status: CollectorDetectionStatus;
  readonly code: string;
}

export interface CollectorScanRequest<TSource = unknown> {
  readonly source: TSource;
  readonly checkpoint_key: string;
  readonly checkpoint_cursor: string | null;
  readonly max_events: number;
}

export interface CollectorEmission {
  readonly event: UsageEvent | unknown;
  readonly checkpoint_cursor: string;
  readonly correlation_keys?: readonly CorrelationKey[];
}

export interface CollectorScanResult {
  readonly emissions: readonly CollectorEmission[];
  readonly complete: boolean;
}

export interface TokenCollector<TSource = unknown> {
  readonly definition: CollectorDefinition;
  detect(source: TSource): Promise<CollectorDetection> | CollectorDetection;
  collect(request: CollectorScanRequest<TSource>): Promise<CollectorScanResult> | CollectorScanResult;
}

export interface CollectorRunRequest<TSource = unknown> {
  readonly collector_id: string;
  readonly source: TSource;
  readonly ledger: TokenLedger;
  readonly checkpoint_key?: string;
  readonly max_events?: number;
}

export interface CollectorHealth {
  readonly collector_id: string;
  readonly status: CollectorHealthStatus;
  readonly code: string;
}

export interface CollectorRunResult {
  readonly collector_id: string;
  readonly detection: CollectorDetection;
  readonly health: CollectorHealth;
  readonly emitted: number;
  readonly inserted: number;
  readonly duplicates: number;
  readonly complete: boolean;
  readonly checkpoint_before: string | null;
  readonly checkpoint_after: string | null;
}
