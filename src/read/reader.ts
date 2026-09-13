import type { CostResult } from "../cost/types.js";
import { analyzeEfficiency } from "../efficiency/index.js";
import type { UsageEvent } from "../protocol/types.js";
import type { UsageQueryFilter, UsageQueryRequest, UsageQueryResult } from "../query/index.js";
import { openTokenLedger, type TokenLedger } from "../storage/index.js";
import { analyzeUsageTime, rollupUsageTime } from "../time/index.js";
import {
  TOKEN_READ_DEFAULT_ANALYSIS_EVENTS,
  TOKEN_READ_MAX_ANALYSIS_EVENTS,
  type BoundedReadRequest,
  type EfficiencyReadRequest,
  type EfficiencyReadResult,
  type TimeReadRequest,
  type TimeReadResult,
  type TokenReadApi,
  type TokenReadOpenOptions,
  type TokenSummary
} from "./types.js";

export class TokenReadError extends Error {
  readonly code: "READ_INVALID" | "READ_LIMIT_EXCEEDED" | "READ_CLOSED";
  constructor(code: TokenReadError["code"], message: string) {
    super(message);
    this.name = "TokenReadError";
    this.code = code;
  }
}

function maxEvents(value: number | undefined): number {
  const result = value ?? TOKEN_READ_DEFAULT_ANALYSIS_EVENTS;
  if (!Number.isSafeInteger(result) || result < 1 || result > TOKEN_READ_MAX_ANALYSIS_EVENTS) {
    throw new TokenReadError("READ_INVALID", `max_events must be an integer in 1..${TOKEN_READ_MAX_ANALYSIS_EVENTS}`);
  }
  return result;
}

function actualCosts(events: readonly UsageEvent[]): readonly CostResult[] {
  return Object.freeze(events.flatMap((event): CostResult[] => {
    if (event.actual_charge === undefined || event.actual_charge === null) return [];
    return [Object.freeze({
      status: "ACTUAL",
      amount: event.actual_charge.amount,
      currency: event.actual_charge.currency,
      actual_charge: event.actual_charge,
      event_id: event.event_id
    })];
  }));
}

function collectBounded(ledger: TokenLedger, request: BoundedReadRequest): readonly UsageEvent[] {
  const ceiling = maxEvents(request.max_events);
  const events: UsageEvent[] = [];
  let cursor: string | null = null;
  do {
    const remainingPlusProbe = ceiling + 1 - events.length;
    const page = ledger.queryUsage({
      ...(request.filter === undefined ? {} : { filter: request.filter }),
      order: "asc",
      limit: Math.min(500, remainingPlusProbe),
      cursor
    });
    events.push(...page.events);
    if (events.length > ceiling) {
      throw new TokenReadError("READ_LIMIT_EXCEEDED", `analysis exceeds max_events=${ceiling}; narrow the filter or raise the bounded limit`);
    }
    cursor = page.hasMore ? page.nextCursor : null;
  } while (cursor !== null);
  return Object.freeze(events);
}

export class TokenReader implements TokenReadApi {
  #ledger: TokenLedger;

  constructor(ledger: TokenLedger) {
    if (!ledger.readOnly) throw new TokenReadError("READ_INVALID", "TokenReader requires a read-only ledger");
    this.#ledger = ledger;
  }

  get closed(): boolean {
    return this.#ledger.closed;
  }

  #assertOpen(): void {
    if (this.closed) throw new TokenReadError("READ_CLOSED", "TokenReader is closed");
  }

  query(request: UsageQueryRequest = {}): UsageQueryResult {
    this.#assertOpen();
    return this.#ledger.queryUsage(request);
  }

  aggregate(request: Parameters<TokenLedger["aggregateUsage"]>[0]): ReturnType<TokenLedger["aggregateUsage"]> {
    this.#assertOpen();
    return this.#ledger.aggregateUsage(request);
  }

  summary(filter?: UsageQueryFilter): TokenSummary {
    this.#assertOpen();
    const result = this.#ledger.aggregateUsage({
      ...(filter === undefined ? {} : { filter }),
      metrics: [
        { operator: "count" },
        { operator: "sum", field: "input_tokens" },
        { operator: "sum", field: "output_tokens" },
        { operator: "sum", field: "reasoning_tokens" },
        { operator: "sum", field: "cache_read_tokens" },
        { operator: "sum", field: "cache_write_tokens" },
        { operator: "sum", field: "cached_input_tokens" },
        { operator: "sum", field: "total_tokens_reported" }
      ]
    });
    const row = result.rows[0];
    const metrics = row?.metrics ?? {};
    return Object.freeze({
      request_count: metrics.count ?? 0,
      input_tokens: metrics.sum_input_tokens ?? null,
      output_tokens: metrics.sum_output_tokens ?? null,
      reasoning_tokens: metrics.sum_reasoning_tokens ?? null,
      cache_read_tokens: metrics.sum_cache_read_tokens ?? null,
      cache_write_tokens: metrics.sum_cache_write_tokens ?? null,
      cached_input_tokens: metrics.sum_cached_input_tokens ?? null,
      total_tokens_reported: metrics.sum_total_tokens_reported ?? null
    });
  }

  time(request: TimeReadRequest = {}): TimeReadResult {
    this.#assertOpen();
    const events = collectBounded(this.#ledger, request);
    return Object.freeze({
      event_count: events.length,
      analysis: analyzeUsageTime(events),
      rollups: request.bucket === undefined ? Object.freeze([]) : rollupUsageTime(events, { bucket: request.bucket })
    });
  }

  efficiency(request: EfficiencyReadRequest = {}): EfficiencyReadResult {
    this.#assertOpen();
    const events = collectBounded(this.#ledger, request);
    return Object.freeze({
      event_count: events.length,
      analysis: analyzeEfficiency({
        events,
        costs: actualCosts(events),
        ...(request.group_by === undefined ? {} : { group_by: request.group_by }),
        ...(request.retry_links === undefined ? {} : { retry_links: request.retry_links })
      }),
      cost_scope: "actual_only"
    });
  }

  close(): void {
    this.#ledger.close();
  }
}

export function openTokenReader(options: TokenReadOpenOptions): TokenReader {
  return new TokenReader(openTokenLedger({ path: options.path, mode: "read-only" }));
}
