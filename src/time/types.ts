import type { UsageEvent } from "../protocol/types.js";

export type TimeBucketKind = "hour" | "day" | "session";

export interface RequestTimeMetrics {
  readonly event_id: string;
  readonly request_id: string | null;
  readonly session_id: string | null;
  readonly wall_ms: number | null;
  readonly wall_source: "timestamps" | "reported" | "unknown";
  readonly ttft_ms: number | null;
  readonly ttft_source: "timestamps" | "reported" | "unknown";
  readonly generation_ms: number | null;
  readonly generation_source: "timestamps" | "reported" | "unknown";
  readonly time_per_output_token_ms: number | null;
  readonly output_tokens_per_second: number | null;
  readonly exact_interval: Readonly<{ start_ms: number; end_ms: number }> | null;
}

export interface ConcurrencyMetrics {
  readonly interval_request_count: number;
  readonly active_wall_ms: number | null;
  readonly interval_compute_ms: number | null;
  readonly overlap_ms: number | null;
  readonly peak_concurrent_requests: number | null;
  readonly average_concurrency_while_active: number | null;
  readonly concurrency_factor: number | null;
}

export interface TimeSummary extends ConcurrencyMetrics {
  readonly request_count: number;
  readonly compute_ms: number | null;
  readonly known_compute_request_count: number;
  readonly unknown_compute_request_count: number;
  readonly session_span_ms: number | null;
  readonly idle_ms: number | null;
  readonly wall_ms_p50: number | null;
  readonly wall_ms_p95: number | null;
  readonly wall_ms_p99: number | null;
  readonly ttft_ms_p50: number | null;
  readonly ttft_ms_p95: number | null;
  readonly ttft_ms_p99: number | null;
  readonly output_tps_p50: number | null;
  readonly output_tps_p95: number | null;
  readonly output_tps_p99: number | null;
}

export interface TimeRollupTokenTotals {
  readonly input_tokens: number | string | null;
  readonly output_tokens: number | string | null;
  readonly reasoning_tokens: number | string | null;
  readonly cache_read_tokens: number | string | null;
  readonly cache_write_tokens: number | string | null;
  readonly cached_input_tokens: number | string | null;
}

export interface TimeRollupRow {
  readonly bucket_kind: TimeBucketKind;
  readonly bucket_key: string | null;
  readonly bucket_start: string | null;
  readonly bucket_end: string | null;
  readonly summary: TimeSummary;
  readonly tokens: TimeRollupTokenTotals;
}

export interface TimeAnalysis {
  readonly requests: readonly RequestTimeMetrics[];
  readonly summary: TimeSummary;
}

export interface TimeRollupOptions {
  readonly bucket: TimeBucketKind;
}

export interface TimeEngineInput {
  readonly events: readonly UsageEvent[];
}
