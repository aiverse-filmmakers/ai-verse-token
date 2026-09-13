# AI-Verse Ecosystem Adapters v0.1

Status: first-release contract, Task 31 / 32.

## Purpose

AI-Verse Token integrates with sibling layers through bounded projections, references and attribution contracts. It does not import sibling packages, write sibling canonical state or move telemetry ownership out of Token.

This keeps Token optional and install-order independent.

## Dashboard

Package surface: `@ai-verse/token/dashboard`.

The Dashboard adapter wraps an already-created read-only `TokenReader` and exposes:

- overview summary;
- exact time analysis;
- actual-cost efficiency coverage;
- bounded model/provider/runtime/workspace/etc. breakdowns;
- hourly/daily timeline projections.

Projection provenance explicitly states:

```text
source: ai-verse-token
read_only: true
opens_sqlite_directly: false
```

Dashboard does not receive Token's SQLite path or database handle.

## Brain

Package surface: `@ai-verse/token/brain`.

Brain receives bounded read answers only:

- summary;
- recent privacy-safe events, maximum 100;
- time analysis, maximum 5,000 events;
- efficiency analysis, maximum 5,000 events.

Raw source-record IDs and source fingerprints are stripped from recent-event answers. The adapter grants no write authority.

## Memory

Package surface: `@ai-verse/token/memory`.

Memory receives explicit evidence/candidate objects only. Stable evidence URIs use:

```text
token://event/<event-id>
```

A candidate has `auto_write: false`. Token never dumps every telemetry event into Memory and never writes Memory state directly.

## Data

Package surface: `@ai-verse/token/data`.

Data integration consists of:

- stable Token event references;
- bounded summary projections;
- explicit `authority: ai-verse-token`;
- explicit `ownership_transferred: false`.

AI-Verse Data may store a reference or derived operational record through its own authorized API, but it does not become the Token ledger.

## Multiple Bots

Package surface: `@ai-verse/token/bots`.

Trusted Multiple Bots attribution can attach:

- Bot ID;
- Worker ID;
- TeamRun ID;
- task ID;
- workspace ID;
- project ID.

TeamRun ID maps to Token's canonical `run_id`. Existing exact attribution cannot be silently replaced. Conflicts fail closed with `ATTRIBUTION_CONFLICT`.

## Skills and Automations

Package surface: `@ai-verse/token/correlation`.

Correlation metadata may attach:

- workspace/project/agent;
- skill;
- automation;
- tool;
- task;
- run.

Correlation enriches absent exact fields only. It does not grant execution permission, connection access or model authority.

## Connections

Package surface: `@ai-verse/token/connections`.

Token accepts opaque credential handles only:

```text
connection_id
credential_name
billing_platform
inference_provider (optional)
contains_secret: false
```

The runtime factory rejects unknown fields, including attempted raw `api_key`, `secret` or token values. AI-Verse Connections or another host authority resolves the actual credential outside Token.

## Install-order rule

These adapters have no runtime dependency on sibling repositories. Missing Dashboard, Brain, Memory, Data, Multiple Bots, Skills, Automations or Connections never blocks Token.

No sibling repository is modified by Task 31.

## Acceptance proof

Task 31 tests prove:

- Dashboard output contains no SQLite path and identifies itself as read-only;
- Brain event answers are bounded and privacy-safe;
- Memory candidates cannot auto-write and carry only evidence references;
- Data projections retain Token authority and do not transfer ownership;
- Multiple Bots TeamRun/Worker/Bot attribution is exact and conflict-detecting;
- Skills/Automations correlation cannot overwrite existing exact attribution;
- Connections returns handles only and rejects secret-bearing unknown fields;
- package exports exist without any sibling package dependency;
- full inherited suite remains green.
