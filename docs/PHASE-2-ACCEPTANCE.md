# Phase 2 Pricing Acceptance

**Task:** 20 / 32  
**Status:** PASSED

The Phase 2 gate composes identity resolution, immutable/effective pricing, source authority, freshness evidence, cost calculation and trusted actual-charge ingestion.

Verified release laws:

1. historical requests use historical effective tariffs, never today's replacement tariff;
2. service-tier and context-tier pricing requires exact dimensions;
3. cache zero remains known zero while missing cache usage remains unknown;
4. unknown or near-name models are never fuzzy-priced;
5. conflicting exact model evidence remains ambiguous and unpriceable;
6. stale current pricing cannot authorize `CALCULATED` cost;
7. trusted provider/runtime `ACTUAL` cost wins over tariff calculation;
8. `UNKNOWN` has no amount field and is structurally distinct from a real zero-dollar charge.

Verification on Task 20 completion:

- `npm run check`: PASS;
- `npm test`: PASS, 123 / 123 tests;
- Phase 2 acceptance tests: 8 / 8 PASS.

**Phase 2 gate: PASSED.**
