# Packaging and Release Acceptance v0.1

Status: public-beta.3 release acceptance, updated 2026-09-13.

## Release shape

Package:

```text
@ai-verse/token@0.1.0-beta.3
```

CLI:

```text
ai-verse-token
```

The package is no longer marked npm-private. Publication itself is not performed by this repository build task.

The packed artifact contains only the runtime package surface:

- `bin/`;
- compiled `dist/`;
- `README.md`;
- `THIRD-PARTY-NOTICES.md`;
- `PROVENANCE.md`;
- package metadata.

Source TypeScript, tests, planning fixtures and local telemetry databases are not shipped.

## Installation paths

A packed/local release can be installed with:

```bash
npm install ./ai-verse-token-0.1.0-beta.3.tgz
```

It can also be executed without a permanent project install:

```bash
npm exec --yes --package ./ai-verse-token-0.1.0-beta.3.tgz -- ai-verse-token --version
```

After npm publication, the intended one-command native path is:

```bash
npx @ai-verse/token install --root <ai-verse-os-root>
```

After a GitHub remote exists, Git installation is supported by the package `prepare` build hook. This task does not claim that a remote or npm publication already exists.

## Build portability

Package scripts avoid shell-specific `rm -rf`. `clean` uses Node's filesystem API.

GitHub Actions defines six release legs:

```text
ubuntu-latest   Node 22
ubuntu-latest   Node 24
macos-latest    Node 22
macos-latest    Node 24
windows-latest  Node 22
windows-latest  Node 24
```

Once the repository is pushed to GitHub, each configured leg runs:

- dependency installation without lifecycle scripts;
- TypeScript check;
- full tests;
- package dry-run;
- CLI help smoke.

The symlink adversarial test remains active where the host permits symlink creation and skips only when the operating system denies the primitive itself.

## Release acceptance coverage

The complete suite verifies all first-release laws across focused and integration tests.

### Usage and privacy

- exact input/output/cache/reasoning categories remain distinct;
- missing values remain unknown rather than zero;
- prompt/response content is structurally unnecessary and rejected by the storage privacy contract;
- exports/Brain/MCP remove raw source forensic IDs by default.

### Identity and pricing

- billing platform, inference provider and model identity remain separate;
- fuzzy model identity never authorizes pricing;
- effective-dated historical pricing is used for historical calls;
- today's `CALCULATED` usage requires fresh authoritative pricing;
- secondary pricing catalogs cannot authorize `CALCULATED` money.

### Cost truth

- trusted provider/runtime charges produce `ACTUAL`;
- exact usage plus verified tariff produces `CALCULATED`;
- insufficient evidence produces `UNKNOWN` with no amount field;
- actual zero is preserved as a real zero;
- calculated money never overwrites trusted actual money.

### Collectors and adapters

- Hermes source databases are read-only and byte-preserved;
- Claude Code, Codex, OpenCode, Gemini CLI and OpenClaw collectors are bounded/incremental;
- OpenRouter, Command Code, OpenAI, Anthropic and Gemini normalization is strict;
- OTel/LiteLLM/Bifrost/generic gateway paths preserve privacy and truth status.

### Dedupe and time

- strongly correlated observations collapse to one queryable canonical call while raw evidence remains immutable;
- conflicting exact correlated facts fail closed;
- trace/time/model similarity alone never dedupes;
- active wall time uses interval union while compute time remains summed;
- parallel durations are never mislabeled active wall time.

### Control and ecosystem

- budgets use conservative lower bounds when data is incomplete;
- currencies are never silently mixed;
- Dashboard/Brain/MCP are bounded read-only consumers;
- Memory/Data bridges preserve Token ownership boundaries;
- Bots/Skills/Automations attribution conflicts fail closed;
- Connections accepts credential handles, not secrets.

### AI-Verse lifecycle

- install/update/enable/disable/uninstall touch only Token-owned local extension state;
- unknown registry fields and sibling entries survive;
- tracked OS files remain unchanged;
- install creates no telemetry ledger;
- existing Token state survives update, disable, uninstall and reinstall;
- doctor opens existing state read-only and does not repair silently.

## Verification status

The public-beta.1 normal suite passes **256 / 256** tests and the serial release-acceptance stage passes **3 / 3**, for **259 / 259** executed tests across the normal and release stages. The clean packed-install acceptance passes from the tarball artifact rather than relying on the source checkout.

Beta.1 retains ledger format **2**. It intentionally fails closed on incompatible ledger formats rather than silently mutating or guessing a migration.

Local release verification on Node 22 passes the full public-beta suite plus the serial release acceptance stage. The GitHub Actions six-leg Node 22/24 cross-platform matrix is configured and contract-tested, and beta.3 must not be sealed until the canonical GitHub Actions matrix passes.

## Final release law

A first release implementation is accepted only when the full inherited suite, release acceptance tests, TypeScript check, package dry-run, link checks and diff checks are green locally. Publication remains a distribution step. Hosted cross-platform CI is a release gate for beta.3.
