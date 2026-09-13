import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeCommandCodeUsageRecord,
  normalizeCommandCodeUsageWindows,
  normalizeOpenRouterGeneration
} from "../dist/src/adapters/index.js";

test("OpenRouter generation metadata becomes provider-reported usage with ACTUAL total cost", () => {
  const result = normalizeOpenRouterGeneration({
    data: {
      id: "gen-1",
      upstream_id: "chatcmpl-upstream",
      total_cost: 0.0015,
      created_at: "2026-09-12T10:00:00+00:00",
      model: "anthropic/claude-sonnet-5",
      router: "openrouter/auto",
      provider_name: "Anthropic",
      data_region: "global",
      service_tier: "priority",
      api_type: "responses",
      request_id: "req-1",
      session_id: "session-1",
      native_tokens_prompt: 100,
      native_tokens_cached: 70,
      native_tokens_completion: 30,
      native_tokens_reasoning: 10,
      generation_time: 812.5,
      provider_responses: [{ model_permaslug: "anthropic/claude-sonnet-5-20260901" }]
    }
  });
  const event = result.event;
  assert.equal(event.identity.billing_platform, "openrouter");
  assert.equal(event.identity.requested_model, "openrouter/auto");
  assert.equal(event.identity.resolved_model, "anthropic/claude-sonnet-5");
  assert.equal(event.identity.provider_model_id, "anthropic/claude-sonnet-5-20260901");
  assert.equal(event.identity.inference_provider, "Anthropic");
  assert.equal(event.identity.service_tier, "priority");
  assert.equal(event.request_id, "req-1");
  assert.deepEqual(event.usage, {
    context_input_tokens: 100,
    input_tokens: 30,
    output_tokens: 20,
    cached_input_tokens: 70,
    reasoning_tokens: 10,
    total_tokens_reported: 130
  });
  assert.deepEqual(event.timing, { generation_ms: 812.5 });
  assert.deepEqual(event.actual_charge, {
    amount: "0.0015",
    currency: "USD",
    source: "provider_reported",
    external_charge_id: "gen-1",
    reported_at: "2026-09-12T10:00:00.000Z"
  });
});

test("OpenRouter falls back to normalized token totals but never invents missing cache/reasoning", () => {
  const event = normalizeOpenRouterGeneration({ data: {
    id: "gen-2", created_at: "2026-09-12T10:00:00Z", model: "openai/gpt-5.5",
    tokens_prompt: 12, tokens_completion: 8, total_cost: 0
  }}).event;
  assert.deepEqual(event.usage, { context_input_tokens: 12, input_tokens: 12, output_tokens: 8, total_tokens_reported: 20 });
  assert.equal(event.actual_charge?.amount, "0");
});

test("OpenRouter rejects impossible native subset counters", () => {
  assert.throws(() => normalizeOpenRouterGeneration({ data: {
    id: "gen-bad", created_at: "2026-09-12T10:00:00Z", model: "m",
    native_tokens_prompt: 5, native_tokens_cached: 6, native_tokens_completion: 1
  }}), (error) => error?.code === "REMOTE_USAGE_INVALID");
});

test("Command Code usage record preserves request tokens/model and provider-reported request cost", () => {
  const result = normalizeCommandCodeUsageRecord({
    id: "usage-1",
    createdAt: "2026-09-12T11:00:00Z",
    modelId: "z-ai/glm-5.3-flash",
    provider: "z-ai",
    planType: "goat",
    sessionId: "cmd-session",
    tokens: { input: 4, output: 3, cacheRead: 100, cacheWrite: 0, reasoning: 2, total: 109 },
    costUsd: 0.00042
  });
  const event = result.event;
  assert.equal(event.identity.billing_platform, "commandcode");
  assert.equal(event.identity.inference_provider, "z-ai");
  assert.equal(event.identity.requested_model, "z-ai/glm-5.3-flash");
  assert.equal(event.identity.billing_mode, "goat");
  assert.deepEqual(event.usage, {
    input_tokens: 4,
    output_tokens: 3,
    cache_read_tokens: 100,
    cache_write_tokens: 0,
    reasoning_tokens: 2,
    total_tokens_reported: 109
  });
  assert.equal(event.actual_charge?.amount, "0.00042");
  assert.equal(event.actual_charge?.source, "provider_reported");
});

test("Command Code record without reported cost remains cost-unknown rather than zero", () => {
  const event = normalizeCommandCodeUsageRecord({
    request_id: "usage-2", created_at: "2026-09-12T11:00:00Z", model: "deepseek/deepseek-v4-flash",
    usage: { input_tokens: 10, output_tokens: 2 }
  }).event;
  assert.equal(event.actual_charge, undefined);
});

test("Command Code aliases fail closed when two fields disagree", () => {
  assert.throws(() => normalizeCommandCodeUsageRecord({
    id: "one", requestId: "two", createdAt: "2026-09-12T11:00:00Z", model: "m",
    tokens: { input: 1 }
  }), (error) => error?.code === "REMOTE_RECORD_INVALID");
});

test("Command Code rolling usage windows remain capacity facts, not request-cost accounting", () => {
  const snapshot = normalizeCommandCodeUsageWindows({
    observedAt: "2026-09-12T12:00:00Z",
    planType: "GOAT",
    windows: [
      { kind: "five_hour", used: 4.5, limit: 14, resetsAt: "2026-09-12T15:00:00Z" },
      { kind: "weekly", used: 20, limit: 35, resets_at: "2026-09-17T10:00:00Z" }
    ]
  });
  assert.equal(snapshot.plan, "GOAT");
  assert.deepEqual(snapshot.windows.map((w) => [w.kind, w.used, w.limit]), [
    ["five_hour", 4.5, 14], ["weekly", 20, 35]
  ]);
});

test("Command Code window snapshot rejects impossible over-limit normalized data", () => {
  assert.throws(() => normalizeCommandCodeUsageWindows({
    observed_at: "2026-09-12T12:00:00Z",
    windows: [{ kind: "weekly", used: 36, limit: 35 }]
  }), (error) => error?.code === "REMOTE_WINDOW_INVALID");
});
