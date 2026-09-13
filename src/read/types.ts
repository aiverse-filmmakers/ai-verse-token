import type { CostResult } from "../cost/index.js";
import type { EfficiencyAnalysis, EfficiencyGroupDimension, RetryLink } from "../efficiency/index.js";
import type { PricingSourceRegistry } from "../pricing/index.js";
import type { UsageAggregateRequest, UsageAggregateResult, UsageQueryFilter, UsageQueryRequest, UsageQueryResult } from "../query/index.js";
import type { TimeAnalysis, TimeBucketKind, TimeRollupRow } from "../time/index.js";
import type { TokenReadAuthorization } from "./authorization.js";

export const TOKEN_READ_MAX_ANALYSIS_EVENTS = 50_000 as const;
export const TOKEN_READ_DEFAULT_ANALYSIS_EVENTS = 10_000 as const;

export interface TokenReadOpenOptions {
  readonly path: string;
  /** Token-owned price snapshot store. If absent, non-ACTUAL costs remain UNKNOWN. */
  readonly pricing_root?: string;
  /** Trust definitions supplied by Token/host configuration, never by fetched payloads. */
  readonly pricing_registry?: PricingSourceRegistry;
  /** Authorization is supplied explicitly by the outer host or a trusted local-owner boundary. Token never derives it from telemetry. */
  readonly authorization: TokenReadAuthorization;
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
  readonly cost_scope: "actual_calculated_unknown";
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

export interface TokenCostCurrencySummary {
  readonly currency: string;
  readonly actual: string;
  readonly calculated: string;
  readonly known_total: string;
}

export interface TokenCostSummary {
  readonly actual_event_count: number;
  readonly calculated_event_count: number;
  readonly unknown_event_count: number;
  readonly complete: boolean;
  readonly by_currency: readonly TokenCostCurrencySummary[];
}

export interface TokenCostReadResult {
  readonly event_count: number;
  readonly results: readonly CostResult[];
  readonly summary: TokenCostSummary;
}

export interface TokenOverview {
  readonly owner: "ai-verse-token";
  readonly attribution_is_authority: false;
  readonly summary: TokenSummary;
  readonly costs: TokenCostSummary;
}

export interface TokenReadApi {
  readonly closed: boolean;
  query(request?: UsageQueryRequest): UsageQueryResult;
  aggregate(request: UsageAggregateRequest): UsageAggregateResult;
  summary(filter?: UsageQueryFilter): TokenSummary;
  costs(request?: BoundedReadRequest): TokenCostReadResult;
  overview(request?: BoundedReadRequest): TokenOverview;
  time(request?: TimeReadRequest): TimeReadResult;
  efficiency(request?: EfficiencyReadRequest): EfficiencyReadResult;
  close(): void;
}
