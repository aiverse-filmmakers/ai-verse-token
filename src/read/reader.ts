import { existsSync } from "node:fs";
import { CostEngine, type CostResult } from "../cost/index.js";
import { analyzeEfficiency } from "../efficiency/index.js";
import type { UsageEvent } from "../protocol/types.js";
import {
  PriceSnapshotStore,
  createDefaultPricingSourceRegistry,
  type PriceFreshnessEvidence,
  type PricingSourceRegistry
} from "../pricing/index.js";
import type { UsageAggregateRequest, UsageQueryFilter, UsageQueryRequest, UsageQueryResult } from "../query/index.js";
import { openTokenLedger, type TokenLedger } from "../storage/index.js";
import { analyzeUsageTime, rollupUsageTime } from "../time/index.js";
import { authorizeFilter, validateReadAuthorization, type TokenReadAuthorization } from "./authorization.js";
import { TokenReadError } from "./reader-error.js";
import {
  TOKEN_READ_DEFAULT_ANALYSIS_EVENTS,
  TOKEN_READ_MAX_ANALYSIS_EVENTS,
  type BoundedReadRequest,
  type EfficiencyReadRequest,
  type EfficiencyReadResult,
  type TimeReadRequest,
  type TimeReadResult,
  type TokenCostReadResult,
  type TokenOverview,
  type TokenReadApi,
  type TokenReadOpenOptions,
  type TokenSummary
} from "./types.js";

export { TokenReadError } from "./reader-error.js";

function maxEvents(value: number | undefined): number {
  const result = value ?? TOKEN_READ_DEFAULT_ANALYSIS_EVENTS;
  if (!Number.isSafeInteger(result) || result < 1 || result > TOKEN_READ_MAX_ANALYSIS_EVENTS) {
    throw new TokenReadError("READ_INVALID", `max_events must be an integer in 1..${TOKEN_READ_MAX_ANALYSIS_EVENTS}`);
  }
  return result;
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

function freshnessEvidence(store: PriceSnapshotStore | null, registry: PricingSourceRegistry): Readonly<Record<string, PriceFreshnessEvidence | undefined>> {
  if (store === null) return Object.freeze({});
  const result: Record<string, PriceFreshnessEvidence | undefined> = {};
  for (const source of registry.list()) {
    const state = store.syncState(source.source_id);
    if (state?.last_checked_at === undefined) continue;
    if (state.etag === undefined && state.content_digest_sha256 === undefined) continue;
    result[source.source_id] = Object.freeze({
      checked_at: state.last_checked_at,
      ...(state.etag === undefined ? {} : { etag: state.etag }),
      ...(state.content_digest_sha256 === undefined ? {} : { content_digest_sha256: state.content_digest_sha256 })
    });
  }
  return Object.freeze(result);
}

export class TokenReader implements TokenReadApi {
  #ledger: TokenLedger;
  readonly #authorization: TokenReadAuthorization;
  readonly #pricingStore: PriceSnapshotStore | null;
  readonly #pricingRegistry: PricingSourceRegistry;
  readonly #costEngine: CostEngine;

  constructor(
    ledger: TokenLedger,
    options: {
      readonly authorization: TokenReadAuthorization;
      readonly pricing_root?: string;
      readonly pricing_registry?: PricingSourceRegistry;
    }
  ) {
    if (!ledger.readOnly) throw new TokenReadError("READ_INVALID", "TokenReader requires a read-only ledger");
    this.#ledger = ledger;
    this.#authorization = validateReadAuthorization(options.authorization);
    this.#pricingRegistry = options.pricing_registry ?? createDefaultPricingSourceRegistry();
    this.#costEngine = new CostEngine(this.#pricingRegistry);
    this.#pricingStore = options.pricing_root !== undefined && existsSync(options.pricing_root)
      ? new PriceSnapshotStore(options.pricing_root)
      : null;
  }

  get closed(): boolean {
    return this.#ledger.closed;
  }

  #assertOpen(): void {
    if (this.closed) throw new TokenReadError("READ_CLOSED", "TokenReader is closed");
  }

  #filter(filter: UsageQueryFilter | undefined): UsageQueryFilter | undefined {
    return authorizeFilter(filter, this.#authorization);
  }

  #bounded(request: BoundedReadRequest): BoundedReadRequest {
    const filter = this.#filter(request.filter);
    return Object.freeze({
      ...(filter === undefined ? {} : { filter }),
      ...(request.max_events === undefined ? {} : { max_events: request.max_events })
    });
  }

  #rate(events: readonly UsageEvent[]): readonly CostResult[] {
    const snapshots = this.#pricingStore?.list() ?? Object.freeze([]);
    const evidence = freshnessEvidence(this.#pricingStore, this.#pricingRegistry);
    return Object.freeze(events.map((event) => this.#costEngine.rate({
      event,
      price_snapshots: snapshots,
      context: { freshness_evidence_by_source: evidence }
    })));
  }

  query(request: UsageQueryRequest = {}): UsageQueryResult {
    this.#assertOpen();
    const filter = this.#filter(request.filter);
    return this.#ledger.queryUsage({
      ...(filter === undefined ? {} : { filter }),
      ...(request.order === undefined ? {} : { order: request.order }),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.cursor === undefined ? {} : { cursor: request.cursor })
    });
  }

  aggregate(request: UsageAggregateRequest): ReturnType<TokenLedger["aggregateUsage"]> {
    this.#assertOpen();
    const filter = this.#filter(request.filter);
    return this.#ledger.aggregateUsage({
      ...(filter === undefined ? {} : { filter }),
      ...(request.groupBy === undefined ? {} : { groupBy: request.groupBy }),
      metrics: request.metrics,
      ...(request.limit === undefined ? {} : { limit: request.limit })
    });
  }

  summary(filter?: UsageQueryFilter): TokenSummary {
    this.#assertOpen();
    const authorizedFilter = this.#filter(filter);
    const result = this.#ledger.aggregateUsage({
      ...(authorizedFilter === undefined ? {} : { filter: authorizedFilter }),
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

  costs(request: BoundedReadRequest = {}): TokenCostReadResult {
    this.#assertOpen();
    const events = collectBounded(this.#ledger, this.#bounded(request));
    const results = this.#rate(events);
    const coverage = analyzeEfficiency({ events, costs: results }).overall.costs;
    return Object.freeze({ event_count: events.length, results, summary: coverage });
  }

  overview(request: BoundedReadRequest = {}): TokenOverview {
    this.#assertOpen();
    const bounded = this.#bounded(request);
    const events = collectBounded(this.#ledger, bounded);
    const results = this.#rate(events);
    const coverage = analyzeEfficiency({ events, costs: results }).overall.costs;
    return Object.freeze({
      owner: "ai-verse-token",
      attribution_is_authority: false,
      summary: this.summary(bounded.filter),
      costs: coverage
    });
  }

  time(request: TimeReadRequest = {}): TimeReadResult {
    this.#assertOpen();
    const bounded = this.#bounded(request);
    const events = collectBounded(this.#ledger, bounded);
    return Object.freeze({
      event_count: events.length,
      analysis: analyzeUsageTime(events),
      rollups: request.bucket === undefined ? Object.freeze([]) : rollupUsageTime(events, { bucket: request.bucket })
    });
  }

  efficiency(request: EfficiencyReadRequest = {}): EfficiencyReadResult {
    this.#assertOpen();
    const bounded = this.#bounded(request);
    const events = collectBounded(this.#ledger, bounded);
    const costs = this.#rate(events);
    return Object.freeze({
      event_count: events.length,
      analysis: analyzeEfficiency({
        events,
        costs,
        ...(request.group_by === undefined ? {} : { group_by: request.group_by }),
        ...(request.retry_links === undefined ? {} : { retry_links: request.retry_links })
      }),
      cost_scope: "actual_calculated_unknown"
    });
  }

  close(): void {
    this.#ledger.close();
  }
}

export function openTokenReader(options: TokenReadOpenOptions): TokenReader {
  return new TokenReader(openTokenLedger({ path: options.path, mode: "read-only" }), {
    authorization: options.authorization,
    ...(options.pricing_root === undefined ? {} : { pricing_root: options.pricing_root }),
    ...(options.pricing_registry === undefined ? {} : { pricing_registry: options.pricing_registry })
  });
}
