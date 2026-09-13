import assert from "node:assert/strict";
import test from "node:test";
import {
  IdentityResolver,
  IdentityResolverConfigurationError
} from "../dist/src/identity/index.js";

function base(overrides = {}) {
  return {
    observedAt: "2026-09-12T12:00:00Z",
    runtime: "hermes",
    sourcePlatform: null,
    billingPlatform: null,
    inferenceProvider: null,
    requestedModel: null,
    resolvedModel: null,
    providerModelId: null,
    serviceTier: null,
    region: null,
    billingMode: null,
    ...overrides
  };
}

test("canonicalizes a billing platform only through exact platform aliases", () => {
  const resolver = new IdentityResolver();
  const result = resolver.resolve(base({ sourcePlatform: "openrouter.ai" }));
  assert.equal(result.identity.billing_platform, "openrouter");
  assert.equal(result.sources.billingPlatform, "source_platform_exact_alias");
  assert.equal(result.status, "partial");
  assert.equal(result.pricingIdentityReady, false);
});

test("direct provider platform fills inference provider without changing model text", () => {
  const resolver = new IdentityResolver();
  const result = resolver.resolve(base({
    billingPlatform: "api.openai.com",
    requestedModel: "gpt-5.6-2026-09-01",
    resolvedModel: "gpt-5.6-2026-09-01"
  }));
  assert.equal(result.identity.billing_platform, "openai");
  assert.equal(result.identity.inference_provider, "openai");
  assert.equal(result.identity.resolved_model, "gpt-5.6-2026-09-01");
  assert.equal(result.status, "exact");
  assert.equal(result.pricingIdentityReady, true);
});

test("effective-dated exact aliases resolve the same alias to the correct version", () => {
  const resolver = new IdentityResolver({
    modelAliases: [
      {
        id: "openrouter-sonnet-before-sept",
        billingPlatform: "openrouter",
        matchField: "requested_model",
        alias: "anthropic/claude-sonnet",
        resolvedModel: "anthropic/claude-sonnet-4-20250514",
        inferenceProvider: "anthropic",
        effectiveTo: "2026-09-01T00:00:00Z"
      },
      {
        id: "openrouter-sonnet-sept",
        billingPlatform: "openrouter",
        matchField: "requested_model",
        alias: "anthropic/claude-sonnet",
        resolvedModel: "anthropic/claude-sonnet-4-20260901",
        inferenceProvider: "anthropic",
        effectiveFrom: "2026-09-01T00:00:00Z"
      }
    ]
  });

  const august = resolver.resolve(base({
    observedAt: "2026-08-31T23:59:59Z",
    billingPlatform: "openrouter",
    requestedModel: "anthropic/claude-sonnet"
  }));
  assert.equal(august.identity.resolved_model, "anthropic/claude-sonnet-4-20250514");
  assert.equal(august.matchedAliasRuleId, "openrouter-sonnet-before-sept");

  const september = resolver.resolve(base({
    observedAt: "2026-09-01T00:00:00Z",
    billingPlatform: "openrouter",
    requestedModel: "anthropic/claude-sonnet"
  }));
  assert.equal(september.identity.resolved_model, "anthropic/claude-sonnet-4-20260901");
  assert.equal(september.sources.resolvedModel, "exact_model_alias");
  assert.equal(september.pricingIdentityReady, true);
});

test("overlapping exact aliases for the same platform and field are rejected at configuration time", () => {
  assert.throws(
    () => new IdentityResolver({
      modelAliases: [
        {
          id: "r1",
          billingPlatform: "openrouter",
          matchField: "requested_model",
          alias: "model-x",
          resolvedModel: "model-x-v1",
          effectiveFrom: "2026-01-01T00:00:00Z",
          effectiveTo: "2026-10-01T00:00:00Z"
        },
        {
          id: "r2",
          billingPlatform: "openrouter",
          matchField: "requested_model",
          alias: "model-x",
          resolvedModel: "model-x-v2",
          effectiveFrom: "2026-09-01T00:00:00Z"
        }
      ]
    }),
    IdentityResolverConfigurationError
  );
});

test("conflicting requested-model and provider-model exact rules become ambiguous", () => {
  const resolver = new IdentityResolver({
    modelAliases: [
      {
        id: "request-rule",
        billingPlatform: "openrouter",
        matchField: "requested_model",
        alias: "alias-x",
        resolvedModel: "provider/model-a"
      },
      {
        id: "provider-rule",
        billingPlatform: "openrouter",
        matchField: "provider_model_id",
        alias: "native-x",
        resolvedModel: "provider/model-b"
      }
    ]
  });
  const result = resolver.resolve(base({
    billingPlatform: "openrouter",
    requestedModel: "alias-x",
    providerModelId: "native-x"
  }));
  assert.equal(result.status, "ambiguous");
  assert.equal(result.pricingIdentityReady, false);
  assert.ok(result.reasons.includes("model_alias_ambiguous"));
});

test("near-name model strings are never fuzzy matched", () => {
  const resolver = new IdentityResolver({
    modelAliases: [{
      id: "exact-gpt",
      billingPlatform: "openai",
      matchField: "requested_model",
      alias: "gpt-5.6-sol",
      resolvedModel: "gpt-5.6-sol-20260901"
    }]
  });
  const result = resolver.resolve(base({
    billingPlatform: "openai",
    requestedModel: "gpt-5.6-sol-latest"
  }));
  assert.equal(result.identity.resolved_model, null);
  assert.equal(result.pricingIdentityReady, false);
  assert.ok(result.reasons.includes("requested_model_has_no_exact_alias"));
});

test("provided resolved model conflicting with exact alias is not priceable", () => {
  const resolver = new IdentityResolver({
    modelAliases: [{
      id: "alias-rule",
      billingPlatform: "openrouter",
      matchField: "requested_model",
      alias: "vendor/model",
      resolvedModel: "vendor/model-v2"
    }]
  });
  const result = resolver.resolve(base({
    billingPlatform: "openrouter",
    requestedModel: "vendor/model",
    resolvedModel: "vendor/model-v1"
  }));
  assert.equal(result.status, "ambiguous");
  assert.equal(result.pricingIdentityReady, false);
  assert.ok(result.reasons.includes("provided_resolved_model_conflicts_with_exact_alias"));
});

test("unknown source platform is not silently promoted to billing platform", () => {
  const resolver = new IdentityResolver();
  const result = resolver.resolve(base({ sourcePlatform: "mystery-gateway" }));
  assert.equal(result.identity.billing_platform, null);
  assert.equal(result.status, "unknown");
});

test("resolving an event returns a new validated event and keeps the input immutable", () => {
  const resolver = new IdentityResolver({
    modelAliases: [{
      id: "cmd-glm",
      billingPlatform: "commandcode",
      matchField: "requested_model",
      alias: "z-ai/glm-5.3-flash",
      resolvedModel: "z-ai/glm-5.3-flash",
      inferenceProvider: "z-ai"
    }]
  });
  const input = {
    schema_version: "ai-verse-token/0.1",
    event_id: "evt_identity",
    source: {
      runtime: "hermes",
      source_type: "session",
      source_platform: "commandcode.ai"
    },
    observed_at: "2026-09-12T12:00:00Z",
    identity: {
      billing_platform: null,
      requested_model: "z-ai/glm-5.3-flash",
      resolved_model: null
    },
    usage: { input_tokens: 10, output_tokens: 2 },
    timing: {},
    provenance: {
      collector_id: "hermes-passive",
      source_record_fingerprint: "0123456789abcdef",
      usage_quality: "runtime_reported",
      timing_quality: "unknown",
      content_stored: false
    }
  };
  const resolved = resolver.resolveUsageEvent(input);
  assert.equal(input.identity.billing_platform, null);
  assert.equal(input.identity.resolved_model, null);
  assert.equal(resolved.event.identity.billing_platform, "commandcode");
  assert.equal(resolved.event.identity.resolved_model, "z-ai/glm-5.3-flash");
  assert.equal(resolved.event.identity.inference_provider, "z-ai");
  assert.equal(resolved.event.identity.alias_rule_id, "cmd-glm");
  assert.equal(resolved.resolution.pricingIdentityReady, true);
});
