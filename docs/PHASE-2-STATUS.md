# Phase 2 Status

## Task 15 / 32 - Effective-dated price snapshot protocol

**Status:** COMPLETE

Implemented:

- immutable `ai-verse-token-price/0.1` price-snapshot protocol;
- strict billing-platform plus resolved-model identity with optional provider/model-id/service-tier/region/billing-mode constraints;
- inclusive effective start plus optional exclusive end;
- optional UTC weekday and time-window applicability;
- explicit context-tier basis and half-open token thresholds;
- explicit cache-TTL threshold rules;
- exact decimal-string money with bounded integer billing scales;
- rate vocabulary matching canonical token/cache/reasoning/audio/image/search/request usage dimensions;
- source authority, retrieval/publication time, URL, ETag and SHA-256 provenance;
- verification states with ordered verification timestamps;
- freshness represented by immutable retrieval/verification timestamps, not a stale flag that would become false over time;
- runtime validator and JSON Schema;
- `@ai-verse/token/pricing` export;
- no source registry, network sync or cost calculation implemented early.

Verification:

- `npm run check`: PASS;
- `npm test`: PASS, 64 / 64 tests;
- price protocol tests: 12 / 12 PASS;
- JSON Schema structural validation: PASS;
- JSON Schema valid-sample validation: PASS.

**Task 15 gate: PASSED.**

## Next

**Task 16 / 32 - Pricing source registry and verification.**

## Task 16 / 32 - Pricing source registry and verification

**Status:** COMPLETE

Implemented:

- trusted pricing-source registry separate from model/provider payload data;
- first-release source identities for OpenAI, Anthropic, Google Gemini, OpenRouter, Command Code and Z.AI official/provider sources;
- Pydantic `genai-prices`, Portkey Models and LiteLLM model-cost-map explicitly registered as secondary catalogs;
- fixed authority precedence: provider pricing API, official public pricing, secondary catalog;
- same-UTC-day freshness requirement for authoritative first-release sources plus 24-hour maximum age;
- seven-day discovery freshness for secondary catalogs without granting cost authority;
- bounded future-clock-skew handling;
- platform applicability checks so one provider's official source cannot authorize another platform's tariff;
- source-id plus authority matching so payloads cannot self-promote to official authority;
- `verified`/`cross_checked` required before an authoritative snapshot may authorize `CALCULATED` cost;
- `unverified` and `disputed` snapshots fail closed;
- secondary catalogs remain discovery/cross-check only even when fresh and cross-checked;
- deterministic snapshot ranking with authoritative sources always ahead of secondary catalogs;
- registry definitions frozen after trusted construction;
- no network fetch or source parsing implemented early.

Verification:

- `npm run check`: PASS;
- `npm test`: PASS, 78 / 78 tests;
- source-registry tests: 14 / 14 PASS.

**Task 16 gate: PASSED.**

## Next

**Task 17 / 32 - Fresh pricing synchronizer.**

## Task 17 / 32 - Fresh pricing synchronizer

**Status:** COMPLETE

Implemented:

- filesystem-backed immutable price-snapshot history separate from usage SQLite;
- SHA-256-derived safe snapshot paths and conflicting-ID rejection;
- append-only source sync observations with safe persisted status codes;
- trusted fetcher registration tied to Task 16 source definitions;
- startup stale-source refresh;
- periodic active-process refresh with six-hour default direction and overlap protection;
- forced unknown-model refresh even when a source was recently checked;
- updated-source ingest with trusted source authority/retrieval stamping;
- ETag and SHA-256 content-token persistence;
- `not_modified` refresh without duplicating unchanged price snapshots;
- same-day source-recheck evidence usable only when ETag/digest matches an immutable snapshot;
- invalid fetch batches validated before writes;
- fetch failures preserve previous successful evidence and persist no raw exception message;
- no provider-specific network parser implemented before its adapter task.

Verification:

- `npm run check`: PASS;
- `npm test`: PASS, 91 / 91 tests;
- pricing sync/store tests: 13 / 13 PASS.

**Task 17 gate: PASSED.**


## Task 18 / 32 - Cost engine

**Status:** COMPLETE

Implemented:

- strict `ACTUAL` / `CALCULATED` / `UNKNOWN` result surface;
- provider/runtime actual-charge precedence, including real zero-dollar charges;
- exact decimal/rational cost math with no floating-point tariff multiplication;
- per-rate component details and exact total;
- authoritative usage-quality requirement;
- exact billing-platform and resolved-model requirement;
- request-time requirement so historical backfills are not priced at observation time;
- effective-date, weekday and UTC time-window matching;
- service-tier, region, billing-mode, provider-model and inference-provider specificity;
- context-threshold and cache-TTL tariff selection;
- missing tariff dimensions fail closed rather than defaulting;
- same-day fresh authoritative pricing required for today's calculated usage;
- historical verified effective tariffs remain usable without being replaced by today's tariff;
- secondary catalogs cannot authorize calculated money;
- equal-rank conflicting authoritative tariffs fail as ambiguous;
- non-terminating exact decimal rates fail closed rather than silently rounding.

Verification:

- `npm run check`: PASS;
- `npm test`: PASS, 106 / 106 tests;
- cost-engine tests: 15 / 15 PASS.

**Task 18 gate: PASSED.**

## Next

**Task 19 / 32 - Provider-reported actual-cost ingestion.**

## Task 19 / 32 - Provider-reported actual-cost ingestion

**Status:** COMPLETE

Implemented:

- trusted actual-cost source registry separate from untrusted source payloads;
- provider-reported sources constrained by billing-platform scope;
- runtime-reported sources constrained by runtime scope;
- first-release OpenRouter generation API and Hermes state-db source definitions;
- finite non-negative actual-charge normalization;
- original currency, external charge ID and reported-at preservation;
- route/runtime identity and collector provenance preserved;
- exact replay idempotency;
- conflicting actual-charge overwrite rejected;
- unknown source cannot self-declare trust;
- Task 18 deterministic actual-over-calculated precedence reused verbatim.

Verification:

- `npm run check`: PASS;
- `npm test`: PASS, 115 / 115 tests;
- actual-cost ingestion tests: 9 / 9 PASS.

**Task 19 gate: PASSED.**

## Next

**Task 20 / 32 - Pricing adversarial gate.**

## Task 20 / 32 - Pricing adversarial gate

**Status:** COMPLETE

Implemented:

- integration gate over identity, pricing source authority, freshness, cost engine and actual-cost ingestion;
- historical tariff change proof;
- service-tier and context-tier ambiguity proof;
- cache zero versus missing-cache proof;
- unknown/near-name model unpriced proof;
- conflicting exact alias unpriced proof;
- stale current tariff rejection;
- trusted actual-charge precedence proof;
- structural proof that `UNKNOWN` does not contain a zero amount.

Verification:

- `npm run check`: PASS;
- `npm test`: PASS, 123 / 123 tests;
- Phase 2 acceptance: 8 / 8 PASS.

**Task 20 gate: PASSED.**
**Phase 2 gate: PASSED.**

## Next

**Task 21 / 32 - Collector SDK and registry.**
