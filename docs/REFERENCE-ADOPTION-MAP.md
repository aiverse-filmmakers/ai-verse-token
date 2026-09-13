# Reference Adoption Map

> First-release scope note (2026-09-12): the research below intentionally records broader financial-grade possibilities. Invoice reconciliation, private contracts, subscription settlement and credit-ledger accounting are deferred. The canonical first-release scope is `docs/FIRST-RELEASE-SCOPE.md`.


This document records what AI-Verse Token should adopt, adapt, integrate with, study, or explicitly avoid.

## Adopt as core ideas

| Reference | Adopt |
|---|---|
| Tokscale | passive runtime discovery, collector-per-source, hourly/minutely rollups, Hermes reader patterns |
| CodeBurn | task/tool/agent attribution, provider dedupe, MCP read surface, retry/yield signals, quota adapters |
| ccusage | unified reports, sessions/billing windows, explicit cost provenance/modes |
| Pydantic genai-prices | effective-dated rules, historical tariffs, time/context constraints, matching structure |
| Portkey Models | broad billing-unit vocabulary and provider/model configuration catalog |
| LiteLLM | provider normalization, service-tier metadata, hierarchical budgets, spend tags |
| OpenLIT | OTel GenAI timing/token semantics, TTFT/TBT/duration metrics |
| Langfuse | trace hierarchy and provided-vs-derived usage/cost separation |
| OpenMeter | immutable idempotent events, meter aggregation, dimensional usage queries |
| Bifrost | provider/gateway timing separation, route metadata, live request accounting |

## Adapt rather than copy

### Pricing

Third-party price catalogs become **inputs to verification**, not the final authority.

AI-Verse strict priority:

```text
provider/platform per-request billed cost
  > provider billing/usage reconciliation API
  > explicit account/contract tariff
  > official platform tariff matching all dimensions
  > UNPRICED
```

Portkey/Pydantic/LiteLLM/OpenRouter public data may discover/cross-check tariffs, but strict mode must not silently turn ambiguous matches into exact spend.

### Model matching

Use exact identifiers and versioned alias mappings first.

Fuzzy matching may be used only to propose a candidate for operator/debug inspection. It may never produce authoritative cost.

### Active time

Do not copy session “activity” heuristics that convert timestamp gaps into claimed active time without proof.

If request intervals exist, compute the mathematical union of intervals. If not, expose `session_span` and mark `active_time` unavailable.

## Integrate through standards

### OpenTelemetry

Canonical request/timing fields should map to current GenAI semantic conventions where possible:

```text
gen_ai.system
gen_ai.request.model
gen_ai.response.model
gen_ai.usage.input_tokens
gen_ai.usage.output_tokens
gen_ai.client.token.usage
gen_ai.client.operation.duration
gen_ai.server.time_to_first_token
gen_ai.server.time_per_output_token
```

AI-Verse-specific extensions should use their own namespace and never redefine standard names with different semantics.

### MCP

Provide a read-only MCP server so Hermes and other agents can query their own usage/cost/time without direct SQLite access.

Suggested tools:

```text
get_usage
get_cost
get_time
get_request
get_top_consumers
get_budget_status
get_pricing_status
```

No default mutation or payment action should be exposed over MCP.

## Study but do not make mandatory

- Helicone gateway/UX
- OpenLLMetry instrumentation packages
- provider usage/cost APIs
- provider model catalogs
- billing exports
- local menubar/TUI experiences

## Explicitly avoid

1. Mandatory proxying of all LLM traffic.
2. Dashboard ownership in this repository.
3. Raw prompts/responses in the token ledger by default.
4. Fuzzy model pricing in authoritative mode.
5. Repricing old usage with the newest price table.
6. Treating `estimated_cost_usd` as `actual_cost_usd`.
7. Treating monthly subscription allocation per request as exact unless the platform supplies that allocation.
8. Double-counting parallel call durations as human/agent active wall time.
9. Letting Dashboard or AI-Verse Data open Token's SQLite file directly.
10. Writing into sibling AI-Verse repositories during normal install.
