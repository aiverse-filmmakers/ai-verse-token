# Hermes Integration

## 1. Why Hermes is first-class

Current Hermes Agent session storage is unusually useful for Token because its SQLite state already records:

```text
session id
source platform
model
started_at / ended_at
message_count
tool_call_count
input_tokens
output_tokens
cache_read_tokens
cache_write_tokens
reasoning_tokens
billing_provider
billing_base_url
billing_mode
estimated_cost_usd
actual_cost_usd
cost_status
cost_source
pricing_version
```

Hermes also has per-session/per-model/per-provider/per-task usage rows.

## 2. Read-only passive adapter

Default adapter reads:

```text
$HERMES_HOME/state.db
$HERMES_HOME/profiles/*/state.db
```

with fallback to standard `~/.hermes/...` paths.

Requirements:

- read-only SQLite connection;
- support WAL-safe reads;
- detect Hermes schema/version;
- never modify Hermes DB;
- checkpoint imported source rows;
- dedupe deterministic source identity;
- preserve Hermes route and task attribution.

## 3. Cost precedence

```text
Hermes actual_cost_usd + cost_source
    -> provider_reported in Token

Hermes estimated_cost_usd only
    -> never promoted to authoritative cost
```

If actual cost is missing, Token may independently rate exact usage using its own strict pricing engine, producing a separate cost record with separate provenance.

## 4. Model/route changes

Hermes can switch models/providers mid-session.

Therefore ingest from per-model usage rows where possible rather than collapsing the whole session into the latest model.

Canonical identity should include:

```text
session_id
model
billing_provider
billing_base_url
billing_mode
task
```

## 5. Auxiliary tasks

Hermes can attribute auxiliary LLM usage such as:

```text
vision
compression
title generation
background review
```

Token should preserve these as task/suboperation dimensions.

This enables questions such as:

```text
How much did compression cost today?
How many tokens were spent on background review?
Which auxiliary model is slowest?
```

## 6. Messaging-source dimension

Hermes session source can identify surfaces such as CLI, Telegram, Discord and other gateways.

Token can preserve a privacy-safe `runtime_surface` dimension to compare usage by access channel without storing conversation content.

## 7. Live mode later

Passive DB ingest is the lowest-risk first integration.

A later Hermes-native adapter or MCP/OTel hook may provide per-request timestamps/TTFT not available in aggregate DB rows.

The passive reader remains useful for history/backfill even after live hooks exist.

## 8. Command Code through Hermes

If Hermes calls Command Code, route identity must preserve:

```text
runtime: hermes
billing_platform: commandcode
model: exact Command Code model id
```

A Command Code adapter can then enrich Hermes usage with Command Code usage records or direct reported charges when available, without pretending the underlying model author's direct API price is the bill.
