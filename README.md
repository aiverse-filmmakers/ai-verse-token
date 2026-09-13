# AI-Verse Token

**Status:** Public-beta implementation candidate
**Version:** `@ai-verse/token@0.1.0-beta.3`
**CLI:** `ai-verse-token`
**Extension id:** `ai-verse-token`

AI-Verse Token is the canonical usage, token, timing and AI-cost telemetry owner for AI-Verse and compatible runtimes. It can passively collect supported local agent histories, normalize provider/gateway usage, preserve immutable telemetry evidence, rate usage through ACTUAL / CALCULATED / UNKNOWN cost truth, and expose bounded owner-backed projections to Gateway, Dashboard and other consumers.

## Non-negotiable truth rules

- `ACTUAL`: a trusted provider/runtime supplies the real charge.
- `CALCULATED`: authoritative usage is rated against a matching verified tariff.
- `UNKNOWN`: Token cannot safely establish the amount.
- `UNKNOWN` is never represented as zero.
- A real zero-dollar charge remains a real `ACTUAL` zero.
- Workspace, task, Bot, Worker, Skill and other attribution IDs are telemetry labels. They never grant permission.
- Gateway/OS supplies authorization. Token enforces the supplied immutable read scope floor.
- Token owns telemetry and pricing evidence. It does not take Memory, Data, Brain, Bot, Skill, Connection, scheduler or permission ownership.

## Install

From an immutable package artifact:

```bash
npm install ./ai-verse-token-0.1.0-beta.3.tgz
```

For an AI-Verse OS root:

```bash
ai-verse-token install --root <ai-verse-os-root> --json
```

`install` makes Token available and materializes its durable extension runtime bundle. It does not create telemetry state, grant access, or activate collection.

After npm publication, the intended equivalent is:

```bash
npx @ai-verse/token install --root <ai-verse-os-root> --json
```

## Setup

```bash
ai-verse-token setup --root <ai-verse-os-root> --json
```

Setup safely initializes Token-owned runtime state, creates or opens the immutable usage ledger, initializes the pricing evidence store, discovers supported local sources, and performs a real bounded collection pass.

If an OpenRouter credential is available through `OPENROUTER_API_KEY`, setup can also perform the live OpenRouter pricing sync. A credential is read from the environment at request time and is never persisted by Token.

Setup is idempotent and preserves existing canonical Token state.

## Verify

Fast state:

```bash
ai-verse-token status --root <ai-verse-os-root> --json
```

Deep read-only verification:

```bash
ai-verse-token doctor --root <ai-verse-os-root> --json
```

Public states distinguish `absent`, `setup-required`, `disabled`, `unhealthy`, and `ready`. Doctor checks structural/native health, discovery, runtime state, ledger integrity, collector detection, pricing evidence and primary cost-truth capability.

## Use

Run a bounded collection pass:

```bash
ai-verse-token collect --root <ai-verse-os-root> --json
```

Refresh supported live pricing evidence:

```bash
ai-verse-token prices sync --root <ai-verse-os-root> --json
```

Read owner-local usage and cost truth:

```bash
ai-verse-token usage --root <ai-verse-os-root> --json
```

Optional exact attribution filters include:

```text
--system --workspace --project --agent --bot --worker
--skill --automation --tool --run --task --session
```

The primary read path returns ACTUAL, CALCULATED and UNKNOWN results. Unknown monetary evidence has no synthetic amount.

The package also exposes bounded library surfaces including:

```text
@ai-verse/token/runtime
@ai-verse/token/read
@ai-verse/token/gateway
@ai-verse/token/dashboard
@ai-verse/token/bots
@ai-verse/token/pricing
@ai-verse/token/cost
@ai-verse/token/collectors
```

Gateway should use `@ai-verse/token/gateway` with a host-provided authorization envelope. Dashboard should consume Token projections rather than opening Token SQLite directly.

## Update / disable / uninstall

```bash
ai-verse-token update --root <ai-verse-os-root> --json
ai-verse-token disable --root <ai-verse-os-root> --json
ai-verse-token enable --root <ai-verse-os-root> --json
ai-verse-token uninstall --root <ai-verse-os-root> --json
```

`update` replaces Token-owned runtime software without silently re-enabling a disabled installation. `uninstall` removes Token integration/runtime files while preserving Token-owned canonical user state by default. Reinstall can adopt that preserved state.

## What setup does and does not grant

Setup grants no external authority. It does not create workspace membership, Bot authority, Skill permission, provider credentials, Connection authorization, scheduler ownership or action permission. Telemetry attribution is evidence only.

Recurring cadence belongs to AI-Verse Automations or another host scheduler. Token exposes bounded `collect` and pricing-sync operations that the scheduler may invoke.

## Built-in passive local collectors

The public-beta runtime composes and discovers:

- Hermes
- Claude Code
- Codex
- OpenCode
- Gemini CLI
- OpenClaw

Collectors are source-preserving, checkpointed and idempotent. Supported source databases are opened read-only where applicable.

## Pricing transport

Token includes:

- a concrete OpenRouter Models API transport;
- a bounded Token-native HTTPS price-manifest transport;
- immutable effective-dated price snapshots;
- source registry authority that cannot be self-promoted by fetched payloads.

Network credentials remain external to Token state.

## Provenance

This repository was restored from the exact previously audited hardened source artifact for `@ai-verse/token@0.1.0-alpha.1`.

Exact audited source archive SHA-256:

```text
4feb14ed9df2b82b7f4a07d571e77beda4afe695982e55b3dcfe0a7440588257
```

Exact audited packed alpha.1 SHA-256:

```text
43545daa33922656889e4b5e4257e03f7ba7eaa573f13bc1cc361b938aa65abc
```

The recovered source archive contained no `.git` metadata and no recoverable Git bundle was found. The restoration anchor is therefore the verified artifact itself, not a fabricated historical commit chain. See [`PROVENANCE.md`](PROVENANCE.md).

## Verification and release

Local public-beta acceptance currently passes:

```text
TypeScript check: PASS
Normal tests: 256 / 256
Release acceptance: 3 / 3
Clean packed install: PASS
npm pack dry-run: PASS
```

The repository includes a six-leg GitHub Actions matrix for Linux, macOS and Windows on Node 22 and 24. Hosted cross-platform verification is required on the canonical GitHub repository before the beta.3 tag is sealed.

See [`docs/PACKAGING-RELEASE-ACCEPTANCE-V0.1.md`](docs/PACKAGING-RELEASE-ACCEPTANCE-V0.1.md) and [`docs/HARDENING-AUDIT-2026-09-12.md`](docs/HARDENING-AUDIT-2026-09-12.md).
