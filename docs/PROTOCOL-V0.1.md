# AI-Verse Token Protocol v0.1

**Protocol version:** `ai-verse-token/0.1`  
**Task:** 9 / 32

## Purpose

The canonical usage event is the smallest durable observation that all collectors normalize into before storage. It is runtime-neutral and does not contain prompt or response text.

## Required top-level facts

Every event has:

- `schema_version`;
- `event_id`;
- `source`;
- `observed_at`;
- `identity`;
- `usage`;
- `timing`;
- `provenance`.

Optional correlation identifiers include request, session, run and task IDs. Scope may add system, workspace, project, agent, Bot, Worker, Skill, automation and tool IDs.

## Source versus identity

`source` answers where Token observed the record:

```text
runtime = hermes
source_type = sqlite-session
source_platform = commandcode
```

`identity` answers what route/model the observation describes:

```text
billing_platform = commandcode
inference_provider = z-ai
requested_model = glm-5.3-flash
resolved_model = glm-5.3-flash
```

These are intentionally separate. A runtime is not automatically the billing platform, and the billing platform is not automatically the inference provider.

## Unknown versus zero

The protocol never converts missing information to zero.

- omitted: source did not provide the field or the field is not applicable;
- `null`: source explicitly has no known value for the field;
- `0`: source explicitly reports zero.

This distinction applies to tokens, timings and monetary values.

## Usage categories

The first protocol supports:

- input tokens;
- output tokens;
- reasoning tokens;
- cache read tokens;
- cache write tokens;
- cached input tokens;
- audio input/output tokens;
- image input/output units;
- web-search units;
- request units;
- provider-reported total tokens.

Token counts must be non-negative safe integers. Non-token usage units must be finite non-negative numbers.

## Timing

Supported request-level observations include:

- start;
- first byte;
- first token;
- last token;
- end;
- wall duration;
- TTFT;
- generation duration;
- queue time;
- provider time;
- gateway overhead;
- tool wait;
- network time.

If both start and end are known, end cannot precede start. More advanced interval-union and concurrency semantics belong to Task 27.

## Actual charge

`actual_charge` is optional and is only for a charge directly reported by a trusted runtime or billing platform.

It contains:

- finite non-negative amount;
- three-letter uppercase currency;
- source: `provider_reported` or `runtime_reported`;
- optional external charge ID;
- optional report timestamp.

A zero actual charge is valid and remains distinct from unknown cost.

Calculated costs do not belong in `actual_charge`. They are produced later by the pricing/cost engine.

## Provenance and privacy

Every event records collector identity, a source-record fingerprint and usage/timing quality.

`content_stored` is required and must be exactly `false`. Canonical Token accounting events do not require prompt or response content.

## Validation behavior

The runtime validator:

- rejects unknown fields;
- rejects non-plain objects;
- rejects NUL-containing strings;
- rejects malformed timezone-less date-times;
- rejects negative, infinite and unsafe numeric values;
- enforces bounded strings and durations;
- preserves `null`, zero and omitted values separately;
- rejects protocol-version mismatches;
- exposes stable `TokenProtocolValidationError` failures with field paths.

The JSON Schema in `schemas/usage-event-v1.schema.json` is the machine-readable planning/interchange representation. Runtime validation is implemented under `src/protocol/`.
