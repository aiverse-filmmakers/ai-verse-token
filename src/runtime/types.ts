import type { CollectorHealthStatus, CollectorRunResult } from "../collectors/index.js";
import type { PricingSyncReport } from "../pricing/index.js";

export interface TokenRuntimeConfig {
  readonly schema_version: "ai-verse-token-runtime/0.1";
  readonly setup_at: string;
  readonly collection: {
    readonly enabled: boolean;
    readonly default_collectors: true;
  };
  readonly pricing: {
    readonly openrouter_models_api: {
      readonly enabled: boolean;
      readonly api_key_env: string;
    };
  };
  readonly authority: {
    readonly telemetry_attribution_is_permission: false;
    readonly external_authorization_owner: "host";
  };
}

export interface TokenDiscoveredSource {
  readonly collector_id: string;
  readonly source_key: string;
  readonly source: unknown;
  readonly path: string | null;
}

export interface TokenSourceDiscoveryResult {
  readonly roots: Readonly<Record<string, string>>;
  readonly sources: readonly TokenDiscoveredSource[];
  readonly problems: readonly { readonly collector_id: string; readonly code: string; readonly message: string }[];
}

export interface TokenCollectionSourceResult {
  readonly collector_id: string;
  readonly source_key: string;
  readonly path: string | null;
  readonly health: CollectorHealthStatus | "error";
  readonly emitted: number;
  readonly inserted: number;
  readonly duplicates: number;
  readonly complete: boolean;
  readonly batches: number;
  readonly error_code?: string;
  readonly error_message?: string;
  readonly last_run?: CollectorRunResult;
}

export interface TokenCollectionResult {
  readonly owner: "ai-verse-token";
  readonly attribution_is_authority: false;
  readonly source_count: number;
  readonly sources: readonly TokenCollectionSourceResult[];
  readonly emitted: number;
  readonly inserted: number;
  readonly duplicates: number;
  readonly complete: boolean;
  readonly error_count: number;
}

export type TokenReadinessState = "absent" | "installed" | "setup-required" | "disabled" | "unhealthy" | "ready";


export interface TokenOperationalStatus {
  readonly state: TokenReadinessState;
  readonly ready: boolean;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly setup: boolean;
  readonly ledger_exists: boolean;
}

export interface TokenOperationalDoctor {
  readonly state: TokenReadinessState;
  readonly ready: boolean;
  readonly depths_checked: readonly ["structural", "attachment/discovery", "runtime", "dependency", "operational"];
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly setup: boolean;
  readonly ledger: { readonly exists: boolean; readonly integrity_ok: boolean | null };
  readonly collectors: {
    readonly discovered_sources: number;
    readonly healthy: number;
    readonly degraded: number;
    readonly unavailable: number;
    readonly errors: number;
  };
  readonly pricing: {
    readonly transport_configured: boolean;
    readonly credential_available: boolean;
    readonly snapshot_count: number;
    readonly openrouter_last_status: string | null;
    readonly calculated_cost_ready: boolean;
  };
  readonly cost_truth: {
    readonly primary_read_supports_actual: true;
    readonly primary_read_supports_calculated: true;
    readonly primary_read_preserves_unknown: true;
    readonly calculated_cost_ready: boolean;
  };
  readonly problems: readonly { readonly code: string; readonly message: string }[];
  readonly notices: readonly { readonly code: string; readonly message: string }[];
}

export interface TokenSetupResult {
  readonly command: "setup";
  readonly root_path: string;
  readonly config_created: boolean;
  readonly ledger_created: boolean;
  readonly state_preserved: true;
  readonly collection: TokenCollectionResult | null;
  readonly pricing: readonly PricingSyncReport[];
  readonly readiness: TokenOperationalDoctor;
}
