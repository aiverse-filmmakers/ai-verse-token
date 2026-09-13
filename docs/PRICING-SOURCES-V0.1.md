# Pricing Sources v0.1

**Task:** 16 / 32

## Trust boundary

Pricing source trust is host configuration. A fetched document, model response, collector payload or price snapshot cannot create its own trusted source definition.

A snapshot's `source_id` and `authority` must agree with the trusted registry before it can authorize calculated cost.

## Authority order

From strongest to weakest:

1. `provider_pricing_api`
2. `official_public_pricing`
3. `secondary_catalog`

Provider APIs and official public pricing can authorize `CALCULATED` cost only when they are fresh, applicable to the billing platform, and verified or cross-checked.

Secondary catalogs are discovery and cross-check inputs only. They never authorize `CALCULATED` by themselves.

## First-release trusted sources

Authoritative source IDs:

- `openai-official-pricing`
- `anthropic-official-pricing`
- `google-gemini-official-pricing`
- `openrouter-models-api`
- `commandcode-official-pricing`
- `z-ai-official-pricing`

Secondary source IDs:

- `pydantic-genai-prices`
- `portkey-models`
- `litellm-model-cost-map`

Task 17 attaches fetchers to source IDs. Registration here does not claim that every source already has a working network fetcher.

## Freshness

Authoritative first-release pricing requires both:

- age no greater than 24 hours;
- retrieval on the same UTC calendar day as the pricing decision.

The same-day rule is intentionally stricter than a rolling 24-hour window because first release promises same-day pricing refresh.

Secondary catalogs use a seven-day discovery window. Their freshness does not upgrade their authority.

Up to five minutes of future source clock skew is tolerated. Larger future timestamps fail closed.

## Verification

`verified` and `cross_checked` are sufficient verification states for authoritative sources.

`unverified` and `disputed` are not sufficient.

Verification alone never upgrades a secondary source to official authority.

## Ranking

When candidates have already passed identity/effective matching, ranking uses:

1. ability to authorize calculated cost;
2. registered source authority;
3. verification quality;
4. retrieval recency;
5. deterministic source/snapshot identifiers.

A newer secondary price therefore cannot silently replace an older but still fresh official tariff.
