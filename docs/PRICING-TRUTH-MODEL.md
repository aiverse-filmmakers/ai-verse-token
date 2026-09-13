# Pricing Truth Model

## 1. Requirement

AI-Verse Token must never present a guessed amount as real spend.

Usage facts and price facts stay separate. Every displayed monetary value has one of three statuses: `ACTUAL`, `CALCULATED`, or `UNKNOWN`.

## 2. ACTUAL

Use `ACTUAL` only when a trusted runtime or billing platform directly reports the charge for the relevant request/generation/record.

Examples:

- OpenRouter generation `total_cost`;
- Hermes `actual_cost_usd` when its source identifies a trusted billing route;
- a gateway/provider request record with an authoritative monetary charge.

A real zero-dollar charge is valid `ACTUAL` data. It is not the same as unknown.

## 3. CALCULATED

Use `CALCULATED` when Token has:

- authoritative usage quantities;
- unambiguous billing platform and model identity;
- the event timestamp;
- all pricing dimensions required by the tariff that are known to apply;
- a verified effective tariff.

The result is deterministic public-tariff pricing. It is not labeled invoice-confirmed billing.

## 4. UNKNOWN

Use `UNKNOWN` whenever Token cannot safely establish the amount.

Examples:

- ambiguous model alias;
- missing required service tier;
- stale/unverified pricing with no safe effective tariff;
- subscription/private-contract behavior that Token does not model;
- incomplete usage categories required by the tariff.

Unknown must never be rendered as `$0`.

## 5. Source priority

For first release:

```text
1. trusted provider/runtime-reported actual request charge -> ACTUAL
2. verified official effective tariff + authoritative usage -> CALCULATED
3. otherwise -> UNKNOWN
```

Pydantic genai-prices, Portkey Models and LiteLLM may help discovery and cross-checking. They do not silently override a trusted actual charge or promote an ambiguous tariff to authoritative.

## 6. Historical correctness

Tariffs are immutable effective-dated snapshots.

An event from June is priced using the verified rule effective in June, even if a different rule is current in September. A fresh price sync must not silently reprice historical events with today's tariff.

## 7. Conditional pricing

A tariff may include known dimensions such as:

- effective start/end;
- day/time windows;
- context thresholds;
- region;
- service tier;
- cache category/TTL;
- batch/flex/priority mode;
- modality/additional units.

Token only calculates when the event supplies enough information to choose the applicable rule safely.

## 8. Model aliases

Store requested and resolved identities separately:

```text
requested_model
resolved_model
provider_model_id
alias_rule_id
```

Exact alias mappings may be versioned. Fuzzy matching is diagnostic only and cannot authorize cost calculation.

## 9. Billing platform versus model author

Billing route controls pricing.

For example, a Claude model billed through OpenRouter is not automatically priced using Anthropic-direct rates. Runtime, billing platform, inference provider and model are separate identities.

## 10. Subscriptions, credits and private contracts

First release does not attempt to amortize subscription fees, settle credit pools or model private enterprise contracts.

If the platform exposes a direct request charge, Token can store it as `ACTUAL`. Otherwise, if public tariff calculation is not representative or cannot be proven, the cost remains `UNKNOWN`.

This is intentionally conservative.

## 11. Currency

Actual charges retain their original currency. Calculated costs use the tariff currency.

Cross-currency financial accounting is deferred. A future display conversion must never overwrite the source amount.
