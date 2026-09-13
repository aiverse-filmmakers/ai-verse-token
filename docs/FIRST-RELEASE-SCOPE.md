# AI-Verse Token First-Release Scope

**Decision date:** 2026-09-12

AI-Verse Token will ship as a best-in-class usage intelligence engine, not as a financial reconciliation platform.

## First-release promise

AI-Verse Token should answer, with explicit provenance:

- what runtime, billing platform, inference provider and model were used;
- how many input, output, cache and reasoning tokens were consumed;
- how long requests, sessions and active AI work took;
- what each request, session, model, agent, project and workspace cost;
- whether that monetary value is `ACTUAL`, `CALCULATED` or `UNKNOWN`;
- which source produced each fact;
- whether duplicate observations refer to the same underlying request;
- how usage changes by request, hour, day, session, model, provider, agent and workspace.

## Cost truth model

### ACTUAL

Use this when the billing platform or trusted runtime supplies the real charge for the request/generation.

Examples include an OpenRouter generation cost or a Hermes `actual_cost_usd` value whose provenance identifies the billing source.

### CALCULATED

Use this when Token has exact or sufficiently authoritative usage plus a verified effective tariff matching the billing platform, model, timestamp and known pricing dimensions.

This is deterministic pricing, but it is not claimed to be an invoice-confirmed amount.

### UNKNOWN

Use this whenever Token cannot safely establish a monetary value.

Unknown is never represented as zero.

## Included

- passive local collectors;
- live and OpenTelemetry-compatible ingest;
- immutable normalized usage events;
- source fingerprints and cross-source deduplication;
- runtime, billing-platform, provider and model identity;
- current pricing refresh plus immutable historical price snapshots;
- actual provider-reported costs when available;
- calculated public-tariff costs when actual cost is unavailable;
- request/session/hour/day timing and rollups;
- TTFT and generation throughput when exposed;
- active wall time versus summed compute time;
- budgets and usage windows;
- CLI, JSON, read-only MCP and Dashboard projections;
- Hermes first-class integration;
- coding-agent collectors;
- OpenRouter, Command Code and direct-provider adapters;
- AI-Verse OS, Data, Memory, Brain and Multiple-Bots integration;
- standalone operation.

## Explicitly deferred

The first release will not implement:

- invoice reconciliation;
- enterprise/private contract pricing;
- complex account discounts;
- subscription fee amortization;
- a full credit accounting ledger;
- FX accounting as financial truth;
- billing dispute detection;
- tax accounting;
- invoice generation.

These can be added later without changing the core immutable usage ledger.

## Best-in-class reference set

The narrower scope still adopts the strongest relevant concepts from the ten benchmark projects:

1. Tokscale: passive multi-runtime discovery and practical time rollups.
2. CodeBurn: attribution, retry/efficiency signals and agent-readable usage.
3. ccusage: unified local reporting and provider-displayed cost precedence.
4. Pydantic genai-prices: effective-dated and conditional pricing rules.
5. Portkey Models: broad model/pricing vocabulary and cross-check coverage.
6. LiteLLM: provider/model normalization and budget concepts.
7. OpenLIT: OpenTelemetry timing semantics and GenAI telemetry.
8. Langfuse: hierarchical request/session/run attribution and provided-vs-derived cost separation.
9. OpenMeter: immutable events, deduplication and bounded time-window aggregation.
10. Bifrost: request-level token/cost/latency observability and gateway-overhead separation.

The implementation borrows concepts and public contracts, not source code.
