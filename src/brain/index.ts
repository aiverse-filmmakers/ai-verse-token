import { privacySafeUsageEvent } from "../export/index.js";
import type { UsageQueryFilter } from "../query/index.js";
import type { TokenReader } from "../read/index.js";

export interface TokenBrainAnswer<T> {
  readonly answer: T;
  readonly provenance: {
    readonly source: "ai-verse-token";
    readonly read_only: true;
    readonly bounded: true;
  };
}

const PROVENANCE = Object.freeze({ source: "ai-verse-token" as const, read_only: true as const, bounded: true as const });

export interface TokenBrainAdapter {
  summary(filter?: UsageQueryFilter): TokenBrainAnswer<ReturnType<TokenReader["summary"]>>;
  recent(filter?: UsageQueryFilter, limit?: number): TokenBrainAnswer<readonly ReturnType<typeof privacySafeUsageEvent>[]>;
  time(filter?: UsageQueryFilter): TokenBrainAnswer<ReturnType<TokenReader["time"]>>;
  efficiency(filter?: UsageQueryFilter): TokenBrainAnswer<ReturnType<TokenReader["efficiency"]>>;
}

export function createTokenBrainAdapter(reader: TokenReader): TokenBrainAdapter {
  return Object.freeze({
    summary(filter?: UsageQueryFilter) { return Object.freeze({ answer: reader.summary(filter), provenance: PROVENANCE }); },
    recent(filter?: UsageQueryFilter, limit = 20) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Brain recent limit must be in 1..100");
      const page = reader.query({ ...(filter === undefined ? {} : { filter }), order: "desc", limit });
      return Object.freeze({ answer: Object.freeze(page.events.map(privacySafeUsageEvent)), provenance: PROVENANCE });
    },
    time(filter?: UsageQueryFilter) { return Object.freeze({ answer: reader.time({ ...(filter === undefined ? {} : { filter }), max_events: 5_000 }), provenance: PROVENANCE }); },
    efficiency(filter?: UsageQueryFilter) { return Object.freeze({ answer: reader.efficiency({ ...(filter === undefined ? {} : { filter }), max_events: 5_000 }), provenance: PROVENANCE }); }
  });
}
