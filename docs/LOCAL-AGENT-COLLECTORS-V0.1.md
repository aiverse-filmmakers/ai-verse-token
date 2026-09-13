# Local Coding-Agent Collectors v0.1

## Purpose

Task 23 adds passive local usage collectors for the five first-release coding-agent runtimes:

- Claude Code
- Codex
- OpenCode
- Gemini CLI
- OpenClaw

Each collector reads the runtime's local telemetry/state only, emits canonical `ai-verse-token/0.1` usage events through the Task 21 collector SDK, stores no prompt/response content, and never writes to the source runtime.

## Shared rules

All local collectors:

- use stable source IDs derived from relative local paths;
- reject symlinked or non-regular source files;
- checkpoint incremental progress;
- keep missing usage/timing fields unknown rather than inventing values;
- preserve runtime, billing-platform, provider and model identity separately;
- never promote source-side estimated cost to `ACTUAL`;
- emit correlation keys for later cross-source deduplication;
- keep prompt and response content out of Token events and storage.

Large JSONL sources are read incrementally in bounded chunks. A non-newline-terminated tail is treated as an in-progress writer record and retried later rather than parsed as final data.

## Claude Code

Source shape: project/session JSONL under the Claude Code state tree.

Behavior:

- imports assistant usage records;
- preserves model and session/request identity;
- maps cache creation/read counters separately;
- deduplicates repeated content-block records representing the same billed request;
- does not infer request timing from transcript content.

## Codex

Source shape: rollout JSONL under `~/.codex/sessions/...` or the supplied Codex home.

Historical compatibility:

- older rollouts use `event_msg` / `token_count` with `last_token_usage`;
- Codex 0.153.0+ persists durable per-response `token_usage_record` rollout items.

For Codex 0.153.0+ Token prefers the durable per-response record and suppresses the coexisting legacy `token_count` stream so the same response is not counted twice. The durable record contributes response, turn, root-turn and session correlation keys.

Token normalizes Codex counters so cached input and reasoning output are represented as subsets rather than double-counted in ordinary input/output totals. Total-only recomputation records are marked `estimated` and cannot authorize calculated money.

## OpenCode

Source shape: local OpenCode SQLite database.

Behavior:

- opens the source database read-only;
- imports assistant message token counters and provider/model identity;
- preserves cache/reasoning categories;
- does not trust arbitrary persisted `cost` values as provider-confirmed actual charge;
- source bytes must remain unchanged after collection.

## Gemini CLI

Source shape: session JSON files in the Gemini CLI chats tree.

Behavior:

- imports message-level model usage;
- preserves cached and thought/reasoning counters;
- protects incremental cursor identity against source rewrites;
- maps Google direct billing identity only when the local source establishes it.

## OpenClaw

Source shape: assistant session JSONL under the OpenClaw agent state tree.

Behavior:

- imports normalized assistant usage counters;
- preserves provider/model/API route identity;
- distrusts persisted source-side cost as authoritative actual money;
- marks all-zero usage records `unknown` rather than asserting a genuine zero-token billed request;
- excludes trajectory files from normal session discovery.

## Discovery

Discovery functions are explicit and bounded:

- `discoverClaudeCodeSources`
- `discoverCodexSources`
- `discoverOpenCodeSources`
- `discoverGeminiCliSources`
- `discoverOpenClawSources`

Discovery never follows symlinks and never grants a collector authority over a sibling runtime.

## Explicit non-goals

Task 23 does not:

- fetch remote provider billing APIs;
- perform cross-provider reconciliation;
- solve all cross-source deduplication;
- calculate costs;
- store transcript content;
- infer missing timing;
- mutate local agent state.

Remote usage/cost APIs are Tasks 24-26. Cross-source deduplication closes in Task 26.

## Acceptance

Task 23 passes only when tests prove:

- all five collectors are registered and runnable;
- Claude repeated request records do not double-count;
- JSONL pagination retains parser state;
- current Codex durable usage and legacy usage are both supported without current-format double-counting;
- Codex total-only recomputations remain non-authoritative;
- OpenCode is read-only;
- Gemini source rewrites fail closed;
- OpenClaw zero telemetry is not promoted to known usage;
- canonical discovery roots are bounded and safe;
- the complete inherited suite remains green.
