# Remote Usage Adapters v0.1

## Purpose

Task 24 adds strict normalization adapters for remote usage sources that can expose better billing-route facts than local runtime logs. These adapters do not own credentials, perform scheduling, or turn aggregate account charges into per-request money.

The first supported sources are:

- OpenRouter generation metadata;
- Command Code Studio/internal usage-shaped records supplied through an external authenticated transport.

## Boundary

A remote adapter converts one source record into AI-Verse Token protocol data. It does not:

- store API keys, session cookies, or credentials;
- discover credentials;
- assume a private/internal endpoint is stable;
- amortize subscriptions or plan fees;
- distribute aggregate account spend across requests;
- override a trusted `ACTUAL` charge with a calculated estimate;
- store prompts, responses, or source content.

Credentials and authenticated transport remain host/Connections concerns. Token accepts already-fetched records and validates them strictly.

## OpenRouter

`normalizeOpenRouterGeneration()` accepts the documented generation metadata envelope or its `data` object.

It preserves, where exposed:

- generation/request/session identifiers;
- requested router model and resolved model;
- provider name;
- service tier;
- data region;
- native prompt/completion/cache/reasoning token counters;
- generation duration;
- provider-reported `total_cost`.

When native cache or reasoning counters are present, they are treated as subsets of native prompt/output counters and impossible values fail closed.

A provider-reported `total_cost`, including a real zero, is attached only through the trusted `openrouter-generation-api` actual-cost source. Currency remains USD because the generation contract reports dollar cost.

If only normalized prompt/completion totals are present, those can still become usage facts. Missing cache/reasoning dimensions remain unknown rather than becoming zero.

## Command Code

Command Code exposes useful request/token/cost facts in Studio and rolling usage/limit information, but its currently evidenced history route is internal rather than a stable public API. AI-Verse Token therefore does not hard-code that private route.

`normalizeCommandCodeUsageRecord()` accepts a strict usage-record object supplied by a host-controlled transport. A small alias vocabulary handles known snake_case/camelCase variations. If duplicate aliases disagree, normalization fails closed.

The adapter can preserve:

- request/usage ID;
- timestamp;
- model;
- inference provider;
- service tier;
- session ID;
- plan metadata;
- input/output/cache-read/cache-write/reasoning token counters;
- provider-reported request cost when exposed.

A reported request cost is accepted as `ACTUAL` only through the trusted `commandcode-usage-api` source. Absence of cost remains unknown. It is never replaced by `$0`.

`normalizeCommandCodeUsageWindows()` separately represents rolling plan/capacity facts such as five-hour, weekly, or monthly windows. These values are not request charges and are never amortized into cost.

## Attribution

The adapters preserve the financial route separately from the runtime/provider identity:

- OpenRouter observations use `billing_platform = openrouter`;
- Command Code observations use `billing_platform = commandcode`;
- `inference_provider` remains the provider reported by the source;
- `runtime` identifies the observation surface, not necessarily the underlying inference vendor.

This keeps routes such as `Hermes -> OpenRouter -> Anthropic` financially distinct from `Hermes -> Anthropic direct`.

## Timing

Remote fields are only mapped when their semantics are sufficiently clear.

For OpenRouter, `generation_time` becomes `generation_ms`. The adapter deliberately does not manufacture TTFT, queue, or wall-clock timing from fields whose semantics are not guaranteed to match Token's timing contract.

Task 27 owns richer timing interpretation.

## Security and failure behavior

Adapters fail closed for:

- malformed date-times;
- negative or unsafe token counters;
- contradictory aliases;
- impossible cache/reasoning subset counters;
- malformed or negative money;
- invalid rolling-window ranges;
- duplicate rolling-window kinds;
- source/platform mismatches in trusted actual-cost ingestion.

No adapter stores prompt/response content or credentials.

## Acceptance

Task 24 passes when:

1. OpenRouter native usage is normalized without double-counting cache/reasoning subsets.
2. OpenRouter provider-reported cost is eligible for trusted `ACTUAL` status.
3. Normalized fallback token totals do not invent missing subcategories.
4. Command Code request records preserve model/provider/token attribution.
5. Command Code reported request cost is trusted only through the registered source.
6. Missing Command Code cost stays unknown.
7. Alias conflicts fail closed.
8. Rolling usage windows remain capacity facts rather than subscription accounting.
9. The inherited suite remains green.
