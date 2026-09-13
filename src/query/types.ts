import type { UsageEvent } from "../protocol/types.js";

export const USAGE_QUERY_MAX_LIMIT = 500 as const;
export const USAGE_QUERY_DEFAULT_LIMIT = 100 as const;
export const USAGE_AGGREGATE_MAX_GROUPS = 500 as const;
export const USAGE_AGGREGATE_DEFAULT_GROUPS = 100 as const;
export const USAGE_AGGREGATE_MAX_DIMENSIONS = 4 as const;
export const USAGE_AGGREGATE_MAX_METRICS = 16 as const;

export type UsageQueryOrder = "asc" | "desc";

export interface UsageQueryFilter {
  readonly observed_from?: string;
  readonly observed_to?: string;
  readonly request_id?: string | null;
  readonly session_id?: string | null;
  readonly task_id?: string | null;
  readonly runtime?: string | null;
  readonly billing_platform?: string | null;
  readonly inference_provider?: string | null;
  readonly requested_model?: string | null;
  readonly resolved_model?: string | null;
  readonly service_tier?: string | null;
  readonly workspace_id?: string | null;
  readonly project_id?: string | null;
  readonly agent_id?: string | null;
  readonly bot_id?: string | null;
  readonly worker_id?: string | null;
}

export interface UsageQueryRequest {
  readonly filter?: UsageQueryFilter;
  readonly order?: UsageQueryOrder;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface UsageQueryResult {
  readonly events: readonly UsageEvent[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export const USAGE_GROUP_DIMENSIONS = [
  "runtime",
  "billing_platform",
  "inference_provider",
  "requested_model",
  "resolved_model",
  "service_tier",
  "workspace_id",
  "project_id",
  "agent_id",
  "bot_id",
  "worker_id",
  "task_id"
] as const;
export type UsageGroupDimension = (typeof USAGE_GROUP_DIMENSIONS)[number];

export const USAGE_AGGREGATE_FIELDS = [
  "context_input_tokens",
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cached_input_tokens",
  "audio_input_tokens",
  "audio_output_tokens",
  "total_tokens_reported",
  "image_input_units",
  "image_output_units",
  "web_search_units",
  "request_units",
  "wall_ms",
  "ttft_ms",
  "generation_ms",
  "queue_ms",
  "provider_ms",
  "gateway_overhead_ms",
  "tool_wait_ms",
  "network_ms"
] as const;
export type UsageAggregateField = (typeof USAGE_AGGREGATE_FIELDS)[number];

export type UsageAggregateOperator = "count" | "sum" | "avg" | "min" | "max";

export interface UsageAggregateMetric {
  readonly operator: UsageAggregateOperator;
  readonly field?: UsageAggregateField;
}

export interface UsageAggregateRequest {
  readonly filter?: UsageQueryFilter;
  readonly groupBy?: readonly UsageGroupDimension[];
  readonly metrics: readonly UsageAggregateMetric[];
  readonly limit?: number;
}

export type UsageAggregateValue = number | string | null;

export interface UsageAggregateRow {
  readonly dimensions: Readonly<Record<string, string | null>>;
  readonly metrics: Readonly<Record<string, UsageAggregateValue>>;
}

export interface UsageAggregateResult {
  readonly rows: readonly UsageAggregateRow[];
  readonly truncated: boolean;
}
