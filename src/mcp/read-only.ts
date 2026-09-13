import { privacySafeUsageEvent } from "../export/index.js";
import type { TokenReadApi } from "../read/index.js";

export const TOKEN_MCP_TOOL_NAMES = [
  "token_summary",
  "token_usage_query",
  "token_usage_aggregate",
  "token_usage_time",
  "token_usage_efficiency"
] as const;
export type TokenMcpToolName = (typeof TOKEN_MCP_TOOL_NAMES)[number];

export interface TokenMcpToolDefinition {
  readonly name: TokenMcpToolName;
  readonly description: string;
  readonly read_only: true;
}

export interface TokenReadOnlyMcpSurface {
  readonly tools: readonly TokenMcpToolDefinition[];
  call(name: TokenMcpToolName, args?: unknown): unknown;
}

const TOOLS: readonly TokenMcpToolDefinition[] = Object.freeze([
  { name: "token_summary", description: "Read aggregate AI usage totals from the Token ledger.", read_only: true },
  { name: "token_usage_query", description: "Read a bounded page of privacy-safe canonical AI usage events.", read_only: true },
  { name: "token_usage_aggregate", description: "Run bounded fixed-dimension usage aggregates without SQL.", read_only: true },
  { name: "token_usage_time", description: "Read bounded request/session timing intelligence.", read_only: true },
  { name: "token_usage_efficiency", description: "Read bounded efficiency metrics using provider-reported actual cost only.", read_only: true }
]);

function object(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("MCP arguments must be a plain object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("MCP arguments must be a plain object");
  return value as Record<string, unknown>;
}

function keysOnly(value: Record<string, unknown>, allowed: readonly string[]): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) if (!set.has(key)) throw new Error(`Unsupported MCP argument '${key}'`);
}

export function createReadOnlyMcpSurface(reader: TokenReadApi): TokenReadOnlyMcpSurface {
  return Object.freeze({
    tools: TOOLS,
    call(name: TokenMcpToolName, rawArgs?: unknown): unknown {
      const args = object(rawArgs);
      if (name === "token_summary") {
        keysOnly(args, ["filter"]);
        return reader.summary(args.filter as never);
      }
      if (name === "token_usage_query") {
        keysOnly(args, ["filter", "order", "limit", "cursor"]);
        const requestedLimit = args.limit === undefined ? 100 : args.limit;
        if (!Number.isSafeInteger(requestedLimit) || (requestedLimit as number) < 1 || (requestedLimit as number) > 100) {
          throw new Error("MCP query limit must be in 1..100");
        }
        const result = reader.query({ ...args, limit: requestedLimit } as never);
        return Object.freeze({
          events: Object.freeze(result.events.map(privacySafeUsageEvent)),
          hasMore: result.hasMore,
          nextCursor: result.nextCursor
        });
      }
      if (name === "token_usage_aggregate") {
        keysOnly(args, ["filter", "groupBy", "metrics", "limit"]);
        return reader.aggregate(args as never);
      }
      if (name === "token_usage_time") {
        keysOnly(args, ["filter", "max_events", "bucket"]);
        const bounded = args.max_events === undefined ? 5_000 : args.max_events;
        if (!Number.isSafeInteger(bounded) || (bounded as number) < 1 || (bounded as number) > 5_000) throw new Error("MCP time max_events must be in 1..5000");
        return reader.time({ ...args, max_events: bounded } as never);
      }
      if (name === "token_usage_efficiency") {
        keysOnly(args, ["filter", "max_events", "group_by", "retry_links"]);
        const bounded = args.max_events === undefined ? 5_000 : args.max_events;
        if (!Number.isSafeInteger(bounded) || (bounded as number) < 1 || (bounded as number) > 5_000) throw new Error("MCP efficiency max_events must be in 1..5000");
        return reader.efficiency({ ...args, max_events: bounded } as never);
      }
      const exhaustive: never = name;
      throw new Error(`Unsupported MCP tool ${String(exhaustive)}`);
    }
  });
}
