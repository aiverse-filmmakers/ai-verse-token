# AI-Verse Token provenance

## Restored canonical source

The repository was restored on 2026-09-13 from the exact previously audited hardened source archive:

- package identity: `@ai-verse/token@0.1.0-alpha.1`
- source archive: `AI-Verse-Token-hardened-alpha.1.zip`
- source archive SHA-256: `4feb14ed9df2b82b7f4a07d571e77beda4afe695982e55b3dcfe0a7440588257`
- installable alpha.1 package SHA-256: `43545daa33922656889e4b5e4257e03f7ba7eaa573f13bc1cc361b938aa65abc`

The archive contained no `.git` directory. No separate Git bundle or recoverable remote Token repository was available. Therefore the archive digest is the exact recoverable source identity for alpha.1.

The first commit in the restored repository is an untouched import of that archive and is tagged `artifact-0.1.0-alpha.1`. Later commits are new public-beta work and do not pretend to reconstruct the missing historical Git chain.

## Public-beta lineage

`0.1.0-beta.1` is derived directly from that restored alpha.1 source. It keeps ledger format 2 and adds the operational setup, collection, pricing transport, cost-aware primary reads, host-scoped authorization, Gateway projection and public-beta lifecycle/readiness work without changing canonical telemetry ownership.

## Cross-platform public-beta follow-up

`0.1.0-beta.2` preserves the beta.1 runtime behavior and fixes the hosted Windows test harness to convert file URLs with `fileURLToPath()` instead of passing URL pathnames directly to Node. The immutable `v0.1.0-beta.1` tag is retained and is not moved.
