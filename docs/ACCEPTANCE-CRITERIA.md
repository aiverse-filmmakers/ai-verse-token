# First Release Acceptance Criteria

## Accounting truth

- Exact provider-reported cost always wins over derived ratings.
- Historical usage resolves price by event time, not current time.
- Unknown model/tier/price produces `unpriced`, never guessed exact cost.
- Cost components are independently auditable.
- Subscription fixed fees are not arbitrarily amortized per request.
- Original currency is retained.

## Usage truth

- Input/output/cache/reasoning categories preserve source semantics.
- Unknown is distinguishable from zero.
- Duplicate ingestion is idempotent.
- Requested and resolved model are separate.
- Billing platform is separate from model author/provider.

## Time truth

- Request wall time, TTFT and generation time are distinct.
- Parallel durations do not inflate active wall time.
- Compute time may exceed active wall time and is labeled correctly.
- Missing timing remains missing.

## Integration

- Standalone works without AI-Verse OS.
- AI-Verse native install touches only its extension directory and registry entry.
- Hermes collector is read-only.
- Dashboard consumes a read-only projection.
- MCP/agents use bounded APIs, never direct DB access.

## Privacy

- Normal operation stores no prompt/response content.
- Secrets are never stored in telemetry rows.
- Export can pseudonymize project/workspace identifiers.

## Reliability

- SQLite reopen recovers exact committed state.
- Corrupt/incompatible format fails closed.
- Collector failure does not corrupt unrelated ledger state.
- Price sync failure preserves existing snapshots and health state.
- Reconciliation is append-only/auditable.

## Performance

Targets to validate during implementation:

- local incremental scan should avoid reparsing unchanged histories;
- query paths should remain responsive at millions of usage events;
- live instrumentation must not materially delay provider requests;
- price lookup should be local after refresh, not a network call for every token event.
