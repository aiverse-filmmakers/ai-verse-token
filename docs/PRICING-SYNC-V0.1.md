# Pricing Synchronization v0.1

**Task:** 17 / 32

## Goal

Keep current pricing evidence fresh without mutating historical tariff facts.

## Storage layout

Pricing data is intentionally separate from the high-volume usage SQLite ledger:

```text
pricing/
  snapshots/     immutable validated price snapshots
  sync-state/    append-only source check observations
```

Snapshot filenames are derived from SHA-256 of the snapshot ID, so untrusted model/provider identifiers never become filesystem paths.

A repeated snapshot ID with identical content is an idempotent duplicate. The same ID with different content fails as a conflict.

## Refresh triggers

The synchronizer supports:

- startup refresh when a source is stale;
- periodic refresh while the process is active, default direction six hours;
- manual refresh;
- forced refresh when an otherwise exact model identity has no known price.

Unknown-model refresh ignores an otherwise fresh source state because a model may have been added since the last source check.

## Same-day freshness

Task 16 requires authoritative current pricing to be checked on the same UTC day.

A successful updated response stores new immutable snapshots and a source-check observation.

A successful `not_modified` response does not clone every unchanged snapshot. Instead it records a fresh check tied to the previous ETag and/or SHA-256 content digest.

Task 16 can use that recheck as freshness evidence only when its ETag or content digest matches the immutable snapshot. A different or missing content token cannot make an old snapshot fresh.

This provides same-day evidence without rewriting history or duplicating thousands of unchanged prices.

## Fetcher contract

Each fetcher is attached to a pre-registered trusted source ID.

Input includes:

- source ID;
- refresh reason;
- current time;
- previous ETag/content digest when available;
- model/platform hints for unknown-model refresh.

A fetcher returns either:

- `updated` with one or more pricing snapshots;
- `not_modified` with ETag/digest continuity evidence.

The synchronizer stamps the trusted source ID, authority and retrieval timestamp. Fetched payload text cannot self-promote its authority.

Provider-specific HTTP/page/API parsing is intentionally deferred to the relevant provider adapter tasks. This task supplies the synchronization and persistence engine they plug into.

## Failure behavior

Fetch exceptions persist only stable `FETCH_FAILED` state. Raw exception messages are not stored, reducing the chance of URLs, credentials or tokens entering local sync metadata.

Malformed fetch output records `SYNC_INVALID` and does not advance the last successful check.

The previous successful ETag, digest and checked timestamp survive a failed later attempt.

## Periodic execution

The built-in periodic loop:

- defaults to six-hour checks;
- refreshes only stale sources;
- prevents overlapping periodic passes;
- can be stopped idempotently;
- uses an unref'ed Node timer so it does not keep a process alive by itself.
