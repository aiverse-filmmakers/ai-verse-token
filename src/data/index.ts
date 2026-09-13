import type { UsageEvent } from "../protocol/index.js";
import type { UsageQueryFilter } from "../query/index.js";
import type { TokenReader } from "../read/index.js";
import { tokenReference } from "../ecosystem-common.js";

export interface TokenDataReference {
  readonly uri: string;
  readonly authority: "ai-verse-token";
  readonly ownership_transferred: false;
  readonly event_id: string;
}

export interface TokenDataProjection {
  readonly authority: "ai-verse-token";
  readonly ownership_transferred: false;
  readonly summary: ReturnType<TokenReader["summary"]>;
  readonly generated_at: string;
}

export function tokenDataReference(event: UsageEvent): TokenDataReference {
  return Object.freeze({ uri: tokenReference("event", event.event_id), authority: "ai-verse-token", ownership_transferred: false, event_id: event.event_id });
}

export function createTokenDataProjection(reader: TokenReader, filter?: UsageQueryFilter, now = new Date()): TokenDataProjection {
  if (Number.isNaN(now.getTime())) throw new Error("Projection time is invalid");
  return Object.freeze({
    authority: "ai-verse-token",
    ownership_transferred: false,
    summary: reader.summary(filter),
    generated_at: now.toISOString()
  });
}
