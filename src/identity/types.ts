import type { UsageEvent, UsageIdentity } from "../protocol/types.js";

export type IdentityResolutionStatus = "exact" | "partial" | "ambiguous" | "unknown";
export type IdentityFieldSource =
  | "provided"
  | "source_platform_exact_alias"
  | "direct_platform"
  | "exact_model_alias"
  | "unknown";

export type ModelAliasMatchField = "requested_model" | "provider_model_id";

export interface PlatformAliasRule {
  readonly alias: string;
  readonly canonical: string;
}

export interface ExactModelAliasRule {
  readonly id: string;
  readonly billingPlatform: string;
  readonly matchField: ModelAliasMatchField;
  readonly alias: string;
  readonly resolvedModel: string;
  readonly inferenceProvider?: string | null;
  readonly providerModelId?: string | null;
  readonly effectiveFrom?: string | null;
  readonly effectiveTo?: string | null;
}

export interface IdentityResolverConfig {
  readonly platformAliases?: readonly PlatformAliasRule[];
  readonly modelAliases?: readonly ExactModelAliasRule[];
}

export interface IdentityResolutionInput {
  readonly observedAt: string;
  readonly runtime: string;
  readonly sourcePlatform?: string | null;
  readonly billingPlatform?: string | null;
  readonly inferenceProvider?: string | null;
  readonly requestedModel?: string | null;
  readonly resolvedModel?: string | null;
  readonly providerModelId?: string | null;
  readonly serviceTier?: string | null;
  readonly region?: string | null;
  readonly billingMode?: string | null;
  readonly aliasRuleId?: string | null;
}

export interface IdentityResolutionSources {
  readonly billingPlatform: IdentityFieldSource;
  readonly inferenceProvider: IdentityFieldSource;
  readonly resolvedModel: IdentityFieldSource;
}

export interface IdentityResolution {
  readonly identity: UsageIdentity;
  readonly status: IdentityResolutionStatus;
  readonly pricingIdentityReady: boolean;
  readonly sources: IdentityResolutionSources;
  readonly matchedAliasRuleId: string | null;
  readonly reasons: readonly string[];
}

export interface ResolvedUsageEvent {
  readonly event: UsageEvent;
  readonly resolution: IdentityResolution;
}
