# Time Metrics Contract

## 1. Goal

Time must be queryable per request, session, run, task, hour, day, model, provider, agent and workspace without mixing fundamentally different concepts.

## 2. Request timestamps

When available:

```text
started_at
first_byte_at
first_token_at
last_token_at
ended_at
```

## 3. Derived request metrics

```text
wall_ms                = ended_at - started_at
ttft_ms                = first_token_at - started_at
generation_ms          = ended_at - first_token_at
time_per_output_token  = generation_ms / output_tokens
tokens_per_second      = output_tokens / generation_seconds
```

Additional source-provided fields may include:

```text
queue_ms
provider_ms
gateway_overhead_ms
moderation_ms
tool_wait_ms
network_ms
```

Source-provided timing is preserved with provenance rather than overwritten by an inferred value.

## 4. Session/run metrics

### Session span

```text
last_observed_at - first_observed_at
```

This can include long idle gaps and must not be mislabeled active time.

### Active wall time

If exact request/tool intervals exist, compute the **union of intervals**.

Example:

```text
request A: 10:00:00 -> 10:00:10
request B: 10:00:05 -> 10:00:15

summed request time: 20s
active wall time:    15s
```

Both values are useful and must be kept separately.

### Compute time

Sum of model-request durations.

May exceed wall time under concurrency. This is expected.

### Tool wait time

Sum/union can both be exposed when tool intervals are known.

### Idle time

Only derive exact idle time when session boundaries and active intervals are trustworthy:

```text
session_span - union(active intervals)
```

Do not invent active/idle time from arbitrary timestamp-gap heuristics in strict mode.

## 5. Concurrency

Per time window:

- peak concurrent requests;
- average concurrent requests while active;
- overlap duration;
- concurrency factor = compute_time / active_wall_time.

This is especially useful for multi-agent systems.

## 6. Hour/day reporting

For each bucket:

- request count;
- input/output/cache/reasoning tokens;
- authoritative/rated/unpriced cost totals;
- active wall seconds;
- compute seconds;
- tool-wait seconds;
- p50/p95/p99 request wall time;
- p50/p95/p99 TTFT;
- p50/p95/p99 output TPS;
- peak concurrency.

## 7. Request attribution

Timing should carry the same scope dimensions as token/cost events:

```text
workspace/project
agent/Bot/Worker
task/run/session
Skill/automation
tool/MCP server
billing platform
model/provider
```

## 8. Unknowns

If a source only gives `started_at` and no `ended_at`, duration is unknown.

If a source gives session start/end but no request spans, session span is known but request/active wall time is unknown.

Unknown is a valid state.
