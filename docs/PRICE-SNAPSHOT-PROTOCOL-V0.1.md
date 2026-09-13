# Price Snapshot Protocol v0.1

**Task:** 15 / 32  
**Protocol:** `ai-verse-token-price/0.1`

## Purpose

A price snapshot is an immutable pricing fact used later by the pricing registry and cost engine. It records exactly which billing platform/model identity a tariff applies to, when it applies, the charging dimensions it defines, and where the fact came from.

A snapshot is not an invoice, a subscription ledger or a claim that a user was billed the calculated amount.

## Identity

Every snapshot requires:

- `billing_platform`
- `resolved_model`

It may additionally narrow the tariff by:

- `inference_provider`
- `provider_model_id`
- `service_tier`
- `region`
- `billing_mode`

Absent optional identity dimensions mean the snapshot does not constrain that dimension. They are not silently replaced with guessed values.

## Effective dating

`effective.starts_at` is inclusive. `effective.ends_at`, when present, is exclusive.

A price may also be limited by:

- specific UTC weekdays;
- one or more UTC time windows;
- context-token bounds;
- cache-TTL bounds.

Cross-midnight price windows are represented as separate rules. This avoids ambiguous time-window matching.

## Context conditions

Context thresholds are explicit about their basis:

- `input_tokens`
- `input_plus_cache_read_tokens`

Bounds use `min_inclusive` and `max_exclusive`. No hidden context threshold is inferred.

## Monetary representation

Tariff amounts are decimal strings, never JavaScript floating-point numbers.

Example:

```json
{
  "input_tokens": {
    "amount": "3.00",
    "per": 1000000
  }
}
```

This means `3.00` units of the snapshot currency per 1,000,000 input tokens.

A known zero price is represented as `"0"`. Missing rate dimensions remain missing. Zero and unknown are therefore distinct.

Supported first-release rate dimensions mirror canonical usage dimensions:

- input tokens
- output tokens
- reasoning tokens
- cache-read tokens
- cache-write tokens
- cached-input tokens
- audio-input tokens
- audio-output tokens
- image-input units
- image-output units
- web-search units
- request units

At least one rate is required.

## Source provenance

Every snapshot records:

- source authority;
- source ID;
- retrieval timestamp;
- optional source URL;
- optional source publication timestamp;
- optional ETag;
- optional SHA-256 source-content digest.

Source authorities are closed to:

- `provider_pricing_api`
- `official_public_pricing`
- `secondary_catalog`

Task 16 defines source precedence. A secondary catalog is never upgraded to official authority merely because its data validates.

## Verification

Verification status is one of:

- `verified`
- `cross_checked`
- `unverified`
- `disputed`

`verified` and `cross_checked` require `verified_at` at or after the source retrieval time.

Freshness is deliberately not stored as an immutable `fresh` or `stale` flag. Freshness changes as time passes. The immutable snapshot stores `retrieved_at` and `verified_at`; Task 16 applies source-specific freshness policy at query time, and Task 17 refreshes stale sources.

This lets the system enforce same-day pricing without rewriting historical price facts.

## Historical pricing rule

A later price snapshot does not rewrite an earlier usage event's tariff. Task 18 will resolve the tariff effective at the event time.

Open-ended historical snapshots can coexist with newer snapshots. The pricing registry will resolve them using effective time, exact identity and source precedence rather than mutating older snapshots.

## Security and validation

The runtime validator:

- rejects unknown fields;
- rejects NUL-containing strings;
- rejects numeric/floating tariff amounts;
- rejects exponent-form money;
- rejects invalid currencies;
- rejects embedded credentials in source URLs;
- rejects malformed SHA-256 digests;
- rejects inverted effective intervals and condition bounds;
- rejects duplicate weekdays/windows;
- rejects empty tariff sets.

Machine-readable schema: `schemas/price-snapshot-v1.schema.json`.
