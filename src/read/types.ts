import type { EfficiencyAnalysis, EfficiencyGroupDimension, RetryLink } from "../efficiency/index.js";
import type { UsageAggregateRequest, UsageAggregateResult, UsageQueryFilter, UsageQueryRequest, UsageQueryResult } from "../query/index.js";
import type { TimeAnalysis, TimeBucketKind, TimeRollupRow } from "../time/index.js";

export const TOKEN_READ_MAX_ANALYSIS_EVENTS = 50_000 as const;
export const TOKEN_READ_DEFAULT_ANALYSIS_EVENTS = 10_000 as const;

export interface TokenReadOpenOptions {
  readonly path: string;
}

export interface BoundedReadRequest {
  readonly filter?: UsageQueryFilter;
  readonly max_events?: number;
}

export interface TimeReadRequest extends BoundedReadRequest {
  readonly bucket?: TimeBucketKind;
}

export interface TimeReadResult {
  readonly event_count: number;
  readonly analysis: TimeAnalysis;
  readonly rollups: readonly TimeRollupRow[];
}

export interface EfficiencyReadRequest extends BoundedReadRequest {
  readonly group_by?: EfficiencyGroupDimension;
  readonly retry_links?: readonly RetryLink[];
}

export interface EfficiencyReadResult {
  readonly event_count: number;
  readonly analysis: EfficiencyAnalysis;
  readonly cost_scope: "actual_only";
}

export interface TokenSummary {
  readonly request_count: number | string;
  readonly input_tokens: number | string | null;
  readonly output_tokens: number | string | null;
  readonly reasoning_tokens: number | string | null;
  readonly cache_read_tokens: number | string | null;
  readonly cache_write_tokens: number | string | null;
  readonly cached_input_tokens: number | string | null;
  readonly total_tokens_reported: number | string | null;
}

export interface TokenReadApi {
  readonly closed: boolean;
  query(request?: UsageQueryRequest): UsageQueryResult;
  aggregate(request: UsageAggregateRequest): UsageAggregateResult;
  summary(filter?: UsageQueryFilter): TokenSummary;
  time(request?: TimeReadRequest): TimeReadResult;
  efficiency(request?: EfficiencyReadRequest): EfficiencyReadResult;
  close(): void;
}
