import type { CostResult } from "../cost/types.js";
import type { UsageEvent } from "../protocol/types.js";

export const EFFICIENCY_GROUP_DIMENSIONS = [
  "session_id",
  "task_id",
  "runtime",
  "billing_platform",
  "inference_provider",
  "resolved_model",
  "workspace_id",
  "project_id",
  "agent_id",
  "bot_id",
  "worker_id"
] as const;
export type EfficiencyGroupDimension = (typeof EFFICIENCY_GROUP_DIMENSIONS)[number];

export interface ExactIntegerMetric {
  readonly known_lower_bound: string;
  readonly complete: boolean;
  readonly unknown_event_count: number;
}

export interface RatioMetric {
  readonly value: number | null;
  readonly numerator_lower_bound: string;
  readonly denominator_lower_bound: string;
  readonly complete: boolean;
  readonly unknown_event_count: number;
}

export interface CurrencyCostTotals {
  readonly currency: string;
  readonly actual: string;
  readonly calculated: string;
  readonly known_total: string;
}

export interface CostCoverage {
  readonly by_currency: readonly CurrencyCostTotals[];
  readonly actual_event_count: number;
  readonly calculated_event_count: number;
  readonly unknown_event_count: number;
  readonly complete: boolean;
}

export interface EfficiencyMetrics {
  readonly request_count: number;
  readonly total_tokens: ExactIntegerMetric;
  readonly cache_read_ratio: RatioMetric;
  readonly reasoning_share: RatioMetric;
  readonly compute_ms_known: number;
  readonly compute_time_complete: boolean;
  readonly active_wall_ms_known: number;
  readonly active_wall_time_complete: boolean;
  readonly costs: CostCoverage;
}

export interface EfficiencyGroupRow {
  readonly dimension: EfficiencyGroupDimension | "all";
  readonly key: string | null;
  readonly metrics: EfficiencyMetrics;
}

export interface RetryLink {
  readonly retry_event_id: string;
  readonly original_event_id: string;
}

export interface RetryTax {
  readonly retry_request_count: number;
  readonly total_tokens: ExactIntegerMetric;
  readonly compute_ms_known: number;
  readonly compute_time_complete: boolean;
  readonly costs: CostCoverage;
}

export interface EfficiencyAnalysis {
  readonly overall: EfficiencyMetrics;
  readonly groups: readonly EfficiencyGroupRow[];
  readonly retry_tax: RetryTax;
}

export interface EfficiencyInput {
  readonly events: readonly UsageEvent[];
  readonly costs?: readonly CostResult[];
  readonly group_by?: EfficiencyGroupDimension;
  readonly retry_links?: readonly RetryLink[];
}

export const BUDGET_METRICS = ["requests", "total_tokens", "compute_ms", "active_wall_ms", "cost"] as const;
export type BudgetMetric = (typeof BUDGET_METRICS)[number];
export type BudgetState = "OK" | "WARNING" | "EXCEEDED" | "UNKNOWN";

export interface NumericBudgetDefinition {
  readonly budget_id: string;
  readonly metric: "requests" | "total_tokens" | "compute_ms" | "active_wall_ms";
  readonly limit: string;
  readonly warning_fraction?: number;
}

export interface CostBudgetDefinition {
  readonly budget_id: string;
  readonly metric: "cost";
  readonly limit: string;
  readonly currency: string;
  readonly include_calculated?: boolean;
  readonly warning_fraction?: number;
}

export type BudgetDefinition = NumericBudgetDefinition | CostBudgetDefinition;

export interface BudgetEvaluation {
  readonly budget_id: string;
  readonly metric: BudgetMetric;
  readonly state: BudgetState;
  readonly known_used: string;
  readonly limit: string;
  readonly remaining_if_complete: string | null;
  readonly utilization_if_complete: number | null;
  readonly complete: boolean;
  readonly currency?: string;
  readonly unknown_event_count: number;
}

export interface QuotaWindow {
  readonly kind: string;
  readonly used: number;
  readonly limit: number;
  readonly resets_at: string | null;
}

export interface QuotaWindowSnapshot {
  readonly observed_at: string;
  readonly windows: readonly QuotaWindow[];
}

export interface QuotaWindowEvaluation {
  readonly kind: string;
  readonly state: Exclude<BudgetState, "UNKNOWN">;
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
  readonly utilization: number;
  readonly resets_at: string | null;
}
