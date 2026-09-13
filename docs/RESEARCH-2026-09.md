# AI-Verse Token Research Snapshot

> First-release scope note (2026-09-12): the research below intentionally records broader financial-grade possibilities. Invoice reconciliation, private contracts, subscription settlement and credit-ledger accounting are deferred. The canonical first-release scope is `docs/FIRST-RELEASE-SCOPE.md`.


**Date:** 2026-09-12  
**Scope:** token usage, LLM cost, timing, runtime attribution, metering, pricing freshness, agent/OS integration  
**Selection rule:** best architectural fit for a headless universal token-intelligence layer, not simply most GitHub stars.

## Executive findings

No single project covers the full target.

The ecosystem splits into four specialties:

1. **Local usage readers** such as Tokscale, CodeBurn and ccusage are excellent at discovering coding-agent data without forcing traffic through a proxy.
2. **Observability systems** such as OpenLIT and Langfuse model traces, latency, TTFT and usage well.
3. **Gateway/accounting systems** such as LiteLLM and Bifrost understand providers, service tiers, budgets and request lifecycle metadata.
4. **Pricing/metering projects** such as Portkey Models, Pydantic genai-prices and OpenMeter solve tariff breadth, historical/effective pricing, event aggregation and usage accounting.

The strongest AI-Verse design combines all four while staying headless and runtime-neutral.

## Top 10

### 1. Tokscale

Repository: `junhoyeo/tokscale`

Why it matters:

- very broad passive local discovery across coding-agent runtimes;
- supports Hermes Agent directly;
- supports daily, hourly and optional minutely aggregation;
- tracks input, output, cache read/write and reasoning tokens;
- dynamically refreshes pricing from LiteLLM and falls back to OpenRouter for new models;
- exports structured data;
- Hermes reader prefers `actual_cost_usd` over `estimated_cost_usd`.

Best ideas to adopt:

- collector-per-runtime architecture;
- zero-proxy passive ingestion;
- hourly/minutely rollups;
- aggressive runtime auto-detection;
- raw usage normalization across heterogeneous files/SQLite stores;
- source-reported cost taking precedence over recalculation.

Do not adopt:

- fuzzy/hardcoded fallback pricing as authoritative spend;
- UI/TUI concerns in the core.

### 2. CodeBurn

Repository: `getagentseal/codeburn`

Why it matters:

- rich cost attribution by model, provider, project, task, agent, tool and MCP server;
- reads many coding tools directly from disk;
- tracks retry/one-shot and productive-vs-reverted signals;
- has session duration and tool-wait concepts;
- implements provider-specific deduplication rules;
- exposes usage to agents through an MCP server;
- includes quota/plan awareness and subscription-covered concepts;
- its own open issue identifies an important accounting truth: source-reported cost can be more authoritative than token × price recalculation.

Best ideas to adopt:

- task/tool/agent attribution;
- deterministic deduplication;
- MCP read surface;
- retry-tax and efficiency signals;
- quota window adapters;
- provider-specific parsers isolated behind a shared contract.

Do not adopt:

- inferred model pricing for “Auto” or unknown models in exact mode;
- counterfactual savings mixed into real spend.

### 3. ccusage

Repository: `ccusage/ccusage`

Why it matters:

- clean unified reports across Claude Code, Codex, OpenCode, Hermes, OpenClaw, Gemini and many others;
- daily, weekly, monthly, session and billing-block views;
- model breakdowns and source-focused views;
- distinguishes displayed/source cost from recalculated cost modes;
- tracks Anthropic cache-creation duration classes.

Best ideas to adopt:

- one normalized query layer over many collectors;
- billing-window reports;
- explicit cost provenance/mode rather than one opaque number;
- simple machine-readable JSON outputs.

Do not adopt:

- applying today’s pricing retroactively to historical usage.

### 4. Pydantic genai-prices

Repository: `pydantic/genai-prices`

Why it matters:

- effective-dated historical pricing;
- supports price changes over time;
- supports variable daily/time-dependent prices;
- supports tiered long-context pricing;
- sophisticated model/provider matching;
- provider usage extractors and price-source metadata;
- actively models promotions with start dates.

Best ideas to adopt:

- price rules with explicit effective intervals;
- constraints by context/tier/time/provider;
- historical price preservation;
- provider-specific usage extractors;
- discrepancy detection between pricing sources.

Do not adopt:

- its “best effort estimate” semantics for authoritative AI-Verse spend. The schema ideas are excellent, but AI-Verse strict mode must return `unpriced` instead of guessing.

### 5. Portkey Models

Repository: `Portkey-AI/models`

Why it matters:

- large multi-provider pricing/configuration catalog;
- public machine-readable API;
- models cache reads/writes, audio, images, thinking tokens and additional units such as web/file search;
- separates model config from pricing config;
- captures batch pricing and provider-specific dimensions.

Best ideas to adopt:

- broad normalized tariff vocabulary;
- provider/model catalog separation;
- additional billing units;
- secondary live price feed and source cross-checking.

Do not adopt:

- treating a third-party catalog as invoice-grade authority without verification against the billing platform or an account-specific contract.

### 6. LiteLLM

Repository: `BerriAI/litellm`

Why it matters:

- huge provider/model normalization surface;
- mature model cost map;
- provider-specific service-tier pricing support;
- spend tracking by key/user/team;
- budgets and multiple budget windows;
- tagging/attribution;
- can refresh pricing data from GitHub.

Best ideas to adopt:

- normalized provider identity and usage fields;
- service-tier-aware rating;
- hierarchical budget scopes;
- tags that flow with usage;
- explicit budget reconciliation after a request completes.

Do not adopt:

- making a proxy/database gateway mandatory;
- using budget reservations or predicted maximum cost as settled spend.

### 7. OpenLIT

Repository: `openlit/openlit`

Why it matters:

- OpenTelemetry-native GenAI instrumentation;
- standard token-usage metric;
- operation duration;
- time to first token;
- time per output token;
- request duration and error-path metrics;
- standard provider/model attributes.

Best ideas to adopt:

- align the canonical event/timing model with OpenTelemetry GenAI semantic conventions;
- instrument request durations and streaming phases explicitly;
- export/import OTLP without forcing AI-Verse-specific telemetry formats.

Do not adopt:

- observability UI/backend as a dependency.

### 8. Langfuse

Repository: `langfuse/langfuse`

Why it matters:

- strong hierarchical trace/observation model;
- separates provided usage/cost details from derived cost details;
- latency and time-to-first-token fields;
- model matching and pricing tier identity;
- excellent parent/child operation structure for agent traces.

Best ideas to adopt:

- trace/run/request hierarchy;
- preserve provider-supplied usage separately from normalized usage;
- preserve provided cost separately from rated cost;
- parent-child attribution across agent/tool/model operations.

Do not adopt:

- prompt/response observability storage by default. Token should remain privacy-minimal.

### 9. OpenMeter

Repository: `openmeterio/openmeter`

Why it matters:

- high-volume immutable usage-event ingestion;
- event deduplication;
- aggregation by time window/dimension;
- metering and credits/usage-limit concepts;
- versioned product/pricing ideas.

Best ideas to adopt:

- idempotent metering events;
- bounded time-window aggregation;
- dimension-based meters;
- separate event truth from derived meter values.

Do not adopt:

- full subscription, invoice and monetization stack. AI-Verse Token is telemetry/accounting, not a billing SaaS.

### 10. Bifrost

Repository: `maximhq/bifrost`

Why it matters:

- low-overhead gateway instrumentation;
- captures tokens, costs and latency per request;
- hierarchical budgets;
- request/provider/routing metadata;
- time-to-first-token and upstream/gateway overhead concepts;
- request logging can expose exact computed/recorded cost and detailed usage.

Best ideas to adopt:

- distinguish upstream provider latency from local gateway overhead;
- preserve provider routing details;
- fast live request ingestion;
- budget hierarchy and per-request log identity.

Do not adopt:

- gateway-first architecture. A user must be able to install Token after the fact and read existing local histories.

## Secondary references

### OpenLLMetry

Important as an OpenTelemetry-native instrumentation reference and for agent/task duration semantics. OpenLIT was selected in the primary ten because it provides a more directly usable combination of token, cost, TTFT and streaming metrics, but AI-Verse should remain interoperable with OpenLLMetry/OTel.

### Helicone

Strong cost/latency/session observability and gateway ergonomics. It overlaps with Langfuse/Bifrost for this particular headless backend scope, so it is a secondary UX/observability reference rather than a primary architectural dependency.

## Pricing research findings

### Pricing is multi-dimensional

Modern LLM cost can depend on:

- billing platform;
- model version/alias;
- input vs output;
- cache read vs cache write;
- cache TTL;
- reasoning/thinking tokens;
- audio/image/video units;
- tool calls such as web search/file search/code execution;
- service tier such as standard/batch/flex/fast/priority;
- context-length threshold;
- region/data residency;
- account discounts or contract pricing;
- time of day/day of week;
- promotions with effective start/end dates;
- subscription/credit coverage.

Therefore one `input_rate` and one `output_rate` are not enough.

### Some platforms expose real billed cost

Examples found during research:

- OpenRouter generation metadata can return `total_cost` per generation, plus provider, service tier, native token counts, latency and generation time.
- Hermes now stores `actual_cost_usd`, `cost_status` and `cost_source` when its provider path reports real cost.
- Command Code exposes usage/credit APIs and its Usage page reports what requests actually cost; pricing can vary by time of day for some models.
- OpenAI exposes organization Usage and Costs APIs; OpenAI explicitly recommends Costs for financial reconciliation.
- Anthropic exposes Usage and Cost APIs for organizations, including model/service-tier/context-window dimensions.

These should be used for reconciliation whenever credentials/permissions allow.

### Fresh price databases are still useful

Portkey Models, LiteLLM and Pydantic genai-prices are valuable for:

- discovery;
- coverage of many providers;
- model aliases;
- cache/tier/additional-unit structure;
- detecting gaps or mismatches.

They should be cross-checks/fallback knowledge, not silently promoted above a billing platform’s own reported cost.

## Command Code finding

Command Code is especially relevant because:

- usage is not necessarily fully available in local session files;
- account APIs expose subscriptions, credits and usage summaries;
- model usage is charged in plan credits;
- provider pricing changes can pass through to users;
- at least some DeepSeek models have peak/off-peak rates that change by UTC hour/day;
- the Usage surface is therefore a better financial source than a static public model price table.

AI-Verse Token should include a dedicated Command Code account adapter instead of treating it as a generic OpenAI-compatible endpoint only.

## Final research conclusion

The best design is **not another token dashboard**. It is a portable accounting/telemetry engine with:

- passive collectors;
- live hooks;
- immutable normalized usage events;
- strict provider/model/platform identity;
- effective-dated tariffs;
- source-reported cost precedence;
- later billing reconciliation;
- concurrency-correct time accounting;
- hierarchical attribution and budgets;
- read-only query interfaces for CLIs, agents and dashboards.
