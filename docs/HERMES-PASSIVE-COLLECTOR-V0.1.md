# Hermes Passive Collector v0.1

## Purpose

Task 22 adds a first-class passive Hermes collector that reads Hermes usage history without changing Hermes state. It uses the collector SDK from Task 21 and emits canonical `ai-verse-token/0.1` usage events.

## Supported source layout

Discovery accepts a Hermes home directory and looks for:

```text
<HERMES_HOME>/state.db
<HERMES_HOME>/profiles/*/state.db
```

Each database receives a stable source ID such as `main` or `profile:work` so events from different Hermes profiles cannot collide.

The collector itself accepts an explicit database path and source ID. It does not guess arbitrary filesystem roots.

## Read-only boundary

Every Hermes database is opened with SQLite read-only mode. The collector never:

- writes Hermes rows;
- creates Hermes tables or indexes;
- runs Hermes migrations;
- advances state inside Hermes;
- stores Token checkpoints in Hermes;
- changes WAL or journal settings.

Token checkpoints remain in the Token ledger.

## Current schema preference

When the current `session_model_usage` table is available with the expected columns, it is preferred over the session summary because it preserves the route that actually consumed usage:

```text
session_id
model
billing_provider
billing_base_url
billing_mode
task
api_call_count
input_tokens
output_tokens
cache_read_tokens
cache_write_tokens
reasoning_tokens
actual_cost_usd
cost_status
cost_source
first_seen
last_seen
```

The joined `sessions` row supplies the Hermes access surface and finalization timestamp.

If the database has a compatible `sessions` table but no compatible per-model table, detection returns `degraded` with `HERMES_SESSION_SUMMARY_FALLBACK`. The collector can still import one aggregate usage event per finalized session, but route attribution may be less precise.

Unsupported schemas are not guessed.

## Finalized sessions only

Hermes per-model usage rows are cumulative while a session is active. Treating every scan as a new immutable usage event would double-count the same calls.

The passive collector therefore imports only sessions with a non-null positive `ended_at` older than the configured finalization grace. The default grace is 60 seconds and may be reduced to zero for controlled tests.

A live Hermes session is left for a later scan after it is finalized.

## Checkpoint order

Rows are ordered deterministically by:

1. session `ended_at`;
2. session ID;
3. model;
4. billing provider;
5. base URL;
6. billing mode;
7. Hermes task.

The checkpoint stores the last finalized tuple. A bounded scan can therefore continue after the last imported row instead of repeatedly replaying the oldest history.

The Token ledger still applies immutable fingerprint deduplication underneath the checkpoint.

## Usage and identity mapping

Hermes fields map as follows:

```text
runtime                 -> hermes
session_id              -> Hermes session id
source_platform         -> Hermes session source, for example telegram or cli
billing_platform        -> Hermes billing_provider when known
requested_model         -> Hermes model string
resolved_model          -> null until exact Token identity resolution
task_id                 -> Hermes auxiliary task when present
billing_mode            -> Hermes billing_mode
input/output/cache/...  -> Hermes runtime-reported counters
request_units           -> Hermes api_call_count
```

The collector deliberately does not declare the Hermes model string as a price-authoritative resolved model. Task 12 exact identity rules remain responsible for that decision.

Per-model aggregate rows do not claim request-level timing. Their canonical `timing` object is empty and `timing_quality` is `unknown`. Session timing will be handled separately by the time layer instead of pretending an aggregate row is one API request.

## Cost handling

`estimated_cost_usd` is never promoted to `ACTUAL`.

This is intentional because Hermes's local estimate can be absent, stale, or represented as zero when pricing is unknown. Token can independently calculate money later using its verified pricing layer.

A positive `actual_cost_usd` with a populated Hermes `cost_source` is attached through the trusted `hermes-state-db` runtime-reported actual-cost source from Task 19.

A stored zero is not promoted to actual money because Hermes aggregate rows use zero as a default and do not provide enough information to distinguish a genuine zero-dollar billed event from an unset value.

## Privacy

The collector never reads or stores Hermes message content. The SQL projections are limited to usage, route, session metadata and cost metadata needed for accounting.

## Acceptance

Task 22 passes only when tests prove:

- current per-model schema detection and route/task attribution;
- estimated cost is not promoted to authoritative money;
- positive source-backed Hermes actual cost uses the trusted actual-cost path;
- active cumulative sessions are skipped;
- bounded checkpoint paging progresses without double-counting;
- sessions-only legacy fallback is explicitly degraded;
- Hermes database bytes remain unchanged after collection;
- main and profile database discovery is deterministic.
