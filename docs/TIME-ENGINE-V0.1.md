# Time Engine v0.1

Task 27 implements the first-release time intelligence engine for AI-Verse Token.

## Request metrics

For each canonical usage event the engine exposes:

- wall duration;
- time to first token;
- generation duration;
- time per output token;
- output tokens per second;
- exact request interval when both start and end timestamps exist.

Timestamp-derived durations take precedence over standalone reported duration fields because they provide an exact interval for concurrency analysis. Reported durations remain usable when interval timestamps are unavailable.

Missing timing remains `null`. It is never converted to zero.

## Active wall versus compute

Compute time is the sum of known request durations.

Active wall time is the union of exact request intervals.

These intentionally differ under parallel execution. For example, two 10-second requests overlapping by 5 seconds produce:

- 20 seconds compute;
- 15 seconds active wall;
- 5 seconds overlap;
- peak concurrency 2;
- concurrency factor 1.3333.

The engine never treats summed parallel durations as wall-clock active time.

## Concurrency

Exact interval analysis exposes:

- interval request count;
- active wall milliseconds;
- interval compute milliseconds;
- overlap milliseconds where concurrency is greater than one;
- peak concurrent requests;
- average concurrency while active;
- concurrency factor.

`average_concurrency_while_active` and `concurrency_factor` are both `interval_compute_ms / active_wall_ms` for the same exact interval set.

## Idle time

Idle time is emitted only when every request in the analyzed set has an exact start/end interval. It is:

`interval bounds span - union(active request intervals)`

If any request lacks an exact interval, idle time is unknown. No arbitrary timestamp-gap heuristic is used.

## Session span

Session span is based on the first and last observation timestamps. It may include idle gaps and is never labeled active time.

## Percentiles

The engine reports nearest-rank p50, p95 and p99 for:

- request wall duration;
- TTFT;
- output tokens per second.

Unknown samples are excluded rather than treated as zero.

## UTC hour/day rollups

First-release calendar rollups use UTC boundaries.

Request count and token usage are attributed once, to the bucket containing request start time when available, otherwise observation time.

Exact interval compute and active wall time are clipped across every bucket they intersect. A request crossing an hour or day boundary therefore contributes time to both buckets without duplicating its tokens or request-start count.

A continuation bucket can have `request_count = 0` while `interval_request_count > 0`; this means a request started in an earlier bucket but remained active in this one.

## Session rollups

Session rollups group exact session IDs and preserve events with no session ID as an explicit `null` group.

## Token categories

Time rollups preserve separate totals for:

- uncached input;
- output;
- reasoning;
- cache read;
- cache write;
- provider-specific cached input.

No cost calculation happens inside the time engine. Cost/efficiency composition belongs to Task 28.

## Acceptance proof

Task 27 covers:

- timestamp-derived request timing;
- reported-duration fallback;
- unknown timing preservation;
- parallel active-wall union;
- compute versus wall separation;
- overlap and peak concurrency;
- exact idle gaps and unknown-idle behavior;
- deterministic p50/p95/p99;
- UTC hour/day token/time rollups;
- session rollups including null session;
- session span versus active wall distinction;
- exact bucket-boundary interval splitting without token duplication.

Full inherited suite at Task 27: 187 / 187 passing.
