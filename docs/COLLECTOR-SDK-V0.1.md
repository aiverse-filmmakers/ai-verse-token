# Collector SDK v0.1

## Purpose

The collector SDK is the trusted boundary between external usage sources and the canonical AI-Verse Token ledger. A collector may detect and read its own source, normalize source facts into `ai-verse-token/0.1` usage events, and advance its own incremental checkpoint. It does not gain authority over another collector, another runtime, pricing truth, or arbitrary ledger state.

## Registration

Each collector registers a frozen definition:

- `id`: stable collector identifier;
- `version`: collector implementation version;
- `runtimes`: explicit runtime allow-list or `*` for a genuinely runtime-neutral collector.

Duplicate collector IDs fail closed. Runtime lists may not be empty or contain duplicates.

## Detection and health

`detect(source)` returns one of:

- `available` - source is present and suitable for collection;
- `unavailable` - source is absent, so collection is not attempted;
- `degraded` - useful collection is possible but the source is incomplete or partially available.

Detection codes are stable uppercase machine-readable codes. Detection exceptions are wrapped as collector failures rather than being interpreted as source absence.

## Incremental collection

The runner reads only the selected collector's checkpoint and supplies it to `collect()` together with:

- the caller-supplied source handle;
- checkpoint key;
- previous checkpoint cursor or `null`;
- a hard-bounded `max_events` value.

First-release limits are:

- default events per scan: `1000`;
- hard maximum events per scan: `10000`.

A collector may emit fewer events and report whether the scan is complete. It cannot exceed the requested limit.

## Emission contract

Every emission contains:

- one canonical usage event;
- the checkpoint cursor that becomes valid with that event;
- optional correlation keys used by later cross-source deduplication.

Before ingest, the runner validates the full usage event and enforces:

1. `provenance.collector_id` exactly matches the registered collector ID;
2. a supplied `provenance.collector_version` exactly matches the registered version;
3. `source.runtime` is within the collector's registered runtime scope;
4. the checkpoint cursor is bounded and contains no NUL.

A collector therefore cannot impersonate another collector or silently submit events for an unregistered runtime.

## Checkpoints and replay

Each emitted event and its checkpoint advancement are committed through the ledger's existing transactional ingest primitive. Exact/source duplicate replay remains a no-op for the canonical event while the collector checkpoint may still advance to the newer source cursor.

This permits safe rescans without double-counting and without maintaining a second checkpoint database.

## Source isolation

The SDK does not open source databases, files, APIs, or credentials itself. Those responsibilities belong to concrete collectors or source adapters. The runner receives an opaque source value and does not mutate it.

Concrete collectors must preserve their source's authority boundary. For example, the Hermes collector is required to open Hermes databases read-only and must never write Hermes state.

## Explicit non-goals

The collector SDK does not:

- infer or fuzzy-match model identity;
- authorize pricing;
- convert estimated cost into `ACTUAL`;
- store prompt or response content;
- permit caller-supplied SQL;
- schedule recurring collection;
- grant credentials or cross-source authority;
- solve cross-source deduplication by itself.

Identity resolution, pricing, actual-cost trust, scheduling, and cross-source correlation remain separate layers.

## Acceptance

Task 21 passes only when tests prove:

- registration validation and duplicate rejection;
- normal event ingest and checkpoint advancement;
- prior checkpoint delivery for incremental scans;
- unavailable sources do not collect or mutate the ledger;
- degraded collection remains visible in health;
- collector/version impersonation fails closed;
- unregistered runtime emission fails closed;
- requested and emitted batch sizes are bounded;
- duplicate replay does not double-count while checkpoint advancement remains safe.
