# AI-Verse Integration

## 1. Principle

> Each AI-Verse layer keeps its own truth. Token is a telemetry/accounting extension, not a replacement for Data, Memory, Brain, Multiple Bots, Skills, Connections or Dashboard.

## 2. Native host contract

Follow AI-Verse OS v2's local extension hook:

```text
.aiverse/extensions/registry.json
```

Token owns only:

```text
.aiverse/extensions/ai-verse-token/
```

and its own registry entry.

Normal install must not modify:

- `AI-VERSE.yaml`;
- `AGENTS.md`;
- `CLAUDE.md`;
- `skills/registry.yaml`;
- `agents/registry.yaml`;
- `system/`;
- sibling extension entries.

## 3. Proposed registry entry

```json
{
  "id": "ai-verse-token",
  "supported": true,
  "installed": true,
  "enabled": true,
  "version": "<version>",
  "source": "AI-Verse-Token",
  "instructions": ".aiverse/extensions/ai-verse-token/INSTRUCTIONS.md",
  "engine": ".aiverse/extensions/ai-verse-token/engine.mjs",
  "adapters": []
}
```

Unknown registry fields and unrelated entries must be preserved.

## 4. AI-Verse Data boundary

Token should **not** store its canonical ledger in AI-Verse Data.

Reasons:

- telemetry has high append volume and distinct retention/indexing needs;
- Data is canonical operational structured records;
- Token must work without Data;
- installation order must not matter;
- one extension must not become required to boot another.

Optional integrations later:

- export selected rollups into Data when an App explicitly models them;
- allow Data-driven applications to query Token through a client/adapter;
- never open another layer's SQLite file directly.

## 5. Dashboard

Dashboard is presentation only.

Expected path:

```text
Browser
  -> Dashboard Gateway
  -> selected trusted system root
  -> Token read-only projection
  -> Token ledger/query engine
```

Dashboard should be able to render:

- spend/token/time over time;
- model/provider/platform breakdowns;
- request/session/run detail;
- cost truth status;
- pricing freshness;
- budgets/quota;
- agent/workspace/task attribution;
- latency/TTFT/TPS;
- cache/context efficiency.

No browser direct SQLite access.

## 6. Multiple Bots

Multiple Bots can attach trusted dimensions to execution:

```text
bot_id
worker_id
team_run_id
task_id
workspace_id
```

Token can return budget/usage state to coordination policy.

A Bot must not gain new authority by editing Token labels in a prompt.

## 7. Brain

Brain may query bounded usage intelligence such as:

```text
spend today
most expensive initiative
latency regression
budget remaining
unpriced usage share
```

Brain does not write or own the Token ledger.

## 8. Skills

A Skill can declare telemetry tags/correlation IDs and can query Token through a bounded read client.

Skill installation does not grant provider billing credentials.

## 9. Connections

Connections can own credential/source handles for provider Usage/Cost APIs.

Token receives a scoped connector/credential handle and never persists raw secrets into the ledger.

## 10. Automations

Automations may schedule:

```text
prices sync
provider usage/cost refresh
usage import
budget checks
retention/backup
```

Token itself does not become a second OS scheduler.

## 11. Health

Token doctor status should distinguish:

```text
installed
registered
enabled
healthy
ledger_ok
collector_health
pricing_freshness
cost_truth_health
unpriced_usage_share
provider_auth_missing
migration_required
corrupt
unsupported
```

Registration is not health.

## 12. Any-install-order law

Must work for:

```text
OS -> Token
OS -> Data -> Token
OS -> Token -> Data
OS -> Memory -> Token
OS -> Token -> Memory
OS -> Multiple Bots -> Token
OS -> Token -> Multiple Bots
OS -> Dashboard -> Token
OS -> Token -> Dashboard
```

Sibling presence changes available adapters, not source-of-truth ownership.
