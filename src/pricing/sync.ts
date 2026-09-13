import { clearInterval, setInterval, type Timeout } from "node:timers";
import type { PriceSnapshot } from "./types.js";
import { validatePriceSnapshot } from "./validation.js";
import type {
  PriceFreshnessEvidence,
  PricingSourceDefinition
} from "./sources.js";
import { PricingSourceRegistry } from "./sources.js";
import {
  PriceSnapshotStore,
  type PricingSyncState
} from "./store.js";

const DEFAULT_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export type PricingRefreshReason = "startup" | "periodic" | "unknown_model" | "manual";

export interface PricingFetchRequest {
  readonly source_id: string;
  readonly reason: PricingRefreshReason;
  readonly now: string;
  readonly previous_etag?: string;
  readonly previous_content_digest_sha256?: string;
  readonly billing_platform?: string;
  readonly resolved_model?: string;
}

export interface PricingFetchUpdatedResult {
  readonly status: "updated";
  readonly checked_at: string;
  readonly snapshots: readonly unknown[];
  readonly etag?: string;
  readonly content_digest_sha256?: string;
}

export interface PricingFetchNotModifiedResult {
  readonly status: "not_modified";
  readonly checked_at: string;
  readonly etag?: string;
  readonly content_digest_sha256?: string;
}

export type PricingFetchResult = PricingFetchUpdatedResult | PricingFetchNotModifiedResult;

export interface PricingFetcher {
  readonly source_id: string;
  fetch(request: PricingFetchRequest): Promise<PricingFetchResult>;
}

export interface PricingSyncReport {
  readonly source_id: string;
  readonly reason: PricingRefreshReason;
  readonly outcome: "updated" | "not_modified" | "failed";
  readonly checked_at?: string;
  readonly inserted: number;
  readonly duplicates: number;
  readonly error_code?: "FETCH_FAILED" | "SYNC_INVALID";
}

export interface PricingPeriodicScheduler {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

const DEFAULT_SCHEDULER: PricingPeriodicScheduler = {
  setInterval(callback, delayMs) {
    const timeout = setInterval(callback, delayMs);
    timeout.unref();
    return timeout;
  },
  clearInterval(handle) {
    clearInterval(handle as Timeout);
  }
};

export class PricingSynchronizerError extends Error {
  readonly code:
    | "PRICING_FETCHER_INVALID"
    | "PRICING_SYNC_INVALID";

  constructor(code: PricingSynchronizerError["code"], message: string) {
    super(message);
    this.name = "PricingSynchronizerError";
    this.code = code;
  }
}

function fail(code: PricingSynchronizerError["code"], message: string): never {
  throw new PricingSynchronizerError(code, message);
}

function validDateTime(value: unknown, path: string): string {
  if (typeof value !== "string" || !ISO_DATETIME_RE.test(value) || Number.isNaN(Date.parse(value))) {
    fail("PRICING_SYNC_INVALID", `${path}: invalid ISO 8601 date-time`);
  }
  return value;
}

function validOptionalEtag(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 1000 || value.includes("\u0000")) {
    fail("PRICING_SYNC_INVALID", `${path}: invalid ETag`);
  }
  return value;
}

function validOptionalDigest(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    fail("PRICING_SYNC_INVALID", `${path}: invalid SHA-256 digest`);
  }
  return value;
}

function sameUtcDay(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

function supportsPlatform(source: PricingSourceDefinition, platform: string): boolean {
  return source.billing_platforms === "*" || source.billing_platforms.includes(platform);
}

function sourceNeedsRefresh(
  source: PricingSourceDefinition,
  state: PricingSyncState | undefined,
  nowMs: number
): boolean {
  if (state?.last_checked_at === undefined) return true;
  const checkedMs = Date.parse(state.last_checked_at);
  if (!Number.isFinite(checkedMs)) return true;
  const maxFutureSkew = source.freshness.max_future_skew_seconds ?? 300;
  if (checkedMs > nowMs + maxFutureSkew * 1000) return true;
  const ageSeconds = Math.max(0, Math.floor((nowMs - checkedMs) / 1000));
  if (ageSeconds > source.freshness.max_age_seconds) return true;
  return source.freshness.require_same_utc_day && !sameUtcDay(checkedMs, nowMs);
}

function normalizeSnapshotForFetch(
  value: unknown,
  source: PricingSourceDefinition,
  checkedAt: string,
  etag: string | undefined,
  digest: string | undefined
): PriceSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("PRICING_SYNC_INVALID", "fetch snapshot must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.source !== "object" || candidate.source === null || Array.isArray(candidate.source)) {
    fail("PRICING_SYNC_INVALID", "fetch snapshot.source must be an object");
  }
  const rawSource = candidate.source as Record<string, unknown>;
  const rawVerification = typeof candidate.verification === "object"
    && candidate.verification !== null
    && !Array.isArray(candidate.verification)
    ? candidate.verification as Record<string, unknown>
    : undefined;
  const verificationStatus = rawVerification?.status;
  const normalized = {
    ...candidate,
    source: {
      ...rawSource,
      source_id: source.source_id,
      authority: source.authority,
      retrieved_at: checkedAt,
      ...(etag === undefined ? {} : { etag }),
      ...(digest === undefined ? {} : { content_digest_sha256: digest })
    },
    ...(rawVerification === undefined
      ? {}
      : {
          verification: {
            ...rawVerification,
            ...((verificationStatus === "verified" || verificationStatus === "cross_checked")
              ? { verified_at: checkedAt }
              : {})
          }
        })
  };
  const snapshot = validatePriceSnapshot(normalized);
  if (!supportsPlatform(source, snapshot.identity.billing_platform)) {
    fail(
      "PRICING_SYNC_INVALID",
      `source '${source.source_id}' does not support billing platform '${snapshot.identity.billing_platform}'`
    );
  }
  return snapshot;
}

function commonToken(
  snapshots: readonly PriceSnapshot[],
  field: "etag" | "content_digest_sha256"
): string | undefined {
  const values = snapshots
    .map((snapshot) => snapshot.source[field])
    .filter((value): value is string => value !== undefined);
  if (values.length === 0) return undefined;
  return values.every((value) => value === values[0]) ? values[0] : undefined;
}

function previousSuccessFields(state: PricingSyncState | undefined): Partial<PricingSyncState> {
  if (state === undefined) return {};
  return {
    ...(state.last_success_at === undefined ? {} : { last_success_at: state.last_success_at }),
    ...(state.last_checked_at === undefined ? {} : { last_checked_at: state.last_checked_at }),
    ...(state.etag === undefined ? {} : { etag: state.etag }),
    ...(state.content_digest_sha256 === undefined ? {} : { content_digest_sha256: state.content_digest_sha256 }),
    ...(state.snapshot_count === undefined ? {} : { snapshot_count: state.snapshot_count })
  };
}

export class PricingSynchronizer {
  readonly registry: PricingSourceRegistry;
  readonly store: PriceSnapshotStore;
  readonly #fetchers: ReadonlyMap<string, PricingFetcher>;
  readonly #scheduler: PricingPeriodicScheduler;
  #periodicHandle: unknown | undefined;
  #periodicRunning = false;

  constructor(options: {
    readonly registry: PricingSourceRegistry;
    readonly store: PriceSnapshotStore;
    readonly fetchers: readonly PricingFetcher[];
    readonly scheduler?: PricingPeriodicScheduler;
  }) {
    this.registry = options.registry;
    this.store = options.store;
    this.#scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
    const fetchers = new Map<string, PricingFetcher>();
    for (const fetcher of options.fetchers) {
      if (fetchers.has(fetcher.source_id)) {
        fail("PRICING_FETCHER_INVALID", `duplicate fetcher '${fetcher.source_id}'`);
      }
      if (this.registry.source(fetcher.source_id) === undefined) {
        fail("PRICING_FETCHER_INVALID", `fetcher '${fetcher.source_id}' is not a registered pricing source`);
      }
      if (typeof fetcher.fetch !== "function") {
        fail("PRICING_FETCHER_INVALID", `fetcher '${fetcher.source_id}' has no fetch function`);
      }
      fetchers.set(fetcher.source_id, fetcher);
    }
    this.#fetchers = fetchers;
  }

  needsRefresh(sourceId: string, now: string | Date = new Date()): boolean {
    const source = this.registry.source(sourceId);
    if (source === undefined) fail("PRICING_FETCHER_INVALID", `unknown source '${sourceId}'`);
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
    if (!Number.isFinite(nowMs)) fail("PRICING_SYNC_INVALID", "now: invalid date-time");
    return sourceNeedsRefresh(source, this.store.syncState(sourceId), nowMs);
  }

  freshnessEvidence(sourceId: string): PriceFreshnessEvidence | undefined {
    const state = this.store.syncState(sourceId);
    if (state?.last_checked_at === undefined) return undefined;
    if (state.etag === undefined && state.content_digest_sha256 === undefined) return undefined;
    return Object.freeze({
      checked_at: state.last_checked_at,
      ...(state.etag === undefined ? {} : { etag: state.etag }),
      ...(state.content_digest_sha256 === undefined ? {} : { content_digest_sha256: state.content_digest_sha256 })
    });
  }

  async refreshSource(options: {
    readonly source_id: string;
    readonly reason: PricingRefreshReason;
    readonly now?: string | Date;
    readonly billing_platform?: string;
    readonly resolved_model?: string;
  }): Promise<PricingSyncReport> {
    const fetcher = this.#fetchers.get(options.source_id);
    const source = this.registry.source(options.source_id);
    if (fetcher === undefined || source === undefined) {
      fail("PRICING_FETCHER_INVALID", `no trusted fetcher for '${options.source_id}'`);
    }
    const nowMs = options.now instanceof Date
      ? options.now.getTime()
      : options.now === undefined
        ? Date.now()
        : Date.parse(options.now);
    if (!Number.isFinite(nowMs)) fail("PRICING_SYNC_INVALID", "now: invalid date-time");
    const nowIso = new Date(nowMs).toISOString();
    const previous = this.store.syncState(options.source_id);

    const request: PricingFetchRequest = Object.freeze({
      source_id: options.source_id,
      reason: options.reason,
      now: nowIso,
      ...(previous?.etag === undefined ? {} : { previous_etag: previous.etag }),
      ...(previous?.content_digest_sha256 === undefined ? {} : { previous_content_digest_sha256: previous.content_digest_sha256 }),
      ...(options.billing_platform === undefined ? {} : { billing_platform: options.billing_platform }),
      ...(options.resolved_model === undefined ? {} : { resolved_model: options.resolved_model })
    });

    let result: PricingFetchResult;
    try {
      result = await fetcher.fetch(request);
    } catch {
      this.store.writeSyncState({
        schema_version: "ai-verse-token-price-sync-state/0.1",
        source_id: options.source_id,
        last_attempt_at: nowIso,
        last_status: "failed",
        ...previousSuccessFields(previous),
        last_error_code: "FETCH_FAILED"
      });
      return Object.freeze({
        source_id: options.source_id,
        reason: options.reason,
        outcome: "failed",
        inserted: 0,
        duplicates: 0,
        error_code: "FETCH_FAILED"
      });
    }

    try {
      if (typeof result !== "object" || result === null) fail("PRICING_SYNC_INVALID", "fetch result must be an object");
      if (result.status !== "updated" && result.status !== "not_modified") {
        fail("PRICING_SYNC_INVALID", "fetch result status must be updated or not_modified");
      }
      const checkedAt = validDateTime(result.checked_at, "result.checked_at");
      const checkedMs = Date.parse(checkedAt);
      const maxFutureSkew = source.freshness.max_future_skew_seconds ?? 300;
      if (checkedMs > nowMs + maxFutureSkew * 1000) {
        fail("PRICING_SYNC_INVALID", "result.checked_at exceeds allowed future clock skew");
      }
      const resultEtag = validOptionalEtag(result.etag, "result.etag");
      const resultDigest = validOptionalDigest(result.content_digest_sha256, "result.content_digest_sha256");

      if (result.status === "not_modified") {
        if (previous?.last_checked_at === undefined) {
          fail("PRICING_SYNC_INVALID", "not_modified requires previous successful source state");
        }
        if (resultEtag !== undefined && previous.etag !== undefined && resultEtag !== previous.etag) {
          fail("PRICING_SYNC_INVALID", "not_modified ETag conflicts with previous state");
        }
        if (
          resultDigest !== undefined
          && previous.content_digest_sha256 !== undefined
          && resultDigest !== previous.content_digest_sha256
        ) {
          fail("PRICING_SYNC_INVALID", "not_modified content digest conflicts with previous state");
        }
        const etag = resultEtag ?? previous.etag;
        const digest = resultDigest ?? previous.content_digest_sha256;
        if (etag === undefined && digest === undefined) {
          fail("PRICING_SYNC_INVALID", "not_modified requires ETag or content digest evidence");
        }
        this.store.writeSyncState({
          schema_version: "ai-verse-token-price-sync-state/0.1",
          source_id: options.source_id,
          last_attempt_at: nowIso,
          last_status: "not_modified",
          last_success_at: checkedAt,
          last_checked_at: checkedAt,
          ...(etag === undefined ? {} : { etag }),
          ...(digest === undefined ? {} : { content_digest_sha256: digest }),
          snapshot_count: previous.snapshot_count ?? 0
        });
        return Object.freeze({
          source_id: options.source_id,
          reason: options.reason,
          outcome: "not_modified",
          checked_at: checkedAt,
          inserted: 0,
          duplicates: 0
        });
      }

      if (!Array.isArray(result.snapshots) || result.snapshots.length === 0) {
        fail("PRICING_SYNC_INVALID", "updated result must contain at least one snapshot");
      }
      const normalized = result.snapshots.map((snapshot) =>
        normalizeSnapshotForFetch(snapshot, source, checkedAt, resultEtag, resultDigest)
      );
      const etag = resultEtag ?? commonToken(normalized, "etag");
      const digest = resultDigest ?? commonToken(normalized, "content_digest_sha256");
      const stored = this.store.putMany(normalized);
      this.store.writeSyncState({
        schema_version: "ai-verse-token-price-sync-state/0.1",
        source_id: options.source_id,
        last_attempt_at: nowIso,
        last_status: "updated",
        last_success_at: checkedAt,
        last_checked_at: checkedAt,
        ...(etag === undefined ? {} : { etag }),
        ...(digest === undefined ? {} : { content_digest_sha256: digest }),
        snapshot_count: normalized.length
      });
      return Object.freeze({
        source_id: options.source_id,
        reason: options.reason,
        outcome: "updated",
        checked_at: checkedAt,
        inserted: stored.inserted,
        duplicates: stored.duplicates
      });
    } catch {
      this.store.writeSyncState({
        schema_version: "ai-verse-token-price-sync-state/0.1",
        source_id: options.source_id,
        last_attempt_at: nowIso,
        last_status: "failed",
        ...previousSuccessFields(previous),
        last_error_code: "SYNC_INVALID"
      });
      return Object.freeze({
        source_id: options.source_id,
        reason: options.reason,
        outcome: "failed",
        inserted: 0,
        duplicates: 0,
        error_code: "SYNC_INVALID"
      });
    }
  }

  async refreshStale(options: {
    readonly reason: "startup" | "periodic" | "manual";
    readonly now?: string | Date;
  }): Promise<readonly PricingSyncReport[]> {
    const now = options.now ?? new Date();
    const reports: PricingSyncReport[] = [];
    for (const source of this.registry.list()) {
      if (!this.#fetchers.has(source.source_id)) continue;
      if (options.reason !== "manual" && !this.needsRefresh(source.source_id, now)) continue;
      reports.push(await this.refreshSource({ source_id: source.source_id, reason: options.reason, now }));
    }
    return Object.freeze(reports);
  }

  async refreshForUnknownModel(options: {
    readonly billing_platform: string;
    readonly resolved_model: string;
    readonly now?: string | Date;
  }): Promise<readonly PricingSyncReport[]> {
    const reports: PricingSyncReport[] = [];
    for (const source of this.registry.list()) {
      if (!this.#fetchers.has(source.source_id) || !supportsPlatform(source, options.billing_platform)) continue;
      reports.push(await this.refreshSource({
        source_id: source.source_id,
        reason: "unknown_model",
        ...(options.now === undefined ? {} : { now: options.now }),
        billing_platform: options.billing_platform,
        resolved_model: options.resolved_model
      }));
    }
    return Object.freeze(reports);
  }

  startPeriodic(options: {
    readonly interval_ms?: number;
    readonly now?: () => Date;
  } = {}): void {
    if (this.#periodicHandle !== undefined) {
      fail("PRICING_SYNC_INVALID", "periodic refresh is already active");
    }
    const interval = options.interval_ms ?? DEFAULT_REFRESH_INTERVAL_MS;
    if (!Number.isSafeInteger(interval) || interval < 1_000) {
      fail("PRICING_SYNC_INVALID", "interval_ms must be a safe integer of at least 1000ms");
    }
    const nowProvider = options.now ?? (() => new Date());
    this.#periodicHandle = this.#scheduler.setInterval(() => {
      if (this.#periodicRunning) return;
      this.#periodicRunning = true;
      void this.refreshStale({ reason: "periodic", now: nowProvider() })
        .finally(() => {
          this.#periodicRunning = false;
        });
    }, interval);
  }

  stopPeriodic(): void {
    if (this.#periodicHandle === undefined) return;
    this.#scheduler.clearInterval(this.#periodicHandle);
    this.#periodicHandle = undefined;
  }

  get periodicActive(): boolean {
    return this.#periodicHandle !== undefined;
  }
}
