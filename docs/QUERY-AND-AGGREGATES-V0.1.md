# AI-Verse Token Query and Aggregates v0.1

Task 13 exposes bounded read surfaces over immutable usage telemetry.

## Query

`TokenLedger.queryUsage()` supports only fixed, validated filters over canonical dimensions. Time windows are half-open: `observed_from <= observed_at < observed_to`.

Ordering is deterministic by `(observed_at, event_id)`. Pagination uses an opaque versioned cursor and fetches at most `limit + 1` rows to determine whether another page exists.

Default page size is 100. Hard maximum is 500.

Explicit `null` is meaningful for nullable dimensions, for example `{ billing_platform: null }` selects events whose billing platform is unknown. An absent filter does not constrain that dimension.

## Aggregate

`TokenLedger.aggregateUsage()` accepts:

- at most four dimensions from a closed allowlist;
- at most sixteen metrics;
- `count`, `sum`, `avg`, `min`, `max`;
- usage and timing fields only in Phase 1;
- at most 500 result groups.

Monetary aggregation is intentionally absent before the pricing/currency truth model is implemented.

Integer count/sum/min/max values are selected as decimal text from SQLite, then returned as a JavaScript number only while they remain safe integers. Larger exact integers remain decimal strings rather than silently losing precision.

## No arbitrary SQL

Callers cannot provide SQL, identifiers, operators, expressions, sort clauses or aggregate aliases. Runtime validators reject unknown request keys and unsupported dimensions/fields.
