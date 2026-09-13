# AI-Verse Token

**Status:** Hardened alpha.1 release candidate
**Design snapshot:** 2026-09-12  
**Package:** `@ai-verse/token`  
**CLI:** `ai-verse-token`  
**AI-Verse extension id:** `ai-verse-token`

AI-Verse Token is a headless usage intelligence layer for LLMs, agents, coding assistants, gateways and AI operating systems.

It is designed to work standalone, inside AI-Verse OS, with Hermes Agent, with coding agents, and with direct providers/gateways. AI-Verse Dashboard can consume its read-only projections without owning Token's ledger.

## North-star rule

> Observe usage once, identify the real runtime and billing route, preserve exact usage and timing facts, use fresh effective pricing, prefer provider-reported actual cost, and make every aggregate traceable to source events.

## First-release cost truth

Token exposes only three monetary states:

- `ACTUAL`: a trusted billing platform/runtime supplies the real charge;
- `CALCULATED`: exact/authoritative usage is rated with a matching verified effective tariff;
- `UNKNOWN`: Token cannot safely establish the amount.

Unknown is never represented as zero. Calculated cost is never presented as invoice-confirmed billing.

See [`docs/FIRST-RELEASE-SCOPE.md`](docs/FIRST-RELEASE-SCOPE.md).

## What it should answer

```text
How many tokens did I use today?
Which runtime, billing platform, provider and model used them?
How much was input/output/cache/reasoning?
How many requests ran per hour/day/session?
How long did each request take?
What was TTFT and output throughput?
How much active AI time did I use without double-counting parallel calls?
Which agent, Bot, Worker, task, project or workspace caused the usage?
What did it cost, and is that amount ACTUAL, CALCULATED or UNKNOWN?
What changed in model pricing?
Am I approaching a token/cost/time/request budget?
```

## Deliberate non-goals

First release is not:

- a dashboard;
- a second AI-Verse Data database;
- a prompt/response archive;
- a mandatory LLM gateway;
- an invoice/reconciliation system;
- enterprise contract-pricing software;
- a subscription/credit accounting ledger;
- a provider router;
- a scheduler.

The more complex financial-grade ideas researched initially are explicitly deferred. See [`docs/DEFERRED-FINANCIAL-GRADE.md`](docs/DEFERRED-FINANCIAL-GRADE.md).

## Core architecture

```text
Local runtimes / CLIs / provider APIs / gateways
                    |
                    v
           Collectors + live hooks
                    |
                    v
          Canonical immutable event
                    |
          +---------+----------+
          |                    |
          v                    v
   Usage ledger         Identity resolver
          |             runtime/platform/
          |             provider/model/scope
          +---------+----------+
                    |
                    v
              Pricing resolver
                    |
        +-----------+-----------+
        |                       |
        v                       v
 provider actual          verified tariff
        |                       |
        v                       v
     ACTUAL                 CALCULATED
        \                       /
         +----------+----------+
                    |
                    v
            Time + rollup engine
                    |
                    v
       CLI / JSON / MCP / Dashboard
```

## Best-in-class reference set

The architecture keeps the strongest relevant ideas from:

1. Tokscale
2. CodeBurn
3. ccusage
4. Pydantic `genai-prices`
5. Portkey Models
6. LiteLLM
7. OpenLIT
8. Langfuse
9. OpenMeter
10. Bifrost

OpenLLMetry and Helicone were also reviewed as secondary references.

The implementation adopts concepts and public contracts, not copied source code. See [`docs/RESEARCH-2026-09.md`](docs/RESEARCH-2026-09.md) and [`docs/REFERENCE-ADOPTION-MAP.md`](docs/REFERENCE-ADOPTION-MAP.md).

## Time is first-class

Token distinguishes request wall time, TTFT, generation time, active wall time, summed model-compute time and concurrency. Parallel calls must not be summed and mislabeled as active wall time.

See [`docs/TIME-METRICS.md`](docs/TIME-METRICS.md).

## AI-Verse integration

AI-Verse Token uses the existing local extension mechanism:

```text
.aiverse/extensions/registry.json
.aiverse/extensions/ai-verse-token/
```

It owns its telemetry ledger. AI-Verse Data may consume bounded projections/references but does not become the Token database. Memory may store selected meaningful historical interpretations/evidence references, never every telemetry event. Dashboard uses a read-only adapter rather than opening Token SQLite directly.

See [`docs/AI-VERSE-INTEGRATION.md`](docs/AI-VERSE-INTEGRATION.md). Native lifecycle details are frozen in [`docs/AI-VERSE-NATIVE-LIFECYCLE-V0.1.md`](docs/AI-VERSE-NATIVE-LIFECYCLE-V0.1.md).

## Hermes integration

Hermes is a first-class passive source. The adapter reads Hermes state databases without modifying them, preserves model/task attribution and prefers trusted `actual_cost_usd` when present.

See [`docs/HERMES-INTEGRATION.md`](docs/HERMES-INTEGRATION.md).

## Draft contracts

- [`schemas/usage-event-v1.schema.json`](schemas/usage-event-v1.schema.json)
- [`schemas/price-snapshot-v1.schema.json`](schemas/price-snapshot-v1.schema.json)
- [`docs/PRICE-SNAPSHOT-PROTOCOL-V0.1.md`](docs/PRICE-SNAPSHOT-PROTOCOL-V0.1.md)

Both protocol artifacts are now frozen for first-release implementation by Task 9 and Task 15.

## Public surfaces

Current first-release package surfaces include:

```text
@ai-verse/token/protocol
@ai-verse/token/storage
@ai-verse/token/identity
@ai-verse/token/query
@ai-verse/token/pricing
@ai-verse/token/cost
@ai-verse/token/collectors
@ai-verse/token/adapters
@ai-verse/token/time
@ai-verse/token/efficiency
@ai-verse/token/read
@ai-verse/token/export
@ai-verse/token/mcp
@ai-verse/token/native
@ai-verse/token/dashboard
@ai-verse/token/brain
@ai-verse/token/memory
@ai-verse/token/data
@ai-verse/token/bots
@ai-verse/token/connections
@ai-verse/token/correlation
```

Implemented CLI:

```bash
ai-verse-token summary --db <token.sqlite> [--json]
ai-verse-token query --db <token.sqlite> [--limit <1..100>] [--json]
ai-verse-token export --db <token.sqlite> --format <json|csv> [--limit <1..50000>]

ai-verse-token install --root <ai-verse-os-root> [--json]
ai-verse-token update --root <ai-verse-os-root> [--json]
ai-verse-token enable --root <ai-verse-os-root> [--json]
ai-verse-token disable --root <ai-verse-os-root> [--json]
ai-verse-token uninstall --root <ai-verse-os-root> [--json]
ai-verse-token status --root <candidate-root> [--json]
ai-verse-token doctor --root <candidate-root> [--json]
```


## Installation

Current local/tarball release:

```bash
npm install ./ai-verse-token-0.1.0-alpha.1.tgz
```

After npm publication, the intended one-command AI-Verse OS install is:

```bash
npx @ai-verse/token install --root <ai-verse-os-root>
```

Publication is intentionally separate from this build. No remote repository or npm publication is claimed yet. See [`docs/PACKAGING-RELEASE-ACCEPTANCE-V0.1.md`](docs/PACKAGING-RELEASE-ACCEPTANCE-V0.1.md).

## Build state

Tasks **32 / 32** are complete. The first-release implementation gate is passed locally on Node 22. The repository also defines the release CI matrix for Node 22/24 on Ubuntu, macOS and Windows, to run once a remote repository exists.

See [`docs/BUILD-MAP.md`](docs/BUILD-MAP.md).

The post-release hardening review is recorded in [`docs/HARDENING-AUDIT-2026-09-12.md`](docs/HARDENING-AUDIT-2026-09-12.md). The hardened build is `0.1.0-alpha.1` with ledger format `2`; the unpublished alpha.0 ledger format is intentionally not auto-migrated.

## Efficiency and budgets

The `@ai-verse/token/efficiency` surface provides cache/reasoning efficiency, explicit retry tax, dimensional usage summaries, conservative request/token/time/cost budgets and provider quota-window status. Missing data remains unknown, currencies are never mixed, and monetary remaining capacity uses exact decimal arithmetic.
