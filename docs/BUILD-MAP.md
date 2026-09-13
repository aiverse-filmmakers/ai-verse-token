# AI-Verse Token Build Map

**Status:** First-release implementation complete
**Total tasks:** 32
**Completed:** 32 / 32
**Current:** None - first-release implementation gate passed locally

This is the canonical first-release plan after the scope reduction on 2026-09-12. The goal is best-in-class usage intelligence without building an invoice/accounting platform.

A task is complete only after its tests, documentation and acceptance checks pass. Work proceeds one task at a time.

## Phase 0 - Research and contracts

### Task 1 / 32 - Ecosystem benchmark - COMPLETE
Research the strongest token/cost/timing projects and select the reference set.

### Task 2 / 32 - Reference adoption map - COMPLETE
Record adopt/adapt/integrate/avoid decisions across the ten primary references.

### Task 3 / 32 - Cost truth policy - COMPLETE
Freeze `ACTUAL`, `CALCULATED`, `UNKNOWN`, authority rules and historical-pricing behavior.

### Task 4 / 32 - Time metrics contract - COMPLETE
Define request, TTFT, generation, active wall, compute time and concurrency semantics.

### Task 5 / 32 - Canonical usage-event draft - COMPLETE
Draft the runtime-neutral normalized event contract.

### Task 6 / 32 - AI-Verse/Hermes boundary - COMPLETE
Define extension ownership, install-order independence and Hermes read-only integration.

### Task 7 / 32 - First-release scope and build map - COMPLETE
Remove financial-grade reconciliation/accounting from first release while preserving extensibility.

---

## Phase 1 - Core package and usage ledger

### Task 8 / 32 - Package, CLI, test and CI foundation - COMPLETE
- TypeScript and Node 22+
- strict compiler/static checks
- Node 22/24 CI
- package export shell
- CLI shell
- smoke tests
- no runtime accounting claims yet

### Task 9 / 32 - Canonical protocol types and validators - COMPLETE
- usage event v0.1
- source/runtime/route/model/scope/usage/timing
- `ACTUAL`, `CALCULATED`, `UNKNOWN`
- hard validation ceilings
- unknown versus zero semantics

### Task 10 / 32 - SQLite ledger and format metadata - COMPLETE
- WAL
- format/version metadata
- safe create/open/close
- integrity checks
- no secrets or prompt/response content

### Task 11 / 32 - Idempotent immutable ingest and dedupe primitives - COMPLETE
- source fingerprint
- duplicate no-op
- immutable event rows
- checkpoint transaction
- correlation keys for later cross-source dedupe

### Task 12 / 32 - Runtime/platform/provider/model identity resolver - COMPLETE
- runtime versus billing platform versus inference provider
- requested versus resolved model
- exact versioned aliases
- no fuzzy pricing authority

### Task 13 / 32 - Bounded query and aggregate engine - COMPLETE
- filters
- pagination/cursors
- request/session/time-window queries
- group by model/provider/platform/agent/project/workspace
- count/sum/min/max/avg

### Task 14 / 32 - Core acceptance gate - COMPLETE
- persistence/reopen
- duplicate safety
- strict missingness
- corruption detection basics
- concurrency/read safety
- cross-platform CI

---

## Phase 2 - Pricing and cost intelligence

### Task 15 / 32 - Effective-dated price snapshot protocol - COMPLETE
- platform/model/tier/region identity
- effective intervals
- cache/reasoning/modality/additional-unit rates
- context/tier/time conditions when providers expose them
- source freshness and verification

### Task 16 / 32 - Pricing source registry and verification - COMPLETE
- official provider pricing sources first
- Pydantic/Portkey/LiteLLM as discovery/cross-check inputs
- source precedence
- freshness metadata
- no secondary catalog silently treated as authoritative

### Task 17 / 32 - Fresh pricing synchronizer - COMPLETE
- startup refresh when stale
- periodic refresh while active
- unknown-model forced refresh
- immutable historical snapshots
- content hash/ETag support where available

### Task 18 / 32 - Cost engine - COMPLETE
- `ACTUAL` when a trusted source supplies the real charge
- `CALCULATED` from matching verified tariff plus usage
- `UNKNOWN` otherwise
- component-level cost details
- historical events use historical tariffs
- provider-reported actual cost is never overwritten

### Task 19 / 32 - Provider-reported actual-cost ingestion - COMPLETE
- normalize exact source-reported charges
- preserve original currency and provenance
- Hermes/OpenRouter-compatible actual-cost path
- deterministic precedence over calculated cost

### Task 20 / 32 - Pricing adversarial gate - COMPLETE
Test:
- price changes over time
- service/context tiers
- cache dimensions
- unknown model
- ambiguous alias
- stale pricing
- provider actual versus calculated cost
- unknown cost never becomes zero

---

## Phase 3 - Collectors and integrations

**Status:** COMPLETE

### Task 21 / 32 - Collector SDK and registry - COMPLETE
- detect/collect/checkpoint contract
- collector health
- incremental scans
- source isolation
- stable provenance

### Task 22 / 32 - Hermes passive collector - COMPLETE
- main/profile state databases
- sessions and per-model usage
- route/task attribution
- actual-cost precedence
- read-only WAL-safe history/backfill

### Task 23 / 32 - Local coding-agent collector pack - COMPLETE
First-release targets:
- Claude Code
- Codex
- OpenCode
- Gemini CLI
- OpenClaw
with an extension contract for additional runtimes.

Implemented:
- passive source discovery and bounded incremental scans;
- Claude request-level duplicate suppression;
- Codex historical `token_count` plus 0.153+ durable `token_usage_record` compatibility;
- OpenCode read-only SQLite ingest;
- Gemini CLI session JSON ingest with rewrite-safe cursor identity;
- OpenClaw session JSONL ingest with all-zero usage distrust;
- privacy-safe canonical events only, no prompt/response storage;
- full inherited suite green at 149 / 149 tests.

Detailed contract: `docs/LOCAL-AGENT-COLLECTORS-V0.1.md`.

**Task 23 gate: PASSED.**

### Task 24 / 32 - OpenRouter and Command Code adapters

**Status:** COMPLETE

Implemented:
- strict OpenRouter generation metadata normalization with requested/resolved model, provider, tier, region, IDs and native token categories;
- cache/reasoning subset accounting that fails closed on impossible counters;
- trusted OpenRouter `total_cost` ingestion as provider-reported `ACTUAL`, including real zero charges;
- strict Command Code usage-record normalization with conflict-detecting aliases and request/model/provider attribution;
- trusted Command Code request-cost ingestion when the source exposes an actual charge, with missing cost preserved as unknown;
- five-hour/weekly/monthly Command Code usage-window normalization as capacity facts only, with no subscription amortization;
- no credentials, private endpoint hard-coding, prompt/response storage, or aggregate-cost allocation;
- full inherited suite green at 157 / 157 tests.

Detailed contract: `docs/REMOTE-USAGE-ADAPTERS-V0.1.md`.

**Task 24 gate: PASSED.**

### Task 25 / 32 - Direct-provider adapters

**Status:** COMPLETE

Implemented:
- OpenAI Responses request-level usage normalization with cache-read/cache-write/reasoning subset decomposition, actual service tier and strict total validation;
- Anthropic Messages usage normalization with uncached/cache-write/cache-read/output/thinking decomposition, service tier, inference geography and single-TTL pricing context;
- mixed Anthropic 5-minute/1-hour cache writes remain exact usage while refusing a false single-TTL pricing context;
- Google Gemini GenerateContent normalization with requested/resolved model identity, cached prompt decomposition, candidate output, thought tokens and service tier;
- official pricing-source hooks for OpenAI, Anthropic and Google, verified against the trusted pricing registry;
- no provider response is mislabeled `ACTUAL` when it contains usage but no provider-confirmed dollar charge;
- no aggregate organization billing bucket is allocated across requests;
- full inherited suite green at 165 / 165 tests.

Detailed contract: `docs/DIRECT-PROVIDER-ADAPTERS-V0.1.md`.

**Task 25 gate: PASSED.**

### Task 26 / 32 - OpenTelemetry/gateway adapters and cross-source dedupe gate

**Status:** COMPLETE

Implemented:
- OpenTelemetry GenAI span normalization for provider/model/usage/cache/reasoning/timing attributes, including OTLP attribute arrays and nanosecond timestamps;
- prompt/response/message/tool content attributes ignored by design;
- LiteLLM request/spend-log normalization with confirmed gateway-cache-hit replay suppression;
- Bifrost request-log normalization with streaming all-zero token rows treated as unknown rather than authoritative zero;
- generic OpenAI-compatible gateway normalization;
- gateway-calculated cost retained as diagnostic data only and never promoted to `ACTUAL`;
- immutable raw observations plus append-only `event_supersessions` for exact cross-source correlation;
- strong-key dedupe on request/response/upstream/external-charge IDs only, with no time/model/trace heuristic guessing;
- derived canonical call preserves compatible scope, strongest usage/timing evidence and trusted actual charge;
- normal queries and aggregates automatically exclude superseded observations, preventing double-counting while preserving audit evidence;
- conflicting strongly correlated exact facts fail closed transactionally;
- full inherited suite green at 176 / 176 tests.

Detailed contract: `docs/OTEL-GATEWAYS-DEDUPE-V0.1.md`.

**Task 26 gate: PASSED.**
**Phase 3 gate: PASSED.**

---

## Phase 4 - Time, efficiency and control

### Task 27 / 32 - Time engine

**Status:** COMPLETE

Implemented:
- request wall, TTFT and generation timing with timestamp-derived exact intervals and reported-duration fallback;
- time-per-output-token and output-tokens-per-second metrics;
- missing timing preserved as unknown rather than zero;
- exact interval union for active wall time, separate summed compute time, overlap duration and peak/average concurrency;
- exact idle time only when every request interval is known, with no arbitrary gap heuristic;
- session span kept distinct from active wall time;
- deterministic nearest-rank p50/p95/p99 for wall, TTFT and output TPS;
- UTC hour/day rollups plus session rollups;
- exact request intervals split across hour/day boundaries while request/token attribution remains single-counted;
- separate input/output/reasoning/cache token totals in time rollups;
- full inherited suite green at 187 / 187 tests.

Detailed contract: `docs/TIME-ENGINE-V0.1.md`.

**Task 27 gate: PASSED.**

### Task 28 / 32 - Efficiency metrics, budgets and quota windows

**Status:** COMPLETE

Implemented:
- cache-read ratio and reasoning share with missing required counters preserved as unknown rather than zero;
- exact total-token lower bounds with decimal-string accumulation beyond JavaScript safe-integer totals;
- cost coverage split by original currency and by `ACTUAL` versus `CALCULATED` truth;
- bounded grouping by session, task, runtime, billing platform, provider, model, workspace, project, agent, bot and worker;
- explicit retry-tax links only, with unknown-link, duplicate, self-reference and cycle rejection and no heuristic retry guessing;
- request, token, compute-time, active-wall-time and single-currency cost budgets;
- `OK`, `WARNING`, `EXCEEDED` and `UNKNOWN` budget states with conservative known-lower-bound behavior;
- exact decimal monetary totals/remainders with optional `CALCULATED` exclusion;
- active-wall budgets based on interval union while compute budgets sum request durations;
- provider quota-window evaluation with remaining, utilization, reset and exhaustion state;
- full inherited suite green at 200 / 200 tests.

Detailed contract: `docs/EFFICIENCY-BUDGETS-V0.1.md`.

**Task 28 gate: PASSED.**

### Task 29 / 32 - Query, export and machine-readable surfaces

**Status:** COMPLETE

Implemented:
- stable `@ai-verse/token/read` API that opens existing ledgers read-only and exposes bounded query, aggregate, summary, time and efficiency reads;
- 10,000-event default and 50,000-event hard analysis ceilings;
- CLI `summary`, `query` and `export` commands with text/JSON/CSV output and read-only ledger access;
- privacy-safe default event projection that removes raw source-record IDs and provenance fingerprints from agent/CLI/export results;
- JSON export with explicit trusted provenance-ID opt-in and fixed-column CSV export without source forensic IDs;
- bounded read-only MCP tool surface for summary, query, aggregate, time and efficiency, with 100-event pages and 5,000-event analysis ceilings;
- no MCP writes, raw SQL, arbitrary columns or direct database handle exposure;
- populated-ledger performance baseline for open, query, aggregate, time analysis and export;
- full inherited suite green at 208 / 208 tests.

Detailed contract: `docs/READ-EXPORT-MCP-V0.1.md`.

**Task 29 gate: PASSED.**
**Phase 4 gate: PASSED.**

---

## Phase 5 - AI-Verse native integration and release

### Task 30 / 32 - AI-Verse OS compatibility, registration and lifecycle

**Status:** COMPLETE

Implemented:
- exact AI-Verse OS v2 host detection for schema-major 2 plus `unified-workspace`, required runtime/workspace nodes and the current local-extension contract;
- standalone reporting without masking partial/broken AI-Verse-like hosts;
- Token-owned materialization only under `.aiverse/extensions/ai-verse-token/`;
- schema-`1.0` registry handling with exclusive lock, atomic replacement and stale-snapshot/lost-update rejection;
- preservation of unknown top-level fields, sibling extension entries, unknown Token-entry fields and existing `enabled: false`;
- `install`, `update`, `enable`, `disable`, `uninstall`, `status` and `doctor` library/CLI surfaces;
- fixed-path containment and symlink rejection for native extension paths;
- zero telemetry-state creation during install;
- native user ledger under `.aiverse/extensions/ai-verse-token/state/token.sqlite`, preserved byte-for-byte across update/disable/uninstall/reinstall;
- read-only doctor integrity check for existing native ledgers;
- tracked OS files never modified and sibling registrations never rewritten;
- full inherited suite green at 224 / 224 tests.

Detailed contract: `docs/AI-VERSE-NATIVE-LIFECYCLE-V0.1.md`.

**Task 30 gate: PASSED.**

### Task 31 / 32 - AI-Verse ecosystem adapters

**Status:** COMPLETE

Implemented:
- `@ai-verse/token/dashboard` bounded read-only overview, breakdown and timeline projections with no SQLite path/handle exposure;
- `@ai-verse/token/brain` bounded summary/recent/time/efficiency answers with privacy-safe recent events;
- `@ai-verse/token/memory` stable `token://event/...` evidence plus explicit candidates with `auto_write: false`;
- `@ai-verse/token/data` references and bounded projections with Token authority retained and `ownership_transferred: false`;
- `@ai-verse/token/bots` exact Multiple Bots attribution with TeamRun mapped to `run_id` and conflict detection for Bot/Worker/task/workspace/project identity;
- `@ai-verse/token/correlation` exact Skills/Automations/tool/task/run attribution that enriches only absent fields;
- `@ai-verse/token/connections` opaque credential handles with runtime rejection of unknown/secret-bearing fields;
- no sibling package dependency, sibling repository mutation or installation-order requirement;
- full inherited suite green at 232 / 232 tests.

Detailed contract: `docs/AI-VERSE-ECOSYSTEM-ADAPTERS-V0.1.md`.

**Task 31 gate: PASSED.**

### Task 32 / 32 - Packaging and full release acceptance

**Status:** COMPLETE

Implemented and verified:
- publishable package shape with cross-platform Node-based clean/build and `prepare` support for Git/package installation;
- clean packed-artifact install with package import and CLI execution, plus tarball `npm exec` one-command proof;
- standalone ledger/read surfaces and AI-Verse native lifecycle acceptance;
- inherited Hermes, local coding-agent, remote-platform, direct-provider, OTel and gateway coverage;
- historical effective pricing and same-day freshness rules;
- immutable backfill/live-ingest source handling and exact cross-source dedupe;
- `ACTUAL` / `CALCULATED` / `UNKNOWN` release truth story, including UNKNOWN with no amount;
- Dashboard read-only projection through public APIs rather than SQLite access;
- update/uninstall/reinstall state preservation with read-only doctor verification;
- GitHub Actions matrix configured for Ubuntu, macOS and Windows crossed with Node 22 and 24, with the matrix contract tested locally pending the first remote Actions run;
- package dry-run and CLI smoke in CI;
- hardened post-release audit complete with 249 / 249 normal tests plus 3 / 3 serial release-acceptance tests, 252 / 252 total checks through `npm test`;
- canonical ACTUAL money uses exact decimal text and ledger format is version 2;
- protocol/schema parity, storage tamper resistance, pricing context tiers, dedupe conflicts, time missingness, native filesystem safety, collector scalability and privacy were independently hardened.

Detailed proof: `docs/PACKAGING-RELEASE-ACCEPTANCE-V0.1.md`.
Hardening audit: `docs/HARDENING-AUDIT-2026-09-12.md`.

**Task 32 gate: PASSED.**
**Phase 5 gate: PASSED.**
**First release implementation: COMPLETE 32 / 32.**

## First-release acceptance laws

Release does not pass if any of these are true:

- ambiguous model identity is priced as authoritative;
- historical events silently use today's tariff;
- provider-reported actual cost is overwritten by calculation;
- `CALCULATED` is presented as provider-confirmed billing;
- unknown monetary cost appears as zero;
- parallel request durations are mislabeled active wall time;
- duplicate collectors double-count the same underlying call;
- Dashboard or an agent must open Token SQLite directly;
- AI-Verse installation edits tracked OS files;
- Hermes integration modifies Hermes state databases;
- prompt/response text is required for normal accounting.
