# AI-Verse Token Ingest and Dedupe v0.1

Task 11 defines append-only usage ingestion.

## Validation first

Every input is normalized through the canonical usage-event validator before SQLite begins a write transaction. Invalid telemetry never becomes ledger state.

## Two idempotency identities

1. `event_id` is the canonical event identity. Replaying the exact canonical event is a duplicate no-op. Reusing the same `event_id` for changed data is a conflict.
2. `(collector_id, source_record_fingerprint)` identifies the source record observed by one collector. A replay may use a new event ID, observation time or collector version and still dedupe to the original event. If the stable source facts changed under the same fingerprint, ingestion fails closed.

The source fingerprint unique index prevents same-collector double counting even under competing writers.

## Immutability

`usage_events` is append-only. SQLite triggers reject `UPDATE` and `DELETE`, so immutability does not depend on callers using the TypeScript API correctly.

Later derived identity/cost data must live in derived tables or projections rather than rewriting source telemetry.

## Checkpoints

A collector may advance one opaque checkpoint in the same `BEGIN IMMEDIATE` transaction as an insert or duplicate replay. A crash cannot commit the checkpoint while losing the corresponding event decision.

Checkpoint keys and cursors are bounded, NUL-free strings. Collectors must never put credentials or API secrets in checkpoint values.

## Cross-source correlation

Task 11 does not claim that observations from different collectors are duplicates. It records append-only correlation keys for Task 26's cross-source dedupe gate.

The ledger automatically records request IDs and provider-reported external charge IDs when present. Collectors can add bounded keys such as trace IDs or generation IDs.
