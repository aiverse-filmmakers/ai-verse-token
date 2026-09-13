# Read, export and MCP surfaces v0.1

## Purpose

Task 29 exposes AI-Verse Token telemetry through stable read-only interfaces so CLI users, agents and future Dashboard adapters do not need to open SQLite directly.

## Trusted read API

`@ai-verse/token/read` provides `openTokenReader()`.

`TokenReader` always opens an existing Token ledger in SQLite read-only mode. Construction requires an explicit authorization envelope supplied by the outer host or a trusted local-owner boundary. Token never derives permission from telemetry attribution. It exposes:

- paged usage query;
- fixed-dimension aggregate query;
- bounded summary totals;
- bounded time analysis and rollups;
- bounded efficiency analysis using the complete `ACTUAL` / `CALCULATED` / `UNKNOWN` cost truth path;
- bounded cost and overview reads composed from the Token pricing store and CostEngine.

Time/efficiency scans default to 10,000 events and are hard-capped at 50,000. A caller must narrow its filter or explicitly raise the bounded ceiling instead of receiving an accidental unbounded scan.

The read API never exposes a write method. Scoped authorization is an immutable floor: a caller may narrow its requested filters but cannot request a conflicting workspace, Bot, Skill, task or other scoped dimension.

## CLI

Implemented commands:

```bash
ai-verse-token summary --db <token.sqlite> [--json]
ai-verse-token query --db <token.sqlite> [--limit <1..100>] [--json]
ai-verse-token export --db <token.sqlite> --format <json|csv> [--limit <1..50000>]
```

All commands open the ledger read-only and establish an explicit local-owner authorization boundary for the operator-supplied local database path. Usage errors exit `2`; runtime/read failures exit `1`; successful commands exit `0`.

CLI query JSON uses the privacy-safe projection by default.

## Export

`@ai-verse/token/export` supports JSON and CSV.

Default JSON exports remove:

- `source.source_record_id`;
- `provenance.source_record_fingerprint`.

Canonical prompt/response content is absent by protocol, so exports cannot accidentally include it from the Token ledger.

A trusted library caller may explicitly set `include_provenance_ids: true` when source-level forensic IDs are required. CSV intentionally has no provenance fingerprint/source-record-ID columns and has a fixed telemetry column vocabulary.

Exports are capped at 50,000 events per call.

## Read-only MCP tool surface

`@ai-verse/token/mcp` exposes five read-only tools:

- `token_summary`;
- `token_usage_query`;
- `token_usage_aggregate`;
- `token_usage_time`;
- `token_usage_efficiency`.

The surface is transport-neutral so an MCP host can register it without giving the model a database handle.

MCP query pages are limited to 100 events. Time/efficiency scans are limited to 5,000 events. Unsupported arguments fail closed. MCP event results always use the privacy-safe projection.

No MCP tool writes events, pricing, checkpoints, budgets or configuration.

## Privacy boundary

Trusted package code may use the canonical read API. Agent-facing surfaces default to redacted source-level provenance IDs. Gateway/MCP hosts must construct their reader from host-authorized scope, never from event attribution.

Neither CLI nor MCP accepts SQL, SQLite paths inside query payloads, arbitrary column names or arbitrary sort expressions. The only filesystem path accepted by CLI is the operator-supplied ledger path used to create the read-only TokenReader.

## Performance baseline

`test/read-performance-baseline.test.mjs` seeds 500 canonical events and checks:

- read-only open under 5 seconds;
- 500-event query under 5 seconds;
- two-dimension aggregate under 5 seconds;
- bounded time analysis under 10 seconds;
- 500-event CSV export under 10 seconds.

The ceilings intentionally have large headroom for slower macOS/Windows CI runners. They are regression alarms, not performance claims.

Measured on the Task 29 development host, the complete performance test including fixture creation completed in under one second.

## Non-goals

The read layer does not add:

- write-capable MCP tools;
- raw SQL;
- authorization identity ownership;
- unbounded export;
- automatic FX conversion.

## Acceptance proof

`test/read-export-mcp.test.mjs` covers stable read APIs, bounds, JSON/CSV privacy, MCP restrictions and CLI behavior.

`test/read-performance-baseline.test.mjs` covers first-release read performance ceilings.

Full inherited suite at Task 29: **208 / 208 passing**.
