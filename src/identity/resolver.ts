import { validateUsageEvent } from "../protocol/validation.js";
import type {
  ExactModelAliasRule,
  IdentityFieldSource,
  IdentityResolution,
  IdentityResolutionInput,
  IdentityResolverConfig,
  PlatformAliasRule,
  ResolvedUsageEvent
} from "./types.js";

const DEFAULT_PLATFORM_ALIASES: readonly PlatformAliasRule[] = Object.freeze([
  { alias: "openai", canonical: "openai" },
  { alias: "api.openai.com", canonical: "openai" },
  { alias: "anthropic", canonical: "anthropic" },
  { alias: "api.anthropic.com", canonical: "anthropic" },
  { alias: "google", canonical: "google" },
  { alias: "gemini", canonical: "google" },
  { alias: "generativelanguage.googleapis.com", canonical: "google" },
  { alias: "openrouter", canonical: "openrouter" },
  { alias: "openrouter.ai", canonical: "openrouter" },
  { alias: "commandcode", canonical: "commandcode" },
  { alias: "commandcode.ai", canonical: "commandcode" },
  { alias: "z-ai", canonical: "z-ai" },
  { alias: "z.ai", canonical: "z-ai" }
]);

const DIRECT_PLATFORM_PROVIDER: Readonly<Record<string, string>> = Object.freeze({
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  "z-ai": "z-ai"
});

const SAFE_VALUE_MAX = 500;
const RULE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export class IdentityResolverConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityResolverConfigurationError";
  }
}

function bounded(value: string, label: string, max = SAFE_VALUE_MAX): string {
  if (value.length < 1 || value.length > max || value.includes("\u0000")) {
    throw new IdentityResolverConfigurationError(`${label} must be 1..${max} characters without NUL`);
  }
  return value;
}

function parseDateTime(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new IdentityResolverConfigurationError(`${label} must be a timezone-aware ISO 8601 date-time`);
  }
  return parsed;
}

function normalizePlatformRules(extra: readonly PlatformAliasRule[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const rule of [...DEFAULT_PLATFORM_ALIASES, ...(extra ?? [])]) {
    const alias = bounded(rule.alias, "platform alias", 200);
    const canonical = bounded(rule.canonical, "canonical platform", 200);
    const existing = map.get(alias);
    if (existing !== undefined && existing !== canonical) {
      throw new IdentityResolverConfigurationError(
        `platform alias ${alias} maps to both ${existing} and ${canonical}`
      );
    }
    map.set(alias, canonical);
  }
  return map;
}

interface PreparedModelRule extends ExactModelAliasRule {
  readonly fromMs: number;
  readonly toMs: number;
}

function prepareModelRules(rules: readonly ExactModelAliasRule[] | undefined): PreparedModelRule[] {
  const ids = new Set<string>();
  const prepared = (rules ?? []).map((rule) => {
    if (!RULE_ID_RE.test(rule.id)) {
      throw new IdentityResolverConfigurationError(`model alias rule id is invalid: ${rule.id}`);
    }
    if (ids.has(rule.id)) {
      throw new IdentityResolverConfigurationError(`duplicate model alias rule id: ${rule.id}`);
    }
    ids.add(rule.id);
    bounded(rule.billingPlatform, `rule ${rule.id} billingPlatform`, 200);
    bounded(rule.alias, `rule ${rule.id} alias`);
    bounded(rule.resolvedModel, `rule ${rule.id} resolvedModel`);
    if (rule.inferenceProvider != null) bounded(rule.inferenceProvider, `rule ${rule.id} inferenceProvider`, 200);
    if (rule.providerModelId != null) bounded(rule.providerModelId, `rule ${rule.id} providerModelId`);
    const fromMs = rule.effectiveFrom == null ? Number.NEGATIVE_INFINITY : parseDateTime(rule.effectiveFrom, `rule ${rule.id} effectiveFrom`);
    const toMs = rule.effectiveTo == null ? Number.POSITIVE_INFINITY : parseDateTime(rule.effectiveTo, `rule ${rule.id} effectiveTo`);
    if (fromMs >= toMs) {
      throw new IdentityResolverConfigurationError(`rule ${rule.id} effective interval must have from < to`);
    }
    return { ...rule, fromMs, toMs };
  });

  for (let i = 0; i < prepared.length; i += 1) {
    const left = prepared[i];
    if (left === undefined) continue;
    for (let j = i + 1; j < prepared.length; j += 1) {
      const right = prepared[j];
      if (right === undefined) continue;
      const sameKey =
        left.billingPlatform === right.billingPlatform &&
        left.matchField === right.matchField &&
        left.alias === right.alias;
      if (!sameKey) continue;
      const overlaps = left.fromMs < right.toMs && right.fromMs < left.toMs;
      if (overlaps) {
        throw new IdentityResolverConfigurationError(
          `model alias rules ${left.id} and ${right.id} overlap for the same exact alias`
        );
      }
    }
  }

  return prepared;
}

function active(rule: PreparedModelRule, observedMs: number): boolean {
  return rule.fromMs <= observedMs && observedMs < rule.toMs;
}

function canonicalPlatform(
  value: string | null | undefined,
  aliases: ReadonlyMap<string, string>
): string | null {
  if (value == null) return null;
  return aliases.get(value) ?? value;
}

function sourceForPlatform(
  supplied: string | null | undefined,
  sourcePlatform: string | null | undefined,
  aliases: ReadonlyMap<string, string>
): { value: string | null; source: IdentityFieldSource } {
  if (supplied != null) return { value: canonicalPlatform(supplied, aliases), source: "provided" };
  if (sourcePlatform != null) {
    const exact = aliases.get(sourcePlatform);
    if (exact !== undefined) return { value: exact, source: "source_platform_exact_alias" };
  }
  return { value: null, source: "unknown" };
}

function matchModelRules(
  rules: readonly PreparedModelRule[],
  billingPlatform: string | null,
  input: IdentityResolutionInput,
  observedMs: number
): PreparedModelRule[] {
  if (billingPlatform === null) return [];
  return rules.filter((rule) => {
    if (rule.billingPlatform !== billingPlatform || !active(rule, observedMs)) return false;
    const candidate = rule.matchField === "requested_model" ? input.requestedModel : input.providerModelId;
    return candidate != null && candidate === rule.alias;
  });
}

function uniqueModelTargets(rules: readonly PreparedModelRule[]): Set<string> {
  return new Set(rules.map((rule) => `${rule.resolvedModel}\u0000${rule.inferenceProvider ?? ""}\u0000${rule.providerModelId ?? ""}`));
}

export class IdentityResolver {
  readonly #platformAliases: ReadonlyMap<string, string>;
  readonly #modelAliases: readonly PreparedModelRule[];

  constructor(config: IdentityResolverConfig = {}) {
    this.#platformAliases = normalizePlatformRules(config.platformAliases);
    this.#modelAliases = prepareModelRules(config.modelAliases);
  }

  resolve(input: IdentityResolutionInput): IdentityResolution {
    const observedMs = parseDateTime(input.observedAt, "observedAt");
    bounded(input.runtime, "runtime", 200);

    const reasons: string[] = [];
    const platform = sourceForPlatform(input.billingPlatform, input.sourcePlatform, this.#platformAliases);
    const rules = matchModelRules(this.#modelAliases, platform.value, input, observedMs);
    const uniqueTargets = uniqueModelTargets(rules);
    const aliasAmbiguous = uniqueTargets.size > 1;
    const aliasRule = !aliasAmbiguous && rules.length > 0 ? rules[0] ?? null : null;

    let resolvedModel = input.resolvedModel ?? null;
    let resolvedModelSource: IdentityFieldSource = resolvedModel === null ? "unknown" : "provided";
    let matchedAliasRuleId: string | null = input.aliasRuleId ?? null;
    let conflict = false;

    if (aliasAmbiguous) {
      reasons.push("model_alias_ambiguous");
    } else if (aliasRule !== null) {
      if (resolvedModel !== null && resolvedModel !== aliasRule.resolvedModel) {
        reasons.push("provided_resolved_model_conflicts_with_exact_alias");
        conflict = true;
      } else if (resolvedModel === null) {
        resolvedModel = aliasRule.resolvedModel;
        resolvedModelSource = "exact_model_alias";
      }
      matchedAliasRuleId = aliasRule.id;
    }

    let inferenceProvider = input.inferenceProvider ?? null;
    let inferenceProviderSource: IdentityFieldSource = inferenceProvider === null ? "unknown" : "provided";
    if (aliasRule?.inferenceProvider != null) {
      if (inferenceProvider !== null && inferenceProvider !== aliasRule.inferenceProvider) {
        reasons.push("provided_inference_provider_conflicts_with_exact_alias");
        conflict = true;
      } else if (inferenceProvider === null) {
        inferenceProvider = aliasRule.inferenceProvider;
        inferenceProviderSource = "exact_model_alias";
      }
    }
    if (inferenceProvider === null && platform.value !== null) {
      const direct = DIRECT_PLATFORM_PROVIDER[platform.value];
      if (direct !== undefined) {
        inferenceProvider = direct;
        inferenceProviderSource = "direct_platform";
      }
    }

    let providerModelId = input.providerModelId ?? null;
    if (aliasRule?.providerModelId != null) {
      if (providerModelId !== null && providerModelId !== aliasRule.providerModelId) {
        reasons.push("provided_provider_model_id_conflicts_with_exact_alias");
        conflict = true;
      } else if (providerModelId === null) {
        providerModelId = aliasRule.providerModelId;
      }
    }

    if (platform.value === null) reasons.push("billing_platform_unknown");
    if (resolvedModel === null) reasons.push("resolved_model_unknown");
    if (input.requestedModel !== null && input.requestedModel !== undefined && aliasRule === null && resolvedModel === null) {
      reasons.push("requested_model_has_no_exact_alias");
    }

    const ambiguous = aliasAmbiguous || conflict;
    const pricingIdentityReady = !ambiguous && platform.value !== null && resolvedModel !== null;
    let status: IdentityResolution["status"];
    if (ambiguous) status = "ambiguous";
    else if (pricingIdentityReady) status = "exact";
    else if (platform.value !== null || resolvedModel !== null || inferenceProvider !== null) status = "partial";
    else status = "unknown";

    return {
      identity: {
        billing_platform: platform.value,
        inference_provider: inferenceProvider,
        requested_model: input.requestedModel ?? null,
        resolved_model: resolvedModel,
        provider_model_id: providerModelId,
        service_tier: input.serviceTier ?? null,
        region: input.region ?? null,
        billing_mode: input.billingMode ?? null,
        alias_rule_id: matchedAliasRuleId
      },
      status,
      pricingIdentityReady,
      sources: {
        billingPlatform: platform.source,
        inferenceProvider: inferenceProviderSource,
        resolvedModel: resolvedModelSource
      },
      matchedAliasRuleId,
      reasons
    };
  }

  resolveUsageEvent(value: unknown): ResolvedUsageEvent {
    const event = validateUsageEvent(value);
    const resolution = this.resolve({
      observedAt: event.observed_at,
      runtime: event.source.runtime,
      sourcePlatform: event.source.source_platform ?? null,
      billingPlatform: event.identity.billing_platform,
      inferenceProvider: event.identity.inference_provider ?? null,
      requestedModel: event.identity.requested_model,
      resolvedModel: event.identity.resolved_model,
      providerModelId: event.identity.provider_model_id ?? null,
      serviceTier: event.identity.service_tier ?? null,
      region: event.identity.region ?? null,
      billingMode: event.identity.billing_mode ?? null,
      aliasRuleId: event.identity.alias_rule_id ?? null
    });

    const resolved = validateUsageEvent({ ...event, identity: resolution.identity });
    return { event: resolved, resolution };
  }
}

export function getDefaultPlatformAliases(): readonly PlatformAliasRule[] {
  return DEFAULT_PLATFORM_ALIASES;
}
