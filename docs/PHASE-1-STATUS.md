# Phase 1 Status

## Task 8 / 32 - Package, CLI, test and CI foundation

**Status:** COMPLETE

Implemented in this task:

- `@ai-verse/token` package identity at `0.1.0-alpha.1`;
- Node 22+ engine declaration;
- strict TypeScript compiler configuration;
- initial root and CLI exports;
- stable cost-status vocabulary: `ACTUAL`, `CALCULATED`, `UNKNOWN`;
- minimal CLI shell supporting `--help` and `--version` only;
- unknown/unimplemented commands fail with exit code 2 rather than pretending runtime features exist;
- Node built-in smoke tests;
- GitHub Actions Node 22/24 matrix;
- no collector, ledger, price, cost or AI-Verse runtime behavior implemented early.

Verification:

- `npm run check`: PASS;
- `npm test`: PASS, 4 / 4 tests;
- `npm pack --dry-run`: PASS, 12 packaged files;
- draft JSON Schemas: Draft 2020-12 schema validation PASS;
- relative Markdown links: PASS;
- no em dash characters in README/docs.

**Task 8 gate: PASSED.**

## Next

**Task 9 / 32 - Canonical protocol types and validators.**


## Task 9 / 32 - Canonical protocol types and validators

**Status:** COMPLETE

Implemented:

- runtime-neutral `ai-verse-token/0.1` usage-event types;
- strict source/runtime versus billing/provider/model identity separation;
- token, cache, reasoning, audio, image, search and request usage categories;
- request-level timing fields with start/end ordering checks;
- optional direct `actual_charge` distinct from later calculated cost;
- closed `ACTUAL`, `CALCULATED`, `UNKNOWN` status vocabulary;
- exact unknown/null/zero preservation;
- strict unknown-field rejection, NUL rejection, finite/safe numeric ceilings and timezone-aware date validation;
- mandatory `content_stored: false`;
- machine-readable JSON Schema parity check;
- `@ai-verse/token/protocol` package export;
- `docs/PROTOCOL-V0.1.md`.

Verification:

- `npm run check`: PASS;
- `npm test`: PASS, 12 / 12 tests;
- JSON Schema sample validation: PASS;
- schema structural validation: PASS;
- relative Markdown links: PASS.

**Task 9 gate: PASSED.**

## Task 10 / 32 - SQLite ledger and format metadata

**Status:** COMPLETE

Implemented:

- native Node SQLite ledger with no external runtime dependency;
- minimum runtime Node 22.5 because `node:sqlite` begins there;
- WAL journal mode, `synchronous=FULL`, foreign keys, trusted schema off and bounded busy timeout;
- explicit `application_id`, `user_version` and mirrored metadata-table format identity;
- safe `create-or-open`, `open-existing` and `read-only` modes;
- foreign/non-empty SQLite databases are never adopted or overwritten;
- every open performs `quick_check`; explicit full `integrity_check` is available;
- idempotent close and fail-closed access after close;
- first-release `usage_events` storage columns and query indexes reserved without exposing writes early;
- no prompt, response, credential, API-key or secret columns;
- SQLite-level `content_stored = 0` invariant;
- `@ai-verse/token/storage` package export;
- `docs/STORAGE-V0.1.md`.

Verification:

- `npm run check`: PASS;
- `npm test`: PASS, 20 / 20 tests;
- create, reopen, read-only, foreign-database, metadata-tamper, privacy and closed-state tests: PASS.

**Task 10 gate: PASSED.**

## Task 11 / 32 - Idempotent immutable ingest and dedupe primitives

**Status:** COMPLETE

Implemented:

- strict protocol validation before any write transaction;
- canonical `event_id` replay as an idempotent no-op;
- unique `(collector_id, source_record_fingerprint)` source-record identity;
- same-source replay dedupe across new observation times, event IDs and collector versions;
- changed source facts under a reused fingerprint fail closed;
- raw SQLite `UPDATE` and `DELETE` blocked by append-only triggers;
- atomic event/dedupe decision plus collector-checkpoint advancement;
- automatic request/external-charge correlation keys plus collector-supplied bounded keys;
- append-only correlation records reserved for later cross-source dedupe;
- read-only ingest rejection and bounded/NUL-free checkpoint/correlation metadata;
- `docs/INGEST-AND-DEDUPE-V0.1.md`.

Verification:

- `npm run check`: PASS;
- `npm test`: PASS, 30 / 30 tests;
- exact replay, fingerprint replay, conflict, immutability, checkpoint, correlation and read-only cases: PASS.

**Task 11 gate: PASSED.**

## Task 12 / 32 - Runtime/platform/provider/model identity resolver

**Status:** COMPLETE

Implemented:

- runtime, billing platform and inference provider remain separate dimensions;
- exact platform alias canonicalization for known direct/gateway identifiers;
- unknown source platforms are never silently promoted to billing platforms;
- effective-dated exact model aliases scoped to billing platform and exact match field;
- exclusive effective-end semantics for versioned aliases;
- overlapping same-key alias intervals rejected at resolver construction;
- conflicting requested-model/provider-model evidence becomes `ambiguous`;
- explicit resolved-model conflicts with alias evidence become unpriceable;
- direct provider platform can fill inference provider without rewriting model text;
- no fuzzy, prefix, typo or similarity matching can authorize pricing identity;
- immutable event-resolution helper returns a newly validated event;
- `@ai-verse/token/identity` export and `docs/IDENTITY-RESOLUTION-V0.1.md`.

Verification:

- `npm run check`: PASS;
- `npm test`: PASS, 39 / 39 tests;
- exact alias, effective-date boundary, overlap, ambiguity, no-fuzzy and immutable-event cases: PASS.

**Task 12 gate: PASSED.**

## Task 13 / 32 - Bounded query and aggregate engine

**Status:** COMPLETE

Implemented:

- strict fixed-filter query surface over immutable canonical events;
- deterministic `(observed_at, event_id)` ordering;
- versioned opaque cursors with no overlap across pages;
- ascending/descending queries and half-open observed-time windows;
- explicit null filtering distinct from absent filters;
- request/session/task/runtime/model/provider/platform and AI-Verse scope filters;
- group-by allowlist covering runtime, platform, provider, model, agent, project, workspace, Bot/Worker and task;
- `count`, `sum`, `avg`, `min`, `max` over bounded usage/time fields;
- no monetary aggregation before pricing/currency truth exists;
- exact integer aggregate preservation beyond JavaScript safe-integer range via decimal strings;
- hard limits: 500 events/page, 500 groups, four dimensions, sixteen metrics;
- unknown SQL-shaped keys, fields, dimensions and malformed cursors fail closed;
- read-only ledgers can query and aggregate;
- `@ai-verse/token/query` and `docs/QUERY-AND-AGGREGATES-V0.1.md`.

Verification:

- `npm run check`: PASS;
- `npm test`: PASS, 47 / 47 tests;
- pagination, time windows, null semantics, grouped aggregates, truncation and SQL-shaped input rejection: PASS.

**Task 13 gate: PASSED.**

## Task 14 / 32 - Core acceptance gate

**Status:** COMPLETE

Acceptance proof composes Tasks 8-13 with no new feature surface:

- persistence and reopen through file-backed SQLite;
- exact zero, explicit null and source-absent fields remain distinct after reopen;
- exact identity enrichment before immutable ingest;
- replay/dedupe leaves one canonical event and checkpoint progress persists;
- WAL permits independent writers and read-only readers without duplicate state;
- required tables, indexes and immutability triggers are verified on open;
- required-schema tampering fails closed;
- malformed non-SQLite bytes are rejected and left byte-identical;
- read-only queries and aggregates work after reopen;
- CI workflow contract contains Node 22 and Node 24 jobs.

Verification:

- `npm run check`: PASS;
- `npm test`: PASS, 52 / 52 tests;
- Phase 1 integration acceptance: PASS;
- local runtime: Node 22.16;
- Node 24 is defined in the GitHub Actions matrix and will execute once a remote repository exists.

Detailed proof: `docs/PHASE-1-ACCEPTANCE.md`.

**Task 14 gate: PASSED.**
**Phase 1 gate: PASSED.**

## Next

**Task 15 / 32 - Effective-dated price snapshot protocol.**
