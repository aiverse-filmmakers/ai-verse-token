# AI-Verse Native Lifecycle v0.1

Status: public-beta lifecycle contract, updated 2026-09-13.

## Purpose

AI-Verse Token can operate standalone or register as an optional AI-Verse OS v2 extension without modifying tracked OS files or taking ownership of sibling state.

## Host compatibility

Native lifecycle operations require all of the following:

- `AI-VERSE.yaml` with schema major `2`;
- `architecture: unified-workspace`;
- regular non-symlink `AGENTS.md`;
- regular non-symlink `operator/` and `workspaces/` directories;
- regular non-symlink `system/extensions/README.md` that references `/.aiverse/extensions/registry.json`.

A normal directory with no complete AI-Verse host is reported as `standalone`. AI-Verse-like partial host evidence is never masked as standalone and instead reports `incompatible`.

## Local extension ownership

Token registers only:

```text
.aiverse/extensions/registry.json
  extensions["ai-verse-token"]
```

Token-owned installed software is:

```text
.aiverse/extensions/ai-verse-token/INSTRUCTIONS.md
.aiverse/extensions/ai-verse-token/engine.mjs
.aiverse/extensions/ai-verse-token/extension.json
.aiverse/extensions/ai-verse-token/bundle/
```

Token native user state is:

```text
.aiverse/extensions/ai-verse-token/state/token.sqlite
.aiverse/extensions/ai-verse-token/state/runtime.json
.aiverse/extensions/ai-verse-token/state/pricing/
```

The state path is deliberately not installer-owned software. Installation creates no telemetry ledger. Setup initializes Token-owned state. Uninstall removes Token integration and the replaceable runtime bundle, but preserves `state/`, the ledger, runtime configuration and pricing evidence.

## Registry semantics

Registry schema is exactly `1.0`.

The Token entry is materialized with:

```json
{
  "id": "ai-verse-token",
  "supported": true,
  "installed": true,
  "enabled": true,
  "version": "0.1.0-beta.1",
  "source": "AI-Verse-Token",
  "instructions": ".aiverse/extensions/ai-verse-token/INSTRUCTIONS.md",
  "engine": ".aiverse/extensions/ai-verse-token/engine.mjs",
  "adapters": []
}
```

Existing `enabled: false` is preserved across install/update. Unknown top-level registry fields, unrelated extension entries and unknown fields on Token's own entry are preserved.

Registration does not grant workspace, connection, action or sibling-component authority.

## Concurrency and filesystem safety

Lifecycle writes use:

- repository-relative fixed paths only;
- root containment checks;
- absolute/traversal/NUL rejection;
- symlink rejection for host and extension path components;
- `.aiverse/extensions/registry.json.lock` exclusive lock acquisition;
- in-lock registry re-read;
- raw-text lost-update detection;
- same-directory temporary file plus atomic rename for registry/materialized files.

Lock contention fails closed. A stale registry snapshot cannot overwrite a competing writer.

## Commands

```bash
ai-verse-token install --root <ai-verse-os-root> [--json]
ai-verse-token setup --root <ai-verse-os-root> [--json]
ai-verse-token status --root <ai-verse-os-root> [--json]
ai-verse-token doctor --root <ai-verse-os-root> [--json]
ai-verse-token collect --root <ai-verse-os-root> [--json]
ai-verse-token prices sync --root <ai-verse-os-root> [--json]
ai-verse-token usage --root <ai-verse-os-root> [--json]
ai-verse-token update --root <ai-verse-os-root> [--json]
ai-verse-token enable --root <ai-verse-os-root> [--json]
ai-verse-token disable --root <ai-verse-os-root> [--json]
ai-verse-token uninstall --root <ai-verse-os-root> [--json]
```

Lifecycle commands require a compatible AI-Verse host. `status` and `doctor` also support standalone reporting.

Exit behavior:

- `0`: requested operation succeeded, or status/doctor is healthy;
- `1`: runtime/native failure or unhealthy status/doctor;
- `2`: CLI usage error.

## Status and doctor

`status` is a fast non-destructive operational state summary. `doctor` performs deeper read-only structural, attachment/discovery, runtime, dependency and operational checks, including ledger integrity, local collector detection, pricing evidence and primary ACTUAL/CALCULATED/UNKNOWN support.

Install without setup reports `setup-required`. A disabled extension reports `disabled`, not corruption. Missing pricing evidence is reported explicitly and leaves unpriceable usage UNKNOWN rather than zero.

## Non-negotiable boundaries

Native lifecycle never modifies:

- `AI-VERSE.yaml`;
- `AGENTS.md`;
- `CLAUDE.md`;
- `skills/registry.yaml`;
- `agents/registry.yaml`;
- `system/`;
- sibling extension entries;
- prompt/response content;
- an existing Token telemetry ledger during install/update/disable/uninstall/status/doctor.

## Acceptance proof

Task 30 acceptance includes:

- current OS v2 compatibility detection;
- standalone and incompatible-host distinction;
- tracked OS files byte-preserved;
- unknown registry fields and sibling entries preserved;
- disabled Token state preserved across install/update;
- enable/disable owned-field-only writes;
- lock contention fail-closed;
- malformed/unsupported registry fail-closed;
- symlinked extension path rejection;
- stale snapshot lost-update rejection;
- zero state creation during install;
- update repair of owned files without ledger mutation;
- byte-for-byte native ledger survival across uninstall;
- read-only doctor integrity verification;
- native CLI lifecycle/status contract.
