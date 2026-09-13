# Phase 1 Acceptance

Phase 1 is the core package and immutable usage-ledger gate for AI-Verse Token.

The gate composes Tasks 8-13 rather than introducing a new feature surface.

## Required proofs

- package/CLI foundation builds under the Node 22/24 CI matrix;
- canonical protocol preserves known zero, explicit unknown (`null`) and source-absent fields distinctly;
- exact identity resolution can enrich an event before ingest without fuzzy pricing authority;
- usage survives close/reopen byte-backed SQLite persistence;
- exact replay and same-source replay do not double count;
- collector checkpoint advancement survives reopen;
- WAL supports separate writers/readers and readers observe committed state;
- immutable usage-event triggers remain present and are verified on open;
- foreign/malformed databases are never reformatted or overwritten;
- bounded query/aggregate surfaces work from read-only connections;
- no prompt/response/secret fields are required anywhere in the core ledger.

## CI note

The repository workflow runs `npm run ci` on GitHub-hosted Node 22 and Node 24 jobs. This local acceptance run validates the workflow contract and Node 22 runtime. The actual Node 24 execution occurs when the repository is pushed to GitHub and Actions runs.
