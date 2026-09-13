import type { UsageEvent } from "../protocol/types.js";
import { validateUsageEvent } from "../protocol/validation.js";
import type {
  ConcurrencyMetrics,
  RequestTimeMetrics,
  TimeAnalysis,
  TimeRollupOptions,
  TimeRollupRow,
  TimeRollupTokenTotals,
  TimeSummary
} from "./types.js";

interface Interval {
  readonly start: number;
  readonly end: number;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function millis(value: string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function deriveDuration(start: string | null | undefined, end: string | null | undefined): number | null {
  const a = millis(start);
  const b = millis(end);
  if (a === null || b === null || b < a) return null;
  return b - a;
}

export function requestTimeMetrics(value: UsageEvent): RequestTimeMetrics {
  const event = validateUsageEvent(value);
  const startMs = millis(event.timing.started_at);
  const endMs = millis(event.timing.ended_at);
  const interval = startMs !== null && endMs !== null && endMs >= startMs
    ? Object.freeze({ start_ms: startMs, end_ms: endMs })
    : null;

  const timestampWall = deriveDuration(event.timing.started_at, event.timing.ended_at);
  const timestampTtft = deriveDuration(event.timing.started_at, event.timing.first_token_at);
  const timestampGeneration = deriveDuration(event.timing.first_token_at, event.timing.ended_at);
  const reportedWall = finiteNonNegative(event.timing.wall_ms);
  const reportedTtft = finiteNonNegative(event.timing.ttft_ms);
  const reportedGeneration = finiteNonNegative(event.timing.generation_ms);

  const wall = timestampWall ?? reportedWall;
  const ttft = timestampTtft ?? reportedTtft;
  const generation = timestampGeneration ?? reportedGeneration;
  const outputTokens = finiteNonNegative(event.usage.output_tokens);
  const timePerOutput = generation !== null && outputTokens !== null && outputTokens > 0
    ? generation / outputTokens
    : null;
  const tps = generation !== null && generation > 0 && outputTokens !== null && outputTokens > 0
    ? outputTokens / (generation / 1000)
    : null;

  return Object.freeze({
    event_id: event.event_id,
    request_id: event.request_id ?? null,
    session_id: event.session_id ?? null,
    wall_ms: wall,
    wall_source: timestampWall !== null ? "timestamps" : reportedWall !== null ? "reported" : "unknown",
    ttft_ms: ttft,
    ttft_source: timestampTtft !== null ? "timestamps" : reportedTtft !== null ? "reported" : "unknown",
    generation_ms: generation,
    generation_source: timestampGeneration !== null ? "timestamps" : reportedGeneration !== null ? "reported" : "unknown",
    time_per_output_token_ms: timePerOutput,
    output_tokens_per_second: tps,
    exact_interval: interval
  });
}

function percentile(values: readonly number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(percentileValue * sorted.length));
  return sorted[rank - 1] ?? null;
}

function intervalConcurrency(intervals: readonly Interval[]): ConcurrencyMetrics {
  if (intervals.length === 0) {
    return {
      interval_request_count: 0,
      active_wall_ms: null,
      interval_compute_ms: null,
      overlap_ms: null,
      peak_concurrent_requests: null,
      average_concurrency_while_active: null,
      concurrency_factor: null
    };
  }

  const points: Array<{ time: number; delta: number }> = [];
  let intervalCompute = 0;
  for (const interval of intervals) {
    intervalCompute += interval.end - interval.start;
    points.push({ time: interval.start, delta: 1 }, { time: interval.end, delta: -1 });
  }
  points.sort((a, b) => a.time - b.time || a.delta - b.delta);

  let active = 0;
  let overlap = 0;
  let peak = intervals.length > 0 ? 1 : 0;
  let concurrency = 0;
  let previousTime = points[0]!.time;
  let index = 0;
  while (index < points.length) {
    const time = points[index]!.time;
    const duration = time - previousTime;
    if (duration > 0) {
      if (concurrency > 0) active += duration;
      if (concurrency > 1) overlap += duration;
    }
    let delta = 0;
    while (index < points.length && points[index]!.time === time) {
      delta += points[index]!.delta;
      index += 1;
    }
    concurrency += delta;
    if (concurrency > peak) peak = concurrency;
    previousTime = time;
  }

  const factor = active > 0 ? intervalCompute / active : intervals.length > 0 ? 1 : null;
  return {
    interval_request_count: intervals.length,
    active_wall_ms: active,
    interval_compute_ms: intervalCompute,
    overlap_ms: overlap,
    peak_concurrent_requests: peak,
    average_concurrency_while_active: factor,
    concurrency_factor: factor
  };
}

function sessionSpan(events: readonly UsageEvent[]): number | null {
  if (events.length < 2) return events.length === 1 ? 0 : null;
  const times = events.map((event) => millis(event.observed_at)).filter((value): value is number => value !== null);
  if (times.length !== events.length) return null;
  return Math.max(...times) - Math.min(...times);
}

function summarize(
  events: readonly UsageEvent[],
  metrics: readonly RequestTimeMetrics[],
  intervalsOverride?: readonly Interval[],
  computeOverride?: { readonly total: number | null; readonly known: number; readonly unknown: number }
): TimeSummary {
  const walls = metrics.map((metric) => metric.wall_ms).filter((value): value is number => value !== null);
  const ttfts = metrics.map((metric) => metric.ttft_ms).filter((value): value is number => value !== null);
  const tps = metrics.map((metric) => metric.output_tokens_per_second).filter((value): value is number => value !== null);
  const intervals = intervalsOverride ?? metrics
    .map((metric) => metric.exact_interval)
    .filter((value): value is NonNullable<RequestTimeMetrics["exact_interval"]> => value !== null)
    .map((interval) => ({ start: interval.start_ms, end: interval.end_ms }));
  const concurrency = intervalConcurrency(intervals);
  const compute = computeOverride?.total ?? (walls.length === 0 ? null : walls.reduce((sum, value) => sum + value, 0));
  const span = sessionSpan(events);
  const allExact = events.length > 0 && concurrency.interval_request_count === events.length;
  const intervalBoundsSpan = allExact && intervals.length > 0
    ? Math.max(...intervals.map((interval) => interval.end)) - Math.min(...intervals.map((interval) => interval.start))
    : null;
  const idle = intervalBoundsSpan !== null && concurrency.active_wall_ms !== null
    ? intervalBoundsSpan - concurrency.active_wall_ms
    : null;

  return Object.freeze({
    request_count: events.length,
    compute_ms: compute,
    known_compute_request_count: computeOverride?.known ?? walls.length,
    unknown_compute_request_count: computeOverride?.unknown ?? (events.length - walls.length),
    session_span_ms: span,
    idle_ms: idle,
    wall_ms_p50: percentile(walls, 0.50),
    wall_ms_p95: percentile(walls, 0.95),
    wall_ms_p99: percentile(walls, 0.99),
    ttft_ms_p50: percentile(ttfts, 0.50),
    ttft_ms_p95: percentile(ttfts, 0.95),
    ttft_ms_p99: percentile(ttfts, 0.99),
    output_tps_p50: percentile(tps, 0.50),
    output_tps_p95: percentile(tps, 0.95),
    output_tps_p99: percentile(tps, 0.99),
    ...concurrency
  });
}

export function analyzeUsageTime(values: readonly UsageEvent[]): TimeAnalysis {
  const events = values.map((value) => validateUsageEvent(value));
  const requests = events.map(requestTimeMetrics);
  return Object.freeze({ requests: Object.freeze(requests), summary: summarize(events, requests) });
}

function bucketBounds(event: UsageEvent, kind: "hour" | "day"): { key: string; start: number; end: number } {
  const time = millis(event.timing.started_at) ?? millis(event.observed_at);
  if (time === null) throw new Error(`Event ${event.event_id} has no usable bucket timestamp`);
  const date = new Date(time);
  if (kind === "hour") {
    date.setUTCMinutes(0, 0, 0);
    const start = date.getTime();
    return { key: date.toISOString().slice(0, 13) + ":00Z", start, end: start + 60 * 60 * 1000 };
  }
  date.setUTCHours(0, 0, 0, 0);
  const start = date.getTime();
  return { key: date.toISOString().slice(0, 10), start, end: start + 24 * 60 * 60 * 1000 };
}

function bucketBoundsFromMillis(time: number, kind: "hour" | "day"): { key: string; start: number; end: number } {
  const date = new Date(time);
  if (kind === "hour") {
    date.setUTCMinutes(0, 0, 0);
    const start = date.getTime();
    return { key: date.toISOString().slice(0, 13) + ":00Z", start, end: start + 60 * 60 * 1000 };
  }
  date.setUTCHours(0, 0, 0, 0);
  const start = date.getTime();
  return { key: date.toISOString().slice(0, 10), start, end: start + 24 * 60 * 60 * 1000 };
}

function clip(interval: Interval, start: number, end: number): Interval | null {
  const clippedStart = Math.max(interval.start, start);
  const clippedEnd = Math.min(interval.end, end);
  return clippedEnd >= clippedStart ? { start: clippedStart, end: clippedEnd } : null;
}

function tokens(events: readonly UsageEvent[]): TimeRollupTokenTotals {
  const sum = (field: keyof UsageEvent["usage"]): number | string | null => {
    let total = 0n;
    for (const event of events) {
      const value = event.usage[field];
      if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
      total += BigInt(value);
    }
    return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : total.toString();
  };
  return Object.freeze({
    input_tokens: sum("input_tokens"),
    output_tokens: sum("output_tokens"),
    reasoning_tokens: sum("reasoning_tokens"),
    cache_read_tokens: sum("cache_read_tokens"),
    cache_write_tokens: sum("cache_write_tokens"),
    cached_input_tokens: sum("cached_input_tokens")
  });
}

function timeBucketRows(events: readonly UsageEvent[], kind: "hour" | "day"): TimeRollupRow[] {
  interface BucketGroup {
    start: number;
    end: number;
    events: UsageEvent[];
    intervals: Interval[];
  }
  const grouped = new Map<string, BucketGroup>();
  const ensure = (bounds: { key: string; start: number; end: number }): BucketGroup => {
    const existing = grouped.get(bounds.key);
    if (existing !== undefined) return existing;
    const created: BucketGroup = { start: bounds.start, end: bounds.end, events: [], intervals: [] };
    grouped.set(bounds.key, created);
    return created;
  };

  for (const event of events) {
    const attribution = bucketBounds(event, kind);
    ensure(attribution).events.push(event);
    const metric = requestTimeMetrics(event);
    if (metric.exact_interval === null) continue;
    const interval = { start: metric.exact_interval.start_ms, end: metric.exact_interval.end_ms };
    if (interval.end === interval.start) {
      ensure(bucketBoundsFromMillis(interval.start, kind)).intervals.push(interval);
      continue;
    }
    let cursor = bucketBoundsFromMillis(interval.start, kind);
    while (cursor.start < interval.end) {
      const clipped = clip(interval, cursor.start, cursor.end);
      if (clipped !== null && clipped.end > clipped.start) ensure(cursor).intervals.push(clipped);
      cursor = bucketBoundsFromMillis(cursor.end, kind);
    }
  }
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => {
    const requestMetrics = group.events.map(requestTimeMetrics);
    const intervalCompute = group.intervals.reduce((sum, interval) => sum + interval.end - interval.start, 0);
    const nonIntervalKnown = requestMetrics.filter((metric) => metric.exact_interval === null && metric.wall_ms !== null);
    const nonIntervalCompute = nonIntervalKnown.reduce((sum, metric) => sum + (metric.wall_ms ?? 0), 0);
    const unknownStarted = requestMetrics.filter((metric) => metric.exact_interval === null && metric.wall_ms === null).length;
    const known = group.intervals.length + nonIntervalKnown.length;
    const total = known === 0 ? null : intervalCompute + nonIntervalCompute;
    return Object.freeze({
      bucket_kind: kind,
      bucket_key: key,
      bucket_start: new Date(group.start).toISOString(),
      bucket_end: new Date(group.end).toISOString(),
      summary: summarize(group.events, requestMetrics, group.intervals, { total, known, unknown: unknownStarted }),
      tokens: tokens(group.events)
    });
  });
}

function sessionRows(events: readonly UsageEvent[]): TimeRollupRow[] {
  const grouped = new Map<string, UsageEvent[]>();
  for (const event of events) {
    const key = event.session_id ?? "__null__";
    const group = grouped.get(key) ?? [];
    group.push(event);
    grouped.set(key, group);
  }
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => {
    const metrics = group.map(requestTimeMetrics);
    return Object.freeze({
      bucket_kind: "session",
      bucket_key: key === "__null__" ? null : key,
      bucket_start: null,
      bucket_end: null,
      summary: summarize(group, metrics),
      tokens: tokens(group)
    });
  });
}

export function rollupUsageTime(values: readonly UsageEvent[], options: TimeRollupOptions): readonly TimeRollupRow[] {
  const events = values.map((value) => validateUsageEvent(value));
  if (options.bucket === "session") return Object.freeze(sessionRows(events));
  if (options.bucket === "hour" || options.bucket === "day") return Object.freeze(timeBucketRows(events, options.bucket));
  const exhaustive: never = options.bucket;
  throw new Error(`Unsupported time bucket: ${String(exhaustive)}`);
}
