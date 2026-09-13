import {
  AI_VERSE_TOKEN_LEDGER_PATH,
  AI_VERSE_TOKEN_PRICING_ROOT
} from "../native/constants.js";
import { safeRelativePath } from "../native/paths.js";
import type { UsageQueryFilter } from "../query/index.js";
import {
  openTokenReader,
  TokenReadError,
  type TokenReadAuthorization,
  type TokenReader
} from "../read/index.js";
import { privacySafeUsageEvent } from "../export/index.js";

export interface TokenGatewayProjectionOptions {
  readonly root: string;
  /** Must come from Gateway/OS authorization. Token never derives permission from telemetry attribution. */
  readonly authorization: TokenReadAuthorization;
}

export interface TokenGatewayUsageOverview {
  readonly owner: "ai-verse-token";
  readonly read_only: true;
  readonly attribution_is_authority: false;
  readonly summary: ReturnType<TokenReader["summary"]>;
  readonly costs: ReturnType<TokenReader["costs"]>["summary"];
}

export interface TokenGatewayUsageEvents {
  readonly owner: "ai-verse-token";
  readonly read_only: true;
  readonly attribution_is_authority: false;
  readonly events: readonly ReturnType<typeof privacySafeUsageEvent>[];
  readonly has_more: boolean;
  readonly next_cursor: string | null;
}

export interface TokenGatewayProjection {
  overview(filter?: UsageQueryFilter): TokenGatewayUsageOverview;
  events(options?: { readonly filter?: UsageQueryFilter; readonly limit?: number; readonly cursor?: string | null }): TokenGatewayUsageEvents;
  close(): void;
}

export function openTokenGatewayProjection(options: TokenGatewayProjectionOptions): TokenGatewayProjection {
  if (options.authorization === undefined || options.authorization === null) {
    throw new TokenReadError("READ_UNAUTHORIZED_SCOPE", "Gateway projection requires a host authorization envelope");
  }
  const reader = openTokenReader({
    path: safeRelativePath(options.root, AI_VERSE_TOKEN_LEDGER_PATH),
    pricing_root: safeRelativePath(options.root, AI_VERSE_TOKEN_PRICING_ROOT),
    authorization: options.authorization
  });
  return Object.freeze({
    overview(filter?: UsageQueryFilter): TokenGatewayUsageOverview {
      const overview = reader.overview({ ...(filter === undefined ? {} : { filter }), max_events: 10_000 });
      return Object.freeze({ owner: "ai-verse-token", read_only: true, attribution_is_authority: false, summary: overview.summary, costs: overview.costs });
    },
    events(request: { readonly filter?: UsageQueryFilter; readonly limit?: number; readonly cursor?: string | null } = {}): TokenGatewayUsageEvents {
      const result = reader.query({
        ...(request.filter === undefined ? {} : { filter: request.filter }),
        limit: request.limit ?? 50,
        ...(request.cursor === undefined ? {} : { cursor: request.cursor })
      });
      return Object.freeze({
        owner: "ai-verse-token",
        read_only: true,
        attribution_is_authority: false,
        events: Object.freeze(result.events.map(privacySafeUsageEvent)),
        has_more: result.hasMore,
        next_cursor: result.nextCursor
      });
    },
    close(): void { reader.close(); }
  });
}
