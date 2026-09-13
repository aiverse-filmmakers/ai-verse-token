import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { PriceSnapshot } from "./types.js";
import { validatePriceSnapshot } from "./validation.js";

const SYNC_STATE_VERSION = "ai-verse-token-price-sync-state/0.1" as const;
const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_SNAPSHOT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SYNC_STATE_FILE_BYTES = 256 * 1024;
const MAX_STORE_ENTRIES = 100_000;
let STATE_WRITE_SEQUENCE = 0;

export type PricingSyncStatus = "updated" | "not_modified" | "failed";

export interface PricingSyncState {
  readonly schema_version: typeof SYNC_STATE_VERSION;
  readonly source_id: string;
  readonly last_attempt_at: string;
  readonly last_status: PricingSyncStatus;
  readonly last_success_at?: string;
  readonly last_checked_at?: string;
  readonly etag?: string;
  readonly content_digest_sha256?: string;
  readonly snapshot_count?: number;
  readonly last_error_code?: "FETCH_FAILED" | "SYNC_INVALID";
}

export interface PutSnapshotsResult {
  readonly inserted: number;
  readonly duplicates: number;
  readonly snapshots: readonly PriceSnapshot[];
}

export class PriceSnapshotStoreError extends Error {
  readonly code:
    | "PRICE_SNAPSHOT_CONFLICT"
    | "PRICE_STORE_CORRUPT"
    | "PRICE_SYNC_STATE_INVALID";

  constructor(
    code: PriceSnapshotStoreError["code"],
    message: string
  ) {
    super(message);
    this.name = "PriceSnapshotStoreError";
    this.code = code;
  }
}


function nodeExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && String((error as { readonly code?: unknown }).code ?? "") === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function assertSafeDirectory(path: string, code: "PRICE_STORE_CORRUPT" | "PRICE_SYNC_STATE_INVALID"): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new PriceSnapshotStoreError(code, `pricing store directory is unsafe: ${path}`);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalSnapshot(snapshot: PriceSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function isoDateTime(value: unknown, path: string): string {
  if (typeof value !== "string" || !ISO_DATETIME_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new PriceSnapshotStoreError("PRICE_SYNC_STATE_INVALID", `${path}: invalid date-time`);
  }
  return value;
}

function boundedString(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.includes("\u0000")) {
    throw new PriceSnapshotStoreError("PRICE_SYNC_STATE_INVALID", `${path}: invalid string`);
  }
  return value;
}

function optionalString(obj: Record<string, unknown>, key: string, max: number): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
  return boundedString(obj[key], `$.${key}`, max);
}

function validateSyncState(value: unknown): PricingSyncState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PriceSnapshotStoreError("PRICE_SYNC_STATE_INVALID", "sync state must be an object");
  }
  const obj = value as Record<string, unknown>;
  const allowed = new Set([
    "schema_version",
    "source_id",
    "last_attempt_at",
    "last_status",
    "last_success_at",
    "last_checked_at",
    "etag",
    "content_digest_sha256",
    "snapshot_count",
    "last_error_code"
  ]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new PriceSnapshotStoreError("PRICE_SYNC_STATE_INVALID", `$.${key}: unknown field`);
    }
  }
  if (obj.schema_version !== SYNC_STATE_VERSION) {
    throw new PriceSnapshotStoreError("PRICE_SYNC_STATE_INVALID", "$.schema_version: unsupported");
  }
  const sourceId = boundedString(obj.source_id, "$.source_id", 200);
  const attempt = isoDateTime(obj.last_attempt_at, "$.last_attempt_at");
  if (obj.last_status !== "updated" && obj.last_status !== "not_modified" && obj.last_status !== "failed") {
    throw new PriceSnapshotStoreError("PRICE_SYNC_STATE_INVALID", "$.last_status: invalid status");
  }
  const success = Object.prototype.hasOwnProperty.call(obj, "last_success_at")
    ? isoDateTime(obj.last_success_at, "$.last_success_at")
    : undefined;
  const checked = Object.prototype.hasOwnProperty.call(obj, "last_checked_at")
    ? isoDateTime(obj.last_checked_at, "$.last_checked_at")
    : undefined;
  const etag = optionalString(obj, "etag", 1000);
  const digest = optionalString(obj, "content_digest_sha256", 64);
  if (digest !== undefined && !SHA256_RE.test(digest)) {
    throw new PriceSnapshotStoreError("PRICE_SYNC_STATE_INVALID", "$.content_digest_sha256: invalid SHA-256");
  }
  let snapshotCount: number | undefined;
  if (Object.prototype.hasOwnProperty.call(obj, "snapshot_count")) {
    if (!Number.isSafeInteger(obj.snapshot_count) || (obj.snapshot_count as number) < 0) {
      throw new PriceSnapshotStoreError("PRICE_SYNC_STATE_INVALID", "$.snapshot_count: invalid count");
    }
    snapshotCount = obj.snapshot_count as number;
  }
  let lastErrorCode: PricingSyncState["last_error_code"];
  if (Object.prototype.hasOwnProperty.call(obj, "last_error_code")) {
    if (obj.last_error_code !== "FETCH_FAILED" && obj.last_error_code !== "SYNC_INVALID") {
      throw new PriceSnapshotStoreError("PRICE_SYNC_STATE_INVALID", "$.last_error_code: invalid code");
    }
    lastErrorCode = obj.last_error_code;
  }

  const out: PricingSyncState = {
    schema_version: SYNC_STATE_VERSION,
    source_id: sourceId,
    last_attempt_at: attempt,
    last_status: obj.last_status,
    ...(success === undefined ? {} : { last_success_at: success }),
    ...(checked === undefined ? {} : { last_checked_at: checked }),
    ...(etag === undefined ? {} : { etag }),
    ...(digest === undefined ? {} : { content_digest_sha256: digest }),
    ...(snapshotCount === undefined ? {} : { snapshot_count: snapshotCount }),
    ...(lastErrorCode === undefined ? {} : { last_error_code: lastErrorCode })
  };
  return Object.freeze(out);
}

function parseSnapshotFile(path: string): PriceSnapshot {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_SNAPSHOT_FILE_BYTES) {
      throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", `unsafe or oversized price snapshot file: ${path}`);
    }
    return validatePriceSnapshot(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (error instanceof PriceSnapshotStoreError) throw error;
    throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", `invalid price snapshot file: ${path}`);
  }
}

export class PriceSnapshotStore {
  readonly root: string;
  readonly #snapshotsDir: string;
  readonly #stateDir: string;

  constructor(root: string) {
    if (typeof root !== "string" || root.length === 0 || root.includes("\u0000")) {
      throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", "root must be a non-empty path without NUL");
    }
    this.root = resolve(root);
    this.#snapshotsDir = join(this.root, "snapshots");
    this.#stateDir = join(this.root, "sync-state");

    if (nodeExists(this.root)) {
      assertSafeDirectory(this.root, "PRICE_STORE_CORRUPT");
    } else {
      mkdirSync(this.root, { recursive: true });
      assertSafeDirectory(this.root, "PRICE_STORE_CORRUPT");
    }
    for (const directory of [this.#snapshotsDir, this.#stateDir]) {
      if (nodeExists(directory)) {
        assertSafeDirectory(directory, "PRICE_STORE_CORRUPT");
      } else {
        mkdirSync(directory);
        assertSafeDirectory(directory, "PRICE_STORE_CORRUPT");
      }
    }
  }

  put(snapshotValue: unknown): PutSnapshotsResult {
    return this.putMany([snapshotValue]);
  }

  putMany(snapshotValues: readonly unknown[]): PutSnapshotsResult {
    const snapshots = snapshotValues.map((value) => validatePriceSnapshot(value));
    const byId = new Map<string, PriceSnapshot>();
    for (const snapshot of snapshots) {
      const existingInBatch = byId.get(snapshot.price_snapshot_id);
      if (existingInBatch !== undefined && canonicalSnapshot(existingInBatch) !== canonicalSnapshot(snapshot)) {
        throw new PriceSnapshotStoreError(
          "PRICE_SNAPSHOT_CONFLICT",
          `price_snapshot_id '${snapshot.price_snapshot_id}' has conflicting data in one batch`
        );
      }
      byId.set(snapshot.price_snapshot_id, snapshot);
    }

    let duplicates = 0;
    const pending: Array<{ snapshot: PriceSnapshot; path: string; content: string }> = [];
    for (const snapshot of byId.values()) {
      const path = this.#snapshotPath(snapshot.price_snapshot_id);
      const content = canonicalSnapshot(snapshot);
      if (nodeExists(path)) {
        const existing = parseSnapshotFile(path);
        if (canonicalSnapshot(existing) !== content) {
          throw new PriceSnapshotStoreError(
            "PRICE_SNAPSHOT_CONFLICT",
            `price_snapshot_id '${snapshot.price_snapshot_id}' already exists with different data`
          );
        }
        duplicates += 1;
      } else {
        pending.push({ snapshot, path, content });
      }
    }

    let inserted = 0;
    for (const item of pending) {
      try {
        writeFileSync(item.path, item.content, { encoding: "utf8", flag: "wx" });
        inserted += 1;
      } catch (error) {
        if (nodeExists(item.path)) {
          const existing = parseSnapshotFile(item.path);
          if (canonicalSnapshot(existing) === item.content) {
            duplicates += 1;
            continue;
          }
          throw new PriceSnapshotStoreError(
            "PRICE_SNAPSHOT_CONFLICT",
            `price_snapshot_id '${item.snapshot.price_snapshot_id}' raced with conflicting data`
          );
        }
        throw error;
      }
    }

    return Object.freeze({
      inserted,
      duplicates,
      snapshots: Object.freeze([...byId.values()])
    });
  }

  get(priceSnapshotId: string): PriceSnapshot | undefined {
    const path = this.#snapshotPath(priceSnapshotId);
    return nodeExists(path) ? parseSnapshotFile(path) : undefined;
  }

  list(sourceId?: string): readonly PriceSnapshot[] {
    const snapshots: PriceSnapshot[] = [];
    const entries = readdirSync(this.#snapshotsDir).sort();
    if (entries.length > MAX_STORE_ENTRIES) throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", "pricing snapshot directory exceeds supported entry count");
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const snapshot = parseSnapshotFile(join(this.#snapshotsDir, name));
      if (sourceId === undefined || snapshot.source.source_id === sourceId) snapshots.push(snapshot);
    }
    snapshots.sort((a, b) => {
      const effective = Date.parse(a.effective.starts_at) - Date.parse(b.effective.starts_at);
      if (effective !== 0) return effective;
      const retrieved = Date.parse(a.source.retrieved_at) - Date.parse(b.source.retrieved_at);
      if (retrieved !== 0) return retrieved;
      return a.price_snapshot_id.localeCompare(b.price_snapshot_id);
    });
    return Object.freeze(snapshots);
  }

  writeSyncState(stateValue: PricingSyncState): PricingSyncState {
    const state = validateSyncState(stateValue);
    const sourceDirectory = join(this.#stateDir, sha256(state.source_id));
    if (nodeExists(sourceDirectory)) {
      assertSafeDirectory(sourceDirectory, "PRICE_SYNC_STATE_INVALID");
    } else {
      mkdirSync(sourceDirectory);
      assertSafeDirectory(sourceDirectory, "PRICE_SYNC_STATE_INVALID");
    }
    STATE_WRITE_SEQUENCE += 1;
    const writePrefix = `${Date.now().toString().padStart(13, "0")}-${STATE_WRITE_SEQUENCE.toString().padStart(8, "0")}`;
    const observationId = sha256(`${state.last_attempt_at}\n${randomUUID()}`);
    const path = join(sourceDirectory, `${writePrefix}-${observationId}.json`);
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return state;
  }

  syncState(sourceId: string): PricingSyncState | undefined {
    boundedString(sourceId, "$.source_id", 200);
    const directory = join(this.#stateDir, sha256(sourceId));
    if (!nodeExists(directory)) return undefined;
    const directoryInfo = lstatSync(directory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new PriceSnapshotStoreError("PRICE_SYNC_STATE_INVALID", `unsafe sync-state directory: ${directory}`);
    }
    let latest: PricingSyncState | undefined;
    let latestName = "";
    const entries = readdirSync(directory).sort();
    if (entries.length > MAX_STORE_ENTRIES) throw new PriceSnapshotStoreError("PRICE_SYNC_STATE_INVALID", "sync-state directory exceeds supported entry count");
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const path = join(directory, name);
      let state: PricingSyncState;
      try {
        const info = lstatSync(path);
        if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_SYNC_STATE_FILE_BYTES) {
          throw new PriceSnapshotStoreError("PRICE_SYNC_STATE_INVALID", `unsafe or oversized sync state file: ${path}`);
        }
        state = validateSyncState(JSON.parse(readFileSync(path, "utf8")));
      } catch (error) {
        if (error instanceof PriceSnapshotStoreError) throw error;
        throw new PriceSnapshotStoreError("PRICE_SYNC_STATE_INVALID", `invalid sync state file: ${path}`);
      }
      if (state.source_id !== sourceId) {
        throw new PriceSnapshotStoreError("PRICE_SYNC_STATE_INVALID", `${path}: source_id mismatch`);
      }
      if (
        latest === undefined
        || Date.parse(state.last_attempt_at) > Date.parse(latest.last_attempt_at)
        || (state.last_attempt_at === latest.last_attempt_at && name > latestName)
      ) {
        latest = state;
        latestName = name;
      }
    }
    return latest;
  }

  #snapshotPath(priceSnapshotId: string): string {
    if (typeof priceSnapshotId !== "string" || priceSnapshotId.length === 0 || priceSnapshotId.includes("\u0000")) {
      throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", "invalid price snapshot id");
    }
    return join(this.#snapshotsDir, `${sha256(priceSnapshotId)}.json`);
  }
}
