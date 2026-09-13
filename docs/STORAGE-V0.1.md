# AI-Verse Token SQLite Storage v0.1

Task 10 defines the first-release usage-ledger storage format.

## Ownership

The Token ledger owns telemetry only. It does not own prompts, responses, Memory, structured user records, credentials, provider secrets or canonical state from sibling AI-Verse layers.

## SQLite identity

A valid ledger is identified by all of the following:

- `PRAGMA application_id = 0x4156544B` (`AVTK`)
- `PRAGMA user_version = 2`
- `token_metadata.format = ai-verse-token/sqlite`
- `token_metadata.format_version = 2`
- `token_metadata.protocol_version = ai-verse-token/0.1`

All checks must agree. A non-empty foreign SQLite database is never adopted or overwritten.

## Connection safety

Writable connections require:

- WAL journal mode
- foreign keys on
- trusted schema off
- recursive triggers on
- 5 second busy timeout
- `synchronous = FULL`

Read-only connections enable SQLite `query_only` and never initialize or repair storage.

Every open performs `PRAGMA quick_check`. A full integrity check is available explicitly.

## Creation and open modes

- `create-or-open`: create only when the target does not exist; an existing database must already be a compatible Token ledger.
- `open-existing`: fail when missing; never convert a foreign database.
- `read-only`: fail when missing and never initialize state.

SQLite URI paths and `:memory:` are rejected so callers cannot silently change SQLite open semantics through the path string.

## Privacy invariant

The schema has no prompt, response, credential, API-key or secret columns. The canonical `event_json` is accepted only later through the strict usage-event validator, whose protocol fixes `content_stored` to `false`. SQLite also constrains `content_stored = 0`.

## `usage_events`

Task 10 creates the canonical table and indexes needed by later ingest/query tasks, but does not yet expose event writes. Task 11 owns immutable/idempotent ingest and deduplication semantics.
