# AI-Verse Token hardening audit - 2026-09-12

Status: hardened alpha.1 release candidate.

This audit was performed after the original alpha.0 first-release gate. It deliberately reviewed the implementation from independent correctness, accounting, storage, security, scalability, privacy, integration and packaging perspectives rather than treating a green test count as sufficient proof.

## Audit perspectives

The review covered:

- canonical protocol and JSON Schema parity;
- exact usage and missing-value semantics;
- provider/model/runtime/billing identity;
- immutable ingest, idempotency and cross-source deduplication;
- historical and current pricing selection;
- `ACTUAL`, `CALCULATED` and `UNKNOWN` monetary truth;
- request/session/hour/day timing and concurrency math;
- SQLite format, integrity, schema tamper resistance and path safety;
- Hermes and local coding-agent collectors;
- direct-provider, gateway and OpenTelemetry adapters;
- pricing snapshot filesystem safety;
- AI-Verse OS native install/update/disable/uninstall behavior;
- Dashboard, Brain, Memory, Data, Bots and correlation boundaries;
- CLI/MCP/export privacy;
- long-running collector scalability;
- TypeScript dead-code checks, packaging and clean-install release acceptance.

## Material findings fixed

### Aggregate truth

Token totals no longer present a partial sum as an exact total when any contributing event has an unknown value. Unknown remains unknown. Large integer token sums use exact BigInt-backed aggregation rather than SQLite integer `SUM()` or unsafe JavaScript number conversion.

### Context-sensitive pricing

`context_input_tokens` is now a first-class fact. Provider-inclusive prompt/context size is preserved separately from uncached/cache billing components, preventing cached large-context requests from selecting an incorrect lower context tariff.

### Exact ACTUAL money

Canonical provider/runtime-reported monetary amounts are exact decimal strings, not floating-point numbers. SQLite stores them as text and the cost/read layers preserve them exactly. Numeric integration inputs are canonicalized immediately at the boundary.

### Dedupe and attribution

Strongly correlated observations retain the meaningful user-facing runtime, while Token's correlator remains provenance rather than becoming the runtime. Conflicting exact request/session/run/task identities fail closed instead of silently choosing one observation.

### Timing correctness

Supplied timing milestones must form a possible monotonic sequence. Time rollups preserve missing token data as unknown, preserve exact large integer totals and count exact zero-duration requests in concurrency.

### Hermes cost truth

Hermes money becomes Token `ACTUAL` only when Hermes explicitly reports `cost_status=actual`, supplies a valid source and provides a non-negative amount. A genuine actual zero is preserved; estimate/unknown zero is never promoted to real zero.

### Anthropic billable units

Anthropic `server_tool_use.web_search_requests` is preserved as `web_search_units`, allowing verified search-unit tariffs to be rated rather than silently omitted. Synthetic totals are no longer mislabeled as provider-reported totals.

### SQLite integrity

The ledger rejects a symlinked final database path. Format verification compares required SQLite object definitions, not only their names, so a same-named but weakened immutability trigger is rejected. Ledger format is now version 2.

### Pricing store safety

Pricing state rejects symlinked/invalid nodes, oversized or corrupt files and unsafe source identifiers. Store nodes are validated before they are allowed to influence `CALCULATED` money.

### AI-Verse lifecycle safety

Native lifecycle path checks detect dangling symlinks. Owned-file materialization/removal has rollback protection, install/update/uninstall preflight Token-owned paths, registry lock errors distinguish contention from write failure, sibling registrations remain preserved, and Token telemetry state still survives uninstall/reinstall.

### Privacy

Privacy-safe projections now remove provider-side `external_charge_id` in addition to source fingerprints and raw source-record IDs. Explicit raw/debug export remains available when provenance IDs are intentionally requested.

### Collector scalability

Hermes and OpenCode incremental scans push checkpoint/filter/limit work into SQLite instead of loading unbounded historical rows into Node and discarding most of them afterward.

### Protocol/schema parity

Runtime and published JSON Schema limits were reconciled, including identifier lengths, safe integer bounds, exact monetary representation and `context_input_tokens`.

## Version and storage compatibility

The hardened build is:

```text
@ai-verse/token@0.1.0-alpha.1
ledger format: 2
```

Alpha.1 intentionally does not claim byte-level compatibility with the unpublished alpha.0 ledger format. Opening a mismatched ledger fails closed instead of guessing or silently mutating it. Because alpha.0 was not published as a remote/npm release, no automatic alpha.0-to-alpha.1 migration is included in this release candidate.

## Verification proof

Post-hardening normal suite:

```text
249 / 249 passing
```

Serial release-acceptance suite:

```text
3 / 3 passing
```

Combined release checks exercised by `npm test`:

```text
252 / 252 passing
```

Coverage from the complete normal suite:

```text
Lines:     95.08%
Branches:  77.95%
Functions: 97.48%
```

Additional checks include:

- strict TypeScript compile;
- TypeScript compile with unused locals/parameters enabled;
- JSON parse and JSON Schema meta-validation;
- Markdown local-link validation;
- whitespace/diff checks;
- package dry-run;
- packed-artifact clean install;
- package import and CLI execution from the exact TGZ;
- release CI matrix contract validation.

## Remaining release/environment limitations

No known critical or high-severity correctness defect remains from this audit. That is not a claim that software can be proven bug-free.

The remaining limitations are explicit:

1. The GitHub Actions matrix for Ubuntu/macOS/Windows with Node 22/24 is configured and contract-tested locally, but hosted jobs cannot be claimed as executed until a remote GitHub repository exists.
2. `CALCULATED` means exact known usage rated against a verified matching tariff. It is deliberately not invoice reconciliation and does not model private enterprise discounts unless they are supplied by a trusted integration.
3. Canonical Token monetary storage is exact decimal text. If an upstream SDK has already parsed a provider JSON number into a JavaScript `number`, precision beyond that upstream representation cannot be reconstructed. Integrations should pass the original decimal string whenever one is available.
4. Node's built-in SQLite API can emit an experimental warning on supported Node 22 releases. The package release gate tests the supported runtime behavior rather than suppressing that warning.

## Release conclusion

The hardening audit found and fixed multiple issues that could have produced believable but subtly incorrect analytics without necessarily crashing. The alpha.1 contracts now fail closed more consistently, preserve missingness and exact money more rigorously, resist storage/path tampering more strongly, and scale incremental collectors more safely.
