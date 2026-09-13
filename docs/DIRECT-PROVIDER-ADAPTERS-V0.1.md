# Direct Provider Adapters v0.1

## Purpose

Task 25 normalizes request-level usage returned directly by OpenAI, Anthropic, and Google Gemini into the canonical AI-Verse Token event protocol.

These adapters are intentionally request-response adapters, not billing reconciliation clients. They capture exact provider-reported usage and route it toward Token's verified pricing engine. They do not convert organization-level daily/hourly cost buckets into fake per-request charges.

## Shared rules

For all three providers:

- response usage is `provider_reported` usage quality;
- normal model responses do not become `ACTUAL` money because the response does not contain a provider-confirmed request charge;
- cost can become `CALCULATED` only through the existing authoritative pricing registry and effective-dated pricing engine;
- each adapter returns the registered official pricing source ID appropriate to its billing platform;
- token subcategories are decomposed so cache/reasoning subsets are not double-counted;
- impossible subset counters fail closed;
- prompt/response content is never copied into Token;
- organization-level aggregate Usage/Cost reports remain separate account facts and are not allocated across local requests.

## OpenAI Responses API

`normalizeOpenAIResponse()` consumes a completed/retrieved Responses API object with request-level `usage`.

Preserved fields include:

- response ID;
- response creation time;
- exact model ID;
- actual service tier returned by OpenAI;
- input tokens;
- cached input tokens;
- cache-write input tokens;
- output tokens;
- reasoning tokens;
- provider-reported total tokens.

OpenAI's cache and reasoning counters are subsets of the inclusive input/output counters. Token stores the mutually exclusive components:

- `input_tokens = input - cached - cache_write`;
- `cached_input_tokens = cached`;
- `cache_write_tokens = cache_write`;
- `output_tokens = output - reasoning`;
- `reasoning_tokens = reasoning`.

The adapter rejects subset overflow and a `total_tokens` value that conflicts with inclusive input + output.

Pricing source hook: `openai-official-pricing`.

## Anthropic Messages API

`normalizeAnthropicMessage()` consumes a Message response plus the observation timestamp supplied by the calling transport.

Anthropic explicitly reports its input categories additively, so Token preserves:

- uncached `input_tokens`;
- `cache_creation_input_tokens` as `cache_write_tokens`;
- `cache_read_input_tokens` as `cache_read_tokens`;
- output tokens with the thinking subset separated into `reasoning_tokens`;
- actual response `service_tier`;
- inference geography.

The `cache_creation` TTL breakdown is validated against total cache-write tokens. If all cache writes use one TTL, the adapter returns a matching pricing context of 300 seconds or 3600 seconds. If both TTLs are present, usage remains exact but the adapter returns no single TTL context. This deliberately prevents a mixed-TTL request from being rated against one tariff incorrectly.

Pricing source hook: `anthropic-official-pricing`.

## Google Gemini GenerateContent

`normalizeGoogleGeminiResponse()` consumes `GenerateContentResponse` plus the requested model and observation timestamp supplied by the caller.

Preserved fields include:

- `responseId`;
- requested model;
- provider-returned `modelVersion`;
- `usageMetadata.serviceTier`;
- effective prompt tokens;
- cached prompt tokens;
- candidate output tokens;
- thought/reasoning tokens;
- provider-reported total tokens.

Google documents `promptTokenCount` as including cached content, so Token decomposes it into uncached input plus `cached_input_tokens`. `thoughtsTokenCount` is preserved separately from visible candidate output.

The adapter permits `totalTokenCount` to be greater than the known prompt + candidates + thoughts because current Google usage metadata can contain additional categories such as tool-use prompt tokens. It only fails if the reported total is smaller than the known minimum.

Pricing source hook: `google-gemini-official-pricing`.

## Aggregate provider reports

OpenAI Organization Usage/Costs and Anthropic Usage/Cost reports are useful for independent account-level reconciliation and backfill, but they aggregate multiple requests into time buckets and dimensions.

The first release does not assign those bucket costs to individual Token events. Doing so would create artificial `ACTUAL` request prices and would conflict with the simplified scope.

## Acceptance

Task 25 passes when:

1. OpenAI cache-write/cache-read/reasoning subsets are decomposed without double counting.
2. OpenAI impossible subset or total counters fail closed.
3. Anthropic uncached/cache-write/cache-read/output/thinking usage is preserved.
4. Anthropic service tier and inference geography are preserved.
5. Single-TTL Anthropic cache writes yield a pricing context while mixed TTLs do not guess.
6. Gemini cached prompt, candidate output, thoughts, model version, and service tier are preserved.
7. Gemini impossible cached or total counters fail closed.
8. All provider adapters point only at registered authoritative official pricing-source definitions.
9. No adapter creates `ACTUAL` money from normal response usage alone.
10. The inherited suite remains green.
