# AI-Verse Token Architecture Blueprint

**Status:** implementation in progress

## 1. Ownership boundary

AI-Verse Token owns:

- normalized immutable usage events;
- request/run/session timing observations;
- runtime, billing-platform, provider and model identity needed for attribution;
- immutable effective-dated pricing snapshots;
- actual and calculated cost facts with provenance;
- rollups;
- token/cost/time/request budgets;
- derived efficiency metrics.

It does not own prompts/responses, AI-Verse workspace truth, Memory, Brain goals, Skills, Bot coordination, provider credentials, invoices or Dashboard state.

## 2. Collector registry

Collectors may be passive local readers, authenticated provider/API adapters, OpenTelemetry ingest, gateway adapters or explicit SDK hooks.

Each collector has a stable identity, health state, checkpoint and incremental collection contract. Collectors normalize observations but do not invent cost.

## 3. Normalizer and protocol

Source-specific records become `ai-verse-token/0.1` usage events.

The normalizer preserves missingness, usage categories, timestamps, scope IDs and source fingerprints. Prompt/response content is excluded from canonical events.

See `docs/PROTOCOL-V0.1.md`.

## 4. Identity resolver

Token resolves separate identities for:

```text
runtime
billing_platform
inference_provider
requested_model
resolved_model
provider_model_id
```

It also carries optional AI-Verse and agent scope such as workspace, project, agent, Bot, Worker, task, run, session, Skill, automation and tool.

Exact aliases may be versioned. Ambiguity fails closed for pricing.

## 5. Usage ledger

SQLite is the first storage driver.

The ledger is append-oriented and owns:

- canonical usage events;
- source fingerprints and ingest checkpoints;
- correlation/dedupe metadata;
- immutable pricing snapshots;
- derived cost records;
- bounded rollups/budget state.

It uses WAL, format metadata, integrity checks and indexes. It stores no provider secrets and no prompt/response content.

## 6. Cross-source deduplication

The same underlying request may appear in a runtime DB, gateway, OpenTelemetry span and provider API.

Token must distinguish an observation from the underlying request. It uses strong source fingerprints plus correlation evidence such as request IDs, generation IDs, timestamps, model/route identity and trusted parent IDs.

No collector may double-count an already represented request merely because it came from another source.

## 7. Price catalog and synchronizer

Pricing is stored as immutable effective-dated snapshots rather than one mutable current-price table.

Source priority favors official provider pricing. Pydantic genai-prices, Portkey Models and LiteLLM are discovery/cross-check inputs.

Normal behavior:

```text
refresh at startup when stale
periodic refresh while active
refresh immediately for an unknown model
manual prices sync
preserve historical snapshots
```

## 8. Cost engine

The cost engine exposes only:

```text
ACTUAL
CALCULATED
UNKNOWN
```

A trusted source-reported charge wins over calculated cost. Calculation requires an unambiguous route/model and a verified tariff effective at the event timestamp. No fuzzy match may cross that boundary.

## 9. Time engine

Request duration, TTFT, generation duration and other source timing remain raw observations.

At aggregation time Token computes active wall time using interval union and keeps summed model-compute time separate. Parallel calls therefore do not inflate active wall time.

## 10. Query and rollup engine

Primary dimensions include request, hour, day, session, run, task, workspace/project, agent/Bot/Worker, Skill/automation/tool, runtime, billing platform, provider, model and service tier.

Metrics include request count, usage categories, cost by truth status, time, TTFT/TPS percentiles, cache efficiency, reasoning share and retry signals when identifiable.

## 11. Read surfaces

Consumers use bounded APIs:

- CLI text/JSON;
- library query API;
- JSON/CSV export;
- read-only MCP;
- AI-Verse Dashboard projection;
- Brain/Data/Memory/Bots adapters.

Consumers do not open Token SQLite directly.

## 12. AI-Verse boundary

AI-Verse Token is optional and install-order independent. Its native extension owns only its extension directory and its own registry entry.

Data may consume projections/references but does not own raw telemetry. Memory may receive selected evidence candidates, never every event. Brain and Bots query bounded surfaces. Connections owns credentials/connector handles.

## 13. Deferred financial-grade layer

Invoice reconciliation, private contract tariffs, subscription/credit settlement and FX accounting are explicitly deferred. They may be additive later without changing the usage-event ledger.
