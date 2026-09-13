import type { UsageEvent } from "../protocol/index.js";
import { tokenReference } from "../ecosystem-common.js";

export interface TokenMemoryEvidence {
  readonly uri: string;
  readonly kind: "usage-event";
  readonly event_id: string;
  readonly observed_at: string;
  readonly runtime: string;
  readonly model: string | null;
  readonly workspace_id: string | null;
  readonly project_id: string | null;
}

export interface TokenMemoryCandidate {
  readonly candidate_kind: "historical-usage-summary";
  readonly title: string;
  readonly summary: string;
  readonly evidence: readonly TokenMemoryEvidence[];
  readonly auto_write: false;
}

export function tokenMemoryEvidence(event: UsageEvent): TokenMemoryEvidence {
  return Object.freeze({
    uri: tokenReference("event", event.event_id),
    kind: "usage-event",
    event_id: event.event_id,
    observed_at: event.observed_at,
    runtime: event.source.runtime,
    model: event.identity.resolved_model ?? event.identity.requested_model ?? null,
    workspace_id: event.scope?.workspace_id ?? null,
    project_id: event.scope?.project_id ?? null
  });
}

export function proposeTokenMemoryCandidate(input: {
  readonly title: string;
  readonly summary: string;
  readonly events: readonly UsageEvent[];
}): TokenMemoryCandidate {
  if (input.title.trim().length === 0 || input.summary.trim().length === 0) throw new Error("Memory candidate title and summary are required");
  if (input.events.length < 1 || input.events.length > 20) throw new Error("Memory candidate requires 1..20 evidence events");
  return Object.freeze({
    candidate_kind: "historical-usage-summary",
    title: input.title,
    summary: input.summary,
    evidence: Object.freeze(input.events.map(tokenMemoryEvidence)),
    auto_write: false
  });
}
