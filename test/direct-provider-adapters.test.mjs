import assert from "node:assert/strict";
import test from "node:test";
import {
  ANTHROPIC_PRICING_SOURCE_ID,
  GOOGLE_GEMINI_PRICING_SOURCE_ID,
  OPENAI_PRICING_SOURCE_ID,
  normalizeAnthropicMessage,
  normalizeGoogleGeminiResponse,
  normalizeOpenAIResponse
} from "../dist/src/adapters/index.js";

test("OpenAI Responses usage decomposes cached/cache-write/reasoning subsets without double counting", () => {
  const result = normalizeOpenAIResponse({
    id: "resp_1",
    created_at: 1789200000,
    model: "gpt-5.6-sol-2026-09-01",
    service_tier: "priority",
    usage: {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 },
      output_tokens: 300,
      output_tokens_details: { reasoning_tokens: 200 },
      total_tokens: 1300
    }
  });
  assert.equal(result.pricing_source_id, OPENAI_PRICING_SOURCE_ID);
  assert.equal(result.event.identity.billing_platform, "openai");
  assert.equal(result.event.identity.service_tier, "priority");
  assert.deepEqual(result.event.usage, {
    context_input_tokens: 1000,
    input_tokens: 300,
    output_tokens: 100,
    cached_input_tokens: 600,
    cache_write_tokens: 100,
    reasoning_tokens: 200,
    total_tokens_reported: 1300
  });
  assert.equal(result.event.actual_charge, undefined);
});

test("OpenAI response rejects impossible subset and total counters", () => {
  assert.throws(() => normalizeOpenAIResponse({
    id: "resp_bad", created_at: 1789200000, model: "gpt-5.6-sol",
    usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 8, cache_write_tokens: 3 }, output_tokens: 1, total_tokens: 11 }
  }), (error) => error?.code === "REMOTE_USAGE_INVALID");
  assert.throws(() => normalizeOpenAIResponse({
    id: "resp_bad2", created_at: 1789200000, model: "gpt-5.6-sol",
    usage: { input_tokens: 10, output_tokens: 1, total_tokens: 999 }
  }), (error) => error?.code === "REMOTE_USAGE_INVALID");
});

test("Anthropic Message preserves uncached/cache-write/cache-read/service-tier/region usage", () => {
  const result = normalizeAnthropicMessage({
    id: "msg_1",
    model: "claude-opus-5",
    usage: {
      input_tokens: 120,
      cache_creation_input_tokens: 500,
      cache_read_input_tokens: 1000,
      cache_creation: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 },
      output_tokens: 200,
      output_tokens_details: { thinking_tokens: 80 },
      service_tier: "priority",
      inference_geo: "us"
    }
  }, { observedAt: "2026-09-12T18:00:00Z" });
  assert.equal(result.pricing_source_id, ANTHROPIC_PRICING_SOURCE_ID);
  assert.deepEqual(result.event.usage, {
    context_input_tokens: 1620,
    input_tokens: 120,
    output_tokens: 120,
    cache_write_tokens: 500,
    cache_read_tokens: 1000,
    reasoning_tokens: 80
  });
  assert.equal(result.event.identity.service_tier, "priority");
  assert.equal(result.event.identity.region, "us");
  assert.deepEqual(result.pricing_context, { cache_ttl_seconds: 3600 });
  assert.equal(result.event.actual_charge, undefined);
});

test("Anthropic mixed cache TTL remains exact usage but deliberately has no single pricing TTL", () => {
  const result = normalizeAnthropicMessage({
    id: "msg_mix", model: "claude-sonnet-5",
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 20,
      cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 20 },
      output_tokens: 5
    }
  }, { observedAt: "2026-09-12T18:00:00Z" });
  assert.equal(result.pricing_context, null);
  assert.equal(result.event.usage.cache_write_tokens, 30);
});

test("Anthropic rejects inconsistent TTL breakdown and impossible thinking subset", () => {
  assert.throws(() => normalizeAnthropicMessage({
    id: "msg_bad", model: "claude-sonnet-5",
    usage: { input_tokens: 1, cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 9, ephemeral_5m_input_tokens: 0 }, output_tokens: 1 }
  }, { observedAt: "2026-09-12T18:00:00Z" }), (error) => error?.code === "REMOTE_USAGE_INVALID");
  assert.throws(() => normalizeAnthropicMessage({
    id: "msg_bad2", model: "claude-sonnet-5",
    usage: { input_tokens: 1, output_tokens: 2, output_tokens_details: { thinking_tokens: 3 } }
  }, { observedAt: "2026-09-12T18:00:00Z" }), (error) => error?.code === "REMOTE_USAGE_INVALID");
});

test("Google Gemini response decomposes cached prompt tokens and preserves thoughts/service tier", () => {
  const result = normalizeGoogleGeminiResponse({
    responseId: "resp-google-1",
    modelVersion: "models/gemini-3.8-flash-202609",
    usageMetadata: {
      promptTokenCount: 1000,
      cachedContentTokenCount: 700,
      candidatesTokenCount: 80,
      thoughtsTokenCount: 120,
      totalTokenCount: 1200,
      serviceTier: "PRIORITY"
    }
  }, { observedAt: "2026-09-12T18:00:00Z", requestedModel: "models/gemini-3.8-flash" });
  assert.equal(result.pricing_source_id, GOOGLE_GEMINI_PRICING_SOURCE_ID);
  assert.equal(result.event.identity.requested_model, "gemini-3.8-flash");
  assert.equal(result.event.identity.resolved_model, "gemini-3.8-flash-202609");
  assert.equal(result.event.identity.provider_model_id, "models/gemini-3.8-flash-202609");
  assert.equal(result.event.identity.service_tier, "PRIORITY");
  assert.deepEqual(result.event.usage, {
    context_input_tokens: 1000,
    input_tokens: 300,
    output_tokens: 80,
    cached_input_tokens: 700,
    reasoning_tokens: 120,
    total_tokens_reported: 1200
  });
  assert.equal(result.event.actual_charge, undefined);
});

test("Google Gemini rejects cached prompt overflow and impossible reported total", () => {
  assert.throws(() => normalizeGoogleGeminiResponse({
    responseId: "r1", modelVersion: "gemini", usageMetadata: { promptTokenCount: 4, cachedContentTokenCount: 5, candidatesTokenCount: 1 }
  }, { observedAt: "2026-09-12T18:00:00Z", requestedModel: "gemini" }), (error) => error?.code === "REMOTE_USAGE_INVALID");
  assert.throws(() => normalizeGoogleGeminiResponse({
    responseId: "r2", modelVersion: "gemini", usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, thoughtsTokenCount: 2, totalTokenCount: 8 }
  }, { observedAt: "2026-09-12T18:00:00Z", requestedModel: "gemini" }), (error) => error?.code === "REMOTE_USAGE_INVALID");
});

import { createDefaultPricingSourceRegistry } from "../dist/src/pricing/index.js";

test("direct-provider adapters point only at registered authoritative official pricing sources", () => {
  const registry = createDefaultPricingSourceRegistry();
  for (const sourceId of [OPENAI_PRICING_SOURCE_ID, ANTHROPIC_PRICING_SOURCE_ID, GOOGLE_GEMINI_PRICING_SOURCE_ID]) {
    const source = registry.source(sourceId);
    assert.ok(source, `missing pricing source ${sourceId}`);
    assert.equal(source.authority, "official_public_pricing");
  }
});

test("Anthropic preserves exact provider-reported web search request units", () => {
  const result = normalizeAnthropicMessage({
    id: "msg_search",
    model: "claude-sonnet-5",
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      server_tool_use: { web_search_requests: 3 }
    }
  }, { observedAt: "2026-09-12T18:00:00Z" });
  assert.equal(result.event.usage.web_search_units, 3);
  assert.equal(result.event.usage.context_input_tokens, 10);
});
