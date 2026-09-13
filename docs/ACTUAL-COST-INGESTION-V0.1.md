# Provider/Runtime Actual-Cost Ingestion v0.1

**Task:** 19 / 32  
**Status:** COMPLETE

## Purpose

Actual-cost ingestion is the trusted path for monetary charges already reported by a provider or runtime. It normalizes those facts into the canonical event `actual_charge` field without calculating or repricing them.

## Trusted source registry

A source definition binds an ID to:

- `provider_reported` plus allowed billing platforms; or
- `runtime_reported` plus allowed runtimes.

First-release built-ins include:

- `openrouter-generation-api` for OpenRouter-billed requests;
- `hermes-state-db` for Hermes runtime-reported actual cost.

Provider-specific network/file parsing is still owned by the later adapter/collector tasks.

## Rules

- unknown source IDs cannot self-promote to trusted actual cost;
- source route/runtime must match the event;
- amount must be finite and non-negative;
- original three-letter currency is preserved;
- optional external charge ID and report time are preserved;
- exact replay is idempotent;
- a different actual charge cannot overwrite an existing one;
- route identity, usage and collector provenance are not rewritten.

The Task 18 cost engine always returns a trusted attached charge as `ACTUAL` before considering public-tariff calculation.
