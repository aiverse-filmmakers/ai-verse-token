import type { TokenReader } from "../read/index.js";
import type { UsageGroupDimension, UsageQueryFilter } from "../query/index.js";

export interface TokenDashboardProvenance {
  readonly source: "ai-verse-token";
  readonly read_only: true;
  readonly opens_sqlite_directly: false;
}

export interface TokenDashboardOverview {
  readonly summary: ReturnType<TokenReader["summary"]>;
  readonly time: ReturnType<TokenReader["time"]>;
  readonly efficiency: ReturnType<TokenReader["efficiency"]>;
  readonly provenance: TokenDashboardProvenance;
}

export interface TokenDashboardProjection {
  overview(filter?: UsageQueryFilter): TokenDashboardOverview;
  breakdown(dimension: UsageGroupDimension, filter?: UsageQueryFilter): ReturnType<TokenReader["aggregate"]>;
  timeline(bucket: "hour" | "day", filter?: UsageQueryFilter): ReturnType<TokenReader["time"]>;
}

const PROVENANCE: TokenDashboardProvenance = Object.freeze({ source: "ai-verse-token", read_only: true, opens_sqlite_directly: false });

export function createTokenDashboardProjection(reader: TokenReader): TokenDashboardProjection {
  return Object.freeze({
    overview(filter?: UsageQueryFilter): TokenDashboardOverview {
      return Object.freeze({
        summary: reader.summary(filter),
        time: reader.time({ ...(filter === undefined ? {} : { filter }), max_events: 10_000 }),
        efficiency: reader.efficiency({ ...(filter === undefined ? {} : { filter }), max_events: 10_000 }),
        provenance: PROVENANCE
      });
    },
    breakdown(dimension: UsageGroupDimension, filter?: UsageQueryFilter) {
      return reader.aggregate({
        ...(filter === undefined ? {} : { filter }),
        groupBy: [dimension],
        metrics: [
          { operator: "count" },
          { operator: "sum", field: "input_tokens" },
          { operator: "sum", field: "output_tokens" },
          { operator: "sum", field: "reasoning_tokens" },
          { operator: "sum", field: "cache_read_tokens" },
          { operator: "sum", field: "cache_write_tokens" }
        ],
        limit: 100
      });
    },
    timeline(bucket: "hour" | "day", filter?: UsageQueryFilter) {
      return reader.time({ ...(filter === undefined ? {} : { filter }), bucket, max_events: 10_000 });
    }
  });
}
