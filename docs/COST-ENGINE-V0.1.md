# Cost Engine v0.1

**Task:** 18 / 32  
**Status:** COMPLETE

## Purpose

The cost engine turns one canonical usage event plus immutable price snapshots into exactly one monetary truth state:

- `ACTUAL` when the event already carries a trusted runtime/provider-reported charge;
- `CALCULATED` when exact usage can be rated against one authoritative verified tariff;
- `UNKNOWN` when the amount cannot be proven safely.

`UNKNOWN` is never represented as zero.

## Precedence

`actual_charge` always wins over tariff calculation, including a real zero-dollar charge. The engine does not overwrite provider/runtime-reported money with its own calculation.

## Calculated-cost requirements

A calculated result requires:

- authoritative usage quality: provider-reported, runtime-reported or derived-exact;
- exact billing platform;
- exact resolved model;
- request `started_at` so backfills are not priced using observation time;
- an effective tariff matching event time;
- enough identity/condition dimensions to choose one tariff safely;
- authoritative registered pricing source and sufficient verification;
- same-day fresh source evidence for events occurring today;
- all usage dimensions charged by the selected tariff.

## Historical correctness

Historical events select snapshots by the historical request timestamp. Old verified effective tariffs remain usable even after today's pricing changes. Current pricing is never substituted for an older event merely because it is newer.

## Conditional selection

The engine supports:

- service tier, region, billing mode, provider-model and inference-provider specificity;
- effective start/end intervals;
- UTC weekday and time windows;
- input/context token thresholds;
- cache TTL thresholds supplied by rating context.

If a specific tariff might apply but the event lacks the required dimension, the result is `UNKNOWN` rather than a generic fallback.

## Exact arithmetic

Public tariff amounts are decimal strings. Cost calculation uses integer/rational arithmetic backed by `bigint`; JavaScript floating-point multiplication is not used for calculated money.

Component costs are returned by tariff field and summed exactly. A rate that cannot be represented as an exact finite decimal fails closed rather than being silently rounded.

## Source policy

Provider pricing APIs outrank official public pages. Secondary catalogs remain discovery/cross-check inputs and can never authorize `CALCULATED` money by themselves.

Equal-rank conflicting authoritative tariffs fail as ambiguous.
