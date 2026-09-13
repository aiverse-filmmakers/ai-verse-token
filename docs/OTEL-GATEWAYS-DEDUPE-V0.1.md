# OpenTelemetry, Gateways and Cross-Source Dedupe v0.1

Task 26 defines the first-release observability and gateway boundary for AI-Verse Token.

## Scope

Supported first-release normalization surfaces:

- OpenTelemetry GenAI spans using current `gen_ai.*` semantic attributes;
- LiteLLM spend/request logs;
- Bifrost request logs;
- generic OpenAI-compatible gateway responses.

These surfaces provide telemetry. They do not become billing authority merely because they expose a `cost` or `spend` field.

## OpenTelemetry rules

The adapter accepts map-style and OTLP key/value attributes. It normalizes:

- `gen_ai.operation.name`;
- `gen_ai.provider.name`;
- `gen_ai.request.model`;
- `gen_ai.response.model`;
- `gen_ai.response.id`;
- input/output token usage;
- cache creation/read token subsets;
- reasoning output subsets;
- span wall time;
- time to first chunk when present.

OpenTelemetry `provider.name` is inference/provider evidence, not automatically the billing platform. Billing authority must be supplied from trusted host context when known.

Sensitive content attributes such as input messages, output messages, instructions, tool arguments and tool results are ignored and never copied into canonical Token events.

A trace ID alone never proves two spans are the same model call. The exact `(trace_id, span_id)` pair is retained as diagnostic correlation. A provider response ID can be used as a strong cross-source key.

## Gateway money rules

LiteLLM and Bifrost cost/spend fields are retained only as adapter diagnostics. They are not attached to `actual_charge` because gateway cost values can be calculated from gateway model catalogs, overrides or incomplete streaming records.

Provider-confirmed money still enters through the trusted `ACTUAL` source registry built in Tasks 19, 24 and later provider-specific sources.

## LiteLLM cache hits

A confirmed LiteLLM gateway cache hit represents a gateway request without a new upstream model call. Some spend-log paths can replay the original response token columns on the cache-hit row.

Token therefore records exact zero upstream model tokens plus one gateway request unit for a confirmed cache hit. It never counts the replayed original token columns as new model consumption.

## Bifrost streaming zero protection

A streaming Bifrost row with both input and output token counters at zero is not accepted as proof of a zero-token model call. Current gateway logging paths can persist zero usage while the streamed provider response contains usage later.

Token preserves the request observation but leaves model token usage unknown.

## Exact cross-source dedupe

Raw observations remain immutable in `usage_events`.

When observations from different collectors share a strong key and their exact facts do not conflict, Token creates a derived canonical event and appends supersession records for the source observations.

Strong first-release keys are:

- `request_id`;
- `response_id`;
- `upstream_request_id`;
- `external_charge_id`.

Weak similarity such as same trace, close timestamps, same model, same token count or same session does not authorize dedupe.

Normal query and aggregate surfaces automatically exclude superseded observations. Raw rows remain available as audit evidence in the ledger.

If strongly correlated observations disagree on exact overlapping usage, strict identity, scope or actual charge facts, ingest fails closed and the new transaction is rolled back. Token does not guess which conflicting record is correct.

## Canonical merge rules

- exact local scope is preserved when compatible;
- provider-reported usage outranks runtime-reported usage;
- direct provider telemetry outranks OpenTelemetry for usage when both are otherwise provider-reported;
- trusted actual charge is preserved;
- timing is selected from the strongest available timing source without adding durations together;
- correlation keys from all merged observations are carried forward;
- derived canonical events contain no prompt/response content.

## Storage invariants

`event_supersessions` is append-only at the SQLite level. Update and delete triggers reject mutation.

Replaying a raw source observation that was already superseded does not create another canonical chain.

## Acceptance proof

Task 26 acceptance covers:

- OTel cache/reasoning decomposition;
- OTLP attribute and nanosecond-time support;
- sensitive content omission;
- LiteLLM cache-hit replay protection;
- gateway calculated-cost separation from `ACTUAL`;
- Bifrost streaming-zero distrust;
- generic gateway normalization;
- three-source exact correlation collapsing to one queryable call;
- raw observation preservation;
- aggregate no-double-counting;
- conflicting exact usage rollback;
- trace-only non-dedupe;
- append-only supersession state;
- superseded replay idempotency.

Full inherited suite at Task 26: 176 / 176 passing.
