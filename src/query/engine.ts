import type { DatabaseSync } from "node:sqlite";
import { validateUsageEvent } from "../protocol/validation.js";
import {
  USAGE_AGGREGATE_DEFAULT_GROUPS,
  USAGE_AGGREGATE_FIELDS,
  USAGE_AGGREGATE_MAX_DIMENSIONS,
  USAGE_AGGREGATE_MAX_GROUPS,
  USAGE_AGGREGATE_MAX_METRICS,
  USAGE_GROUP_DIMENSIONS,
  USAGE_QUERY_DEFAULT_LIMIT,
  USAGE_QUERY_MAX_LIMIT
} from "./types.js";
import type {
  UsageAggregateField,
  UsageAggregateMetric,
  UsageAggregateRequest,
  UsageAggregateResult,
  UsageAggregateRow,
  UsageAggregateValue,
  UsageGroupDimension,
  UsageQueryFilter,
  UsageQueryOrder,
  UsageQueryRequest,
  UsageQueryResult
} from "./types.js";

export class TokenQueryError extends Error {
  readonly code: "QUERY_INVALID" | "CURSOR_INVALID" | "QUERY_CORRUPT";

  constructor(code: TokenQueryError["code"], message: string) {
    super(message);
    this.name = "TokenQueryError";
    this.code = code;
  }
}

type SqlValue = string | number | null;
type SqlRecord = Record<string, unknown>;

const FILTER_COLUMNS: Readonly<Record<string, string>> = Object.freeze({
  request_id: "request_id",
  session_id: "session_id",
  task_id: "task_id",
  run_id: "run_id",
  runtime: "runtime",
  billing_platform: "billing_platform",
  inference_provider: "inference_provider",
  requested_model: "requested_model",
  resolved_model: "resolved_model",
  service_tier: "service_tier",
  workspace_id: "workspace_id",
  project_id: "project_id",
  agent_id: "agent_id",
  bot_id: "bot_id",
  worker_id: "worker_id",
  system_id: "system_id",
  skill_id: "skill_id",
  automation_id: "automation_id",
  tool_id: "tool_id"
});

const INTEGER_AGGREGATE_FIELDS = new Set<UsageAggregateField>([
  "context_input_tokens",
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cached_input_tokens",
  "audio_input_tokens",
  "audio_output_tokens",
  "total_tokens_reported"
]);

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TokenQueryError("QUERY_INVALID", `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TokenQueryError("QUERY_INVALID", `${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function keysOnly(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!set.has(key)) throw new TokenQueryError("QUERY_INVALID", `${label}.${key} is not supported`);
  }
}

function safeText(value: unknown, label: string, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 500 || value.includes("\u0000")) {
    throw new TokenQueryError("QUERY_INVALID", `${label} must be a bounded non-empty string${nullable ? " or null" : ""}`);
  }
  return value;
}

function dateTime(value: unknown, label: string): string {
  const text = safeText(value, label, false);
  if (text === null || !/(?:Z|[+-]\d{2}:\d{2})$/.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new TokenQueryError("QUERY_INVALID", `${label} must be a timezone-aware ISO 8601 date-time`);
  }
  return text;
}

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new TokenQueryError("QUERY_INVALID", `${label} must be an integer in ${min}..${max}`);
  }
  return value as number;
}

function normalizeFilter(value: unknown): UsageQueryFilter {
  if (value === undefined) return {};
  const obj = plainObject(value, "filter");
  keysOnly(obj, ["observed_from", "observed_to", ...Object.keys(FILTER_COLUMNS)], "filter");
  const result: Record<string, string | null> = {};
  if (Object.prototype.hasOwnProperty.call(obj, "observed_from")) result.observed_from = dateTime(obj.observed_from, "filter.observed_from");
  if (Object.prototype.hasOwnProperty.call(obj, "observed_to")) result.observed_to = dateTime(obj.observed_to, "filter.observed_to");
  for (const key of Object.keys(FILTER_COLUMNS)) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) result[key] = safeText(obj[key], `filter.${key}`, true);
  }
  const observedFrom = result.observed_from;
  const observedTo = result.observed_to;
  if (typeof observedFrom === "string" && typeof observedTo === "string") {
    if (Date.parse(observedFrom) >= Date.parse(observedTo)) {
      throw new TokenQueryError("QUERY_INVALID", "filter observed_from must be earlier than observed_to");
    }
  }
  return result as UsageQueryFilter;
}

function buildWhere(filter: UsageQueryFilter, params: SqlValue[]): string[] {
  const where: string[] = [
    "NOT EXISTS (SELECT 1 FROM event_supersessions es WHERE es.event_id = usage_events.event_id)"
  ];
  if (filter.observed_from !== undefined) {
    where.push("observed_at >= ?");
    params.push(filter.observed_from);
  }
  if (filter.observed_to !== undefined) {
    where.push("observed_at < ?");
    params.push(filter.observed_to);
  }
  for (const [key, column] of Object.entries(FILTER_COLUMNS)) {
    if (!Object.prototype.hasOwnProperty.call(filter, key)) continue;
    const value = (filter as Record<string, string | null | undefined>)[key];
    if (value === null) where.push(`${column} IS NULL`);
    else if (value !== undefined) {
      where.push(`${column} = ?`);
      params.push(value);
    }
  }
  return where;
}

interface DecodedCursor {
  readonly observedAt: string;
  readonly eventId: string;
}

function encodeCursor(observedAt: string, eventId: string): string {
  return `v1|${encodeURIComponent(observedAt)}|${encodeURIComponent(eventId)}`;
}

function decodeCursor(value: unknown): DecodedCursor | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 2000 || value.includes("\u0000")) {
    throw new TokenQueryError("CURSOR_INVALID", "cursor must be a bounded string");
  }
  const parts = value.split("|");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new TokenQueryError("CURSOR_INVALID", "cursor format is unsupported");
  }
  let observedAt: string;
  let eventId: string;
  try {
    observedAt = decodeURIComponent(parts[1] ?? "");
    eventId = decodeURIComponent(parts[2] ?? "");
  } catch {
    throw new TokenQueryError("CURSOR_INVALID", "cursor encoding is invalid");
  }
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(observedAt) || !Number.isFinite(Date.parse(observedAt))) {
    throw new TokenQueryError("CURSOR_INVALID", "cursor observed_at is invalid");
  }
  if (eventId.length < 1 || eventId.length > 500 || eventId.includes("\u0000")) {
    throw new TokenQueryError("CURSOR_INVALID", "cursor event_id is invalid");
  }
  return { observedAt, eventId };
}

function normalizeQueryRequest(value: unknown): {
  filter: UsageQueryFilter;
  order: UsageQueryOrder;
  limit: number;
  cursor: DecodedCursor | null;
} {
  const obj = plainObject(value, "query");
  keysOnly(obj, ["filter", "order", "limit", "cursor"], "query");
  const filter = normalizeFilter(obj.filter);
  const order = obj.order === undefined ? "desc" : obj.order;
  if (order !== "asc" && order !== "desc") throw new TokenQueryError("QUERY_INVALID", "query.order must be asc or desc");
  const limit = obj.limit === undefined ? USAGE_QUERY_DEFAULT_LIMIT : boundedInteger(obj.limit, "query.limit", 1, USAGE_QUERY_MAX_LIMIT);
  return { filter, order, limit, cursor: decodeCursor(obj.cursor) };
}

function asRecord(value: unknown, label: string): SqlRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TokenQueryError("QUERY_CORRUPT", `${label} returned an invalid row`);
  }
  return value as SqlRecord;
}

export function executeUsageQuery(db: DatabaseSync, request: UsageQueryRequest): UsageQueryResult {
  const normalized = normalizeQueryRequest(request);
  const params: SqlValue[] = [];
  const where = buildWhere(normalized.filter, params);
  if (normalized.cursor !== null) {
    const operator = normalized.order === "desc" ? "<" : ">";
    where.push(`(observed_at ${operator} ? OR (observed_at = ? AND event_id ${operator} ?))`);
    params.push(normalized.cursor.observedAt, normalized.cursor.observedAt, normalized.cursor.eventId);
  }
  const direction = normalized.order === "desc" ? "DESC" : "ASC";
  const sql = `SELECT event_id, observed_at, event_json FROM usage_events${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY observed_at ${direction}, event_id ${direction} LIMIT ?`;
  params.push(normalized.limit + 1);
  const rows = db.prepare(sql).all(...params);
  const hasMore = rows.length > normalized.limit;
  const page = hasMore ? rows.slice(0, normalized.limit) : rows;
  const events = page.map((row, index) => {
    const record = asRecord(row, `query row ${index}`);
    if (typeof record.event_json !== "string") throw new TokenQueryError("QUERY_CORRUPT", "stored event_json is not text");
    try {
      return validateUsageEvent(JSON.parse(record.event_json));
    } catch (error) {
      throw new TokenQueryError("QUERY_CORRUPT", `stored event ${String(record.event_id)} no longer validates: ${String(error)}`);
    }
  });
  const last = page[page.length - 1];
  let nextCursor: string | null = null;
  if (hasMore && last !== undefined) {
    const record = asRecord(last, "query cursor row");
    if (typeof record.observed_at !== "string" || typeof record.event_id !== "string") {
      throw new TokenQueryError("QUERY_CORRUPT", "query cursor row is invalid");
    }
    nextCursor = encodeCursor(record.observed_at, record.event_id);
  }
  return { events, hasMore, nextCursor };
}

function metricKey(metric: UsageAggregateMetric): string {
  return metric.operator === "count" ? "count" : `${metric.operator}_${String(metric.field)}`;
}

function normalizeAggregateRequest(value: unknown): {
  filter: UsageQueryFilter;
  groupBy: UsageGroupDimension[];
  metrics: UsageAggregateMetric[];
  limit: number;
} {
  const obj = plainObject(value, "aggregate");
  keysOnly(obj, ["filter", "groupBy", "metrics", "limit"], "aggregate");
  const filter = normalizeFilter(obj.filter);

  const rawGroupBy = obj.groupBy === undefined ? [] : obj.groupBy;
  if (!Array.isArray(rawGroupBy) || rawGroupBy.length > USAGE_AGGREGATE_MAX_DIMENSIONS) {
    throw new TokenQueryError("QUERY_INVALID", `aggregate.groupBy must contain at most ${USAGE_AGGREGATE_MAX_DIMENSIONS} dimensions`);
  }
  const allowedDimensions = new Set<string>(USAGE_GROUP_DIMENSIONS);
  const groupBy: UsageGroupDimension[] = [];
  const seenDimensions = new Set<string>();
  for (const value of rawGroupBy) {
    if (typeof value !== "string" || !allowedDimensions.has(value)) {
      throw new TokenQueryError("QUERY_INVALID", `unsupported aggregate dimension: ${String(value)}`);
    }
    if (seenDimensions.has(value)) throw new TokenQueryError("QUERY_INVALID", `duplicate aggregate dimension: ${value}`);
    seenDimensions.add(value);
    groupBy.push(value as UsageGroupDimension);
  }

  if (!Array.isArray(obj.metrics) || obj.metrics.length < 1 || obj.metrics.length > USAGE_AGGREGATE_MAX_METRICS) {
    throw new TokenQueryError("QUERY_INVALID", `aggregate.metrics must contain 1..${USAGE_AGGREGATE_MAX_METRICS} metrics`);
  }
  const allowedFields = new Set<string>(USAGE_AGGREGATE_FIELDS);
  const metrics: UsageAggregateMetric[] = [];
  const seenMetrics = new Set<string>();
  for (let i = 0; i < obj.metrics.length; i += 1) {
    const metricObj = plainObject(obj.metrics[i], `aggregate.metrics[${i}]`);
    keysOnly(metricObj, ["operator", "field"], `aggregate.metrics[${i}]`);
    const operator = metricObj.operator;
    if (operator !== "count" && operator !== "sum" && operator !== "avg" && operator !== "min" && operator !== "max") {
      throw new TokenQueryError("QUERY_INVALID", `aggregate.metrics[${i}].operator is unsupported`);
    }
    let metric: UsageAggregateMetric;
    if (operator === "count") {
      if (metricObj.field !== undefined) throw new TokenQueryError("QUERY_INVALID", "count metric must not specify field");
      metric = { operator: "count" };
    } else {
      if (typeof metricObj.field !== "string" || !allowedFields.has(metricObj.field)) {
        throw new TokenQueryError("QUERY_INVALID", `aggregate.metrics[${i}].field is unsupported`);
      }
      metric = { operator, field: metricObj.field as UsageAggregateField };
    }
    const key = metricKey(metric);
    if (seenMetrics.has(key)) throw new TokenQueryError("QUERY_INVALID", `duplicate aggregate metric: ${key}`);
    seenMetrics.add(key);
    metrics.push(metric);
  }

  const limit = obj.limit === undefined
    ? USAGE_AGGREGATE_DEFAULT_GROUPS
    : boundedInteger(obj.limit, "aggregate.limit", 1, USAGE_AGGREGATE_MAX_GROUPS);
  return { filter, groupBy, metrics, limit };
}

function aggregateExpression(metric: UsageAggregateMetric, index: number): string {
  const alias = `m${index}`;
  if (metric.operator === "count") return `CAST(COUNT(*) AS TEXT) AS ${alias}`;
  const field = metric.field;
  if (field === undefined) throw new TokenQueryError("QUERY_INVALID", "aggregate metric field is missing");
  let expression: string;
  if (metric.operator === "sum" && INTEGER_AGGREGATE_FIELDS.has(field)) {
    expression = `ai_verse_exact_int_sum(${field})`;
  } else if (INTEGER_AGGREGATE_FIELDS.has(field) && metric.operator !== "avg") {
    expression = `CAST(${metric.operator.toUpperCase()}(${field}) AS TEXT)`;
  } else {
    expression = `${metric.operator.toUpperCase()}(${field})`;
  }
  // Missing usage is unknown, not zero. Never present an aggregate over only the known subset
  // as if it were the exact aggregate for the whole group.
  return `CASE WHEN COUNT(${field}) = COUNT(*) THEN ${expression} ELSE NULL END AS ${alias}`;
}

function normalizeAggregateValue(value: unknown): UsageAggregateValue {
  if (value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TokenQueryError("QUERY_CORRUPT", "aggregate produced a non-finite number");
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const bigint = BigInt(value);
    if (bigint <= BigInt(Number.MAX_SAFE_INTEGER) && bigint >= BigInt(Number.MIN_SAFE_INTEGER)) return Number(bigint);
    return value;
  }
  throw new TokenQueryError("QUERY_CORRUPT", "aggregate produced an unexpected value");
}

export function executeUsageAggregate(db: DatabaseSync, request: UsageAggregateRequest): UsageAggregateResult {
  const normalized = normalizeAggregateRequest(request);
  const params: SqlValue[] = [];
  const where = buildWhere(normalized.filter, params);
  const dimensions = normalized.groupBy.map((dimension, index) => `${dimension} AS d${index}`);
  const metrics = normalized.metrics.map(aggregateExpression);
  const select = [...dimensions, ...metrics].join(", ");
  const groupSql = normalized.groupBy.length > 0 ? ` GROUP BY ${normalized.groupBy.join(", ")}` : "";
  const orderSql = normalized.groupBy.length > 0
    ? ` ORDER BY ${normalized.groupBy.map((dimension) => `${dimension} ASC`).join(", ")}`
    : "";
  const sql = `SELECT ${select} FROM usage_events${where.length ? ` WHERE ${where.join(" AND ")}` : ""}${groupSql}${orderSql} LIMIT ?`;
  params.push(normalized.limit + 1);
  const rawRows = db.prepare(sql).all(...params);
  const truncated = rawRows.length > normalized.limit;
  const page = truncated ? rawRows.slice(0, normalized.limit) : rawRows;
  const rows: UsageAggregateRow[] = page.map((row, rowIndex) => {
    const record = asRecord(row, `aggregate row ${rowIndex}`);
    const dimensionValues: Record<string, string | null> = {};
    normalized.groupBy.forEach((dimension, index) => {
      const value = record[`d${index}`];
      if (value !== null && typeof value !== "string") throw new TokenQueryError("QUERY_CORRUPT", `aggregate dimension ${dimension} is invalid`);
      dimensionValues[dimension] = value as string | null;
    });
    const metricValues: Record<string, UsageAggregateValue> = {};
    normalized.metrics.forEach((metric, index) => {
      metricValues[metricKey(metric)] = normalizeAggregateValue(record[`m${index}`]);
    });
    return { dimensions: dimensionValues, metrics: metricValues };
  });
  return { rows, truncated };
}
