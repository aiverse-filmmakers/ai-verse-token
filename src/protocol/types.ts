import type {
  ACTUAL_CHARGE_SOURCES,
  COST_STATUSES,
  TIMING_QUALITIES,
  USAGE_QUALITIES
} from "./constants.js";

export type CostStatus = (typeof COST_STATUSES)[number];
export type UsageQuality = (typeof USAGE_QUALITIES)[number];
export type TimingQuality = (typeof TIMING_QUALITIES)[number];
export type ActualChargeSource = (typeof ACTUAL_CHARGE_SOURCES)[number];

export interface UsageEventSource {
  readonly runtime: string;
  readonly runtime_version?: string | null;
  readonly source_type: string;
  readonly source_record_id?: string | null;
  readonly source_platform?: string | null;
}

export interface UsageIdentity {
  readonly billing_platform: string | null;
  readonly inference_provider?: string | null;
  readonly requested_model: string | null;
  readonly resolved_model: string | null;
  readonly provider_model_id?: string | null;
  readonly service_tier?: string | null;
  readonly region?: string | null;
  readonly billing_mode?: string | null;
  readonly alias_rule_id?: string | null;
}

export interface UsageScope {
  readonly system_id?: string | null;
  readonly workspace_id?: string | null;
  readonly project_id?: string | null;
  readonly agent_id?: string | null;
  readonly bot_id?: string | null;
  readonly worker_id?: string | null;
  readonly skill_id?: string | null;
  readonly automation_id?: string | null;
  readonly tool_id?: string | null;
}

export interface UsageCounts {
  /** Provider-reported inclusive prompt/context input before cache decomposition. */
  readonly context_input_tokens?: number | null;
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly reasoning_tokens?: number | null;
  readonly cache_read_tokens?: number | null;
  readonly cache_write_tokens?: number | null;
  readonly cached_input_tokens?: number | null;
  readonly audio_input_tokens?: number | null;
  readonly audio_output_tokens?: number | null;
  readonly image_input_units?: number | null;
  readonly image_output_units?: number | null;
  readonly web_search_units?: number | null;
  readonly request_units?: number | null;
  readonly total_tokens_reported?: number | null;
}

export interface UsageTiming {
  readonly started_at?: string | null;
  readonly first_byte_at?: string | null;
  readonly first_token_at?: string | null;
  readonly last_token_at?: string | null;
  readonly ended_at?: string | null;
  readonly wall_ms?: number | null;
  readonly ttft_ms?: number | null;
  readonly generation_ms?: number | null;
  readonly queue_ms?: number | null;
  readonly provider_ms?: number | null;
  readonly gateway_overhead_ms?: number | null;
  readonly tool_wait_ms?: number | null;
  readonly network_ms?: number | null;
}

export interface ActualCharge {
  /** Exact non-negative base-10 decimal text. */
  readonly amount: string;
  readonly currency: string;
  readonly source: ActualChargeSource;
  readonly external_charge_id?: string | null;
  readonly reported_at?: string | null;
}

export interface UsageProvenance {
  readonly collector_id: string;
  readonly collector_version?: string | null;
  readonly source_type?: string | null;
  readonly source_record_fingerprint: string;
  readonly usage_quality: UsageQuality;
  readonly timing_quality: TimingQuality;
  readonly content_stored: false;
}

export interface UsageEvent {
  readonly schema_version: "ai-verse-token/0.1";
  readonly event_id: string;
  readonly request_id?: string | null;
  readonly session_id?: string | null;
  readonly run_id?: string | null;
  readonly task_id?: string | null;
  readonly source: UsageEventSource;
  readonly observed_at: string;
  readonly identity: UsageIdentity;
  readonly scope?: UsageScope;
  readonly usage: UsageCounts;
  readonly timing: UsageTiming;
  readonly actual_charge?: ActualCharge | null;
  readonly provenance: UsageProvenance;
}
