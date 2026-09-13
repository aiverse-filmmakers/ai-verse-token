# Efficiency, budgets and quota windows v0.1

## Purpose

Task 28 turns canonical usage, timing and cost results into bounded efficiency and control signals without inventing missing telemetry or turning AI-Verse Token into a billing system.

## Efficiency metrics

`@ai-verse/token/efficiency` provides `analyzeEfficiency()`.

It reports:

- request count;
- total-token known lower bound with completeness metadata;
- cache-read ratio;
- reasoning share;
- known compute time plus completeness;
- known active-wall time plus completeness;
- cost totals separated by currency and by `ACTUAL` versus `CALCULATED` truth;
- optional grouping by session, task, runtime, billing platform, inference provider, resolved model, workspace, project, agent, bot or worker;
- explicit retry tax.

Unknown values do not become zero. Ratios are returned only when every event needed for the ratio exposes the required counters. Exact integer totals are emitted as decimal strings so aggregation can exceed JavaScript's safe-integer ceiling without loss.

## Retry tax

Retry tax is never inferred from time proximity, model similarity, prompt similarity or trace shape.

The caller must supply explicit `{ retry_event_id, original_event_id }` links. Links:

- must reference known canonical events;
- cannot self-reference;
- cannot duplicate a retry event;
- cannot form a cycle.

Only explicitly linked retry events contribute to retry requests, retry tokens, retry compute time and retry cost.

## Cost aggregation

Costs remain split by currency. USD and EUR are never added together.

For each currency, the result preserves:

- provider/runtime `ACTUAL` cost;
- official-rate `CALCULATED` cost;
- known total for that currency;
- unknown-event coverage.

No currency conversion is performed by this layer.

## Budgets

`evaluateBudget()` supports:

- requests;
- total tokens;
- compute milliseconds;
- active-wall milliseconds;
- monetary cost in one explicit currency.

States are:

- `OK` - complete data and below warning threshold;
- `WARNING` - complete data and at or above the warning threshold;
- `EXCEEDED` - the known lower bound has reached or exceeded the limit;
- `UNKNOWN` - missing data prevents a safe remaining-capacity claim.

The default warning threshold is 80 percent and is configurable per budget.

### Lower-bound rule

Missing data cannot produce optimistic remaining capacity.

If Token knows 80,000,001 tokens were consumed but at least one event has incomplete token data against a 100,000,000-token budget, the result is `UNKNOWN`, with `known_used=80000001` and no remaining value.

If the known lower bound itself reaches/exceeds the limit, the result is `EXCEEDED` even if other events are incomplete.

### Time budgets

Compute budgets use summed known request durations.

Active-wall budgets use the exact union of request intervals. Parallel 10-second requests overlapping by 5 seconds therefore consume 20 seconds of compute but 15 seconds of active wall.

If any request lacks the timing evidence required by a time budget, the budget is incomplete and follows the lower-bound rule.

### Monetary budgets

Money uses exact decimal arithmetic for totals and remaining amounts. Floating-point subtraction is not used for monetary remaining capacity.

A monetary budget names one currency. Events whose known cost is in another currency make the budget incomplete unless the caller filtered them out before evaluation. `CALCULATED` cost may be excluded when a budget should consider only provider-confirmed `ACTUAL` spend.

## Quota windows

`evaluateQuotaWindows()` accepts provider capacity windows such as five-hour, weekly or monthly limits and returns:

- used;
- limit;
- remaining;
- utilization;
- reset timestamp;
- `OK`, `WARNING` or `EXCEEDED` state.

Quota windows remain provider capacity facts. They are not amortized into request costs or treated as invoice accounting.

## Non-goals

Task 28 does not add:

- invoice reconciliation;
- subscription amortization;
- FX conversion;
- private contract pricing;
- heuristic retry detection;
- prompt/response inspection;
- caller-supplied SQL.

## Acceptance proof

`test/efficiency-budgets.test.mjs` verifies ratio missingness, multi-currency truth separation, dimensional grouping, explicit retry tax, lower-bound budget behavior, exact decimal money, parallel active-wall accounting, quota windows and exact integer accumulation above `Number.MAX_SAFE_INTEGER`.

Full inherited suite at Task 28: **200 / 200 passing**.
