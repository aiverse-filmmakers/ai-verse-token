import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import type { PriceSnapshot } from "./types.js";
import { validatePriceSnapshot } from "./validation.js";

const SYNC_STATE_VERSION = "ai-verse-token-price-sync-state/0.1" as const;
const BATCH_MANIFEST_VERSION = "ai-verse-token-price-batch/0.1" as const;
const LOCK_OWNER_VERSION = "ai-verse-token-price-commit-lock/0.1" as const;
const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_SNAPSHOT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SYNC_STATE_FILE_BYTES = 256 * 1024;
const MAX_BATCH_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_LOCK_FILE_BYTES = 16 * 1024;
const MAX_STORE_ENTRIES = 100_000;
const COMMIT_LOCK_WAIT_MS = 10_000;
const COMMIT_LOCK_POLL_MS = 25;
const COMMIT_LOCK_RECLAIM_GRACE_MS = 250;
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

interface BatchManifestMember {
  readonly price_snapshot_id: string;
  readonly content_sha256: string;
}

interface BatchManifest {
  readonly schema_version: typeof BATCH_MANIFEST_VERSION;
  readonly batch_id: string;
  readonly members: readonly BatchManifestMember[];
  readonly sync_state?: PricingSyncState;
}

interface CommitLockOwner {
  readonly schema_version: typeof LOCK_OWNER_VERSION;
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly acquired_at_ms: number;
}

export class PriceSnapshotStoreError extends Error {
  readonly code:
    | "PRICE_SNAPSHOT_CONFLICT"
    | "PRICE_STORE_BUSY"
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

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code ?? "")
    : undefined;
}

function nodeExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
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

function snapshotFileName(priceSnapshotId: string): string {
  return `${sha256(priceSnapshotId)}.json`;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
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

function parseBatchManifest(path: string, expectedBatchId: string): BatchManifest {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_BATCH_MANIFEST_BYTES) {
      throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", `unsafe or oversized batch manifest: ${path}`);
    }
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", `invalid batch manifest: ${path}`);
    }
    const obj = value as Record<string, unknown>;
    if (obj.schema_version !== BATCH_MANIFEST_VERSION || obj.batch_id !== expectedBatchId || !Array.isArray(obj.members)) {
      throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", `invalid batch manifest identity: ${path}`);
    }
    if (obj.members.length > MAX_STORE_ENTRIES) {
      throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", `batch manifest exceeds supported member count: ${path}`);
    }
    const seen = new Set<string>();
    const members: BatchManifestMember[] = [];
    for (const raw of obj.members) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", `invalid batch manifest member: ${path}`);
      }
      const member = raw as Record<string, unknown>;
      if (
        typeof member.price_snapshot_id !== "string"
        || member.price_snapshot_id.length < 1
        || member.price_snapshot_id.includes("\u0000")
        || typeof member.content_sha256 !== "string"
        || !SHA256_RE.test(member.content_sha256)
        || seen.has(member.price_snapshot_id)
      ) {
        throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", `invalid batch manifest member identity: ${path}`);
      }
      seen.add(member.price_snapshot_id);
      members.push(Object.freeze({
        price_snapshot_id: member.price_snapshot_id,
        content_sha256: member.content_sha256
      }));
    }
    const syncState = Object.prototype.hasOwnProperty.call(obj, "sync_state")
      ? validateSyncState(obj.sync_state)
      : undefined;
    if (syncState !== undefined && syncState.last_status !== "updated") {
      throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", `committed batch sync state is not updated: ${path}`);
    }
    return Object.freeze({
      schema_version: BATCH_MANIFEST_VERSION,
      batch_id: expectedBatchId,
      members: Object.freeze(members),
      ...(syncState === undefined ? {} : { sync_state: syncState })
    });
  } catch (error) {
    if (error instanceof PriceSnapshotStoreError) throw error;
    throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", `invalid batch manifest: ${path}`);
  }
}

function parseLockOwner(path: string): { readonly owner: CommitLockOwner; readonly raw: string } {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_LOCK_FILE_BYTES) {
      throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", `unsafe pricing commit lock: ${path}`);
    }
    const raw = readFileSync(path, "utf8");
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", `invalid pricing commit lock: ${path}`);
    }
    const obj = value as Record<string, unknown>;
    if (
      obj.schema_version !== LOCK_OWNER_VERSION
      || typeof obj.token !== "string"
      || obj.token.length < 1
      || typeof obj.pid !== "number"
      || !Number.isSafeInteger(obj.pid)
      || obj.pid <= 0
      || typeof obj.hostname !== "string"
      || obj.hostname.length < 1
      || typeof obj.acquired_at_ms !== "number"
      || !Number.isSafeInteger(obj.acquired_at_ms)
      || obj.acquired_at_ms < 0
    ) {
      throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", `invalid pricing commit lock owner: ${path}`);
    }
    return Object.freeze({
      owner: Object.freeze({
        schema_version: LOCK_OWNER_VERSION,
        token: obj.token,
        pid: obj.pid,
        hostname: obj.hostname,
        acquired_at_ms: obj.acquired_at_ms
      }),
      raw
    });
  } catch (error) {
    if (error instanceof PriceSnapshotStoreError) throw error;
    throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", `invalid pricing commit lock: ${path}`);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

export class PriceSnapshotStore {
  readonly root: string;
  readonly #snapshotsDir: string;
  readonly #stateDir: string;
  readonly #batchesDir: string;
  readonly #stagingDir: string;
  readonly #commitLockPath: string;

  constructor(root: string) {
    if (typeof root !== "string" || root.length === 0 || root.includes("\u0000")) {
      throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", "root must be a non-empty path without NUL");
    }
    this.root = resolve(root);
    this.#snapshotsDir = join(this.root, "snapshots");
    this.#stateDir = join(this.root, "sync-state");
    this.#batchesDir = join(this.root, "snapshot-batches");
    this.#stagingDir = join(this.root, ".snapshot-batch-staging");
    this.#commitLockPath = join(this.root, ".snapshot-batch-commit.lock");

    if (nodeExists(this.root)) {
      assertSafeDirectory(this.root, "PRICE_STORE_CORRUPT");
    } else {
      mkdirSync(this.root, { recursive: true });
      assertSafeDirectory(this.root, "PRICE_STORE_CORRUPT");
    }
    for (const directory of [this.#snapshotsDir, this.#stateDir, this.#batchesDir, this.#stagingDir]) {
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
    return this.#putMany(snapshotValues);
  }

  putManyWithSyncState(snapshotValues: readonly unknown[], stateValue: PricingSyncState): PutSnapshotsResult {
    const state = validateSyncState(stateValue);
    if (state.last_status !== "updated") {
      throw new PriceSnapshotStoreError("PRICE_SYNC_STATE_INVALID", "snapshot batch sync state must be updated");
    }
    return this.#putMany(snapshotValues, state);
  }

  #putMany(snapshotValues: readonly unknown[], syncState?: PricingSyncState): PutSnapshotsResult {
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
    if (syncState !== undefined) {
      for (const snapshot of byId.values()) {
        if (snapshot.source.source_id !== syncState.source_id) {
          throw new PriceSnapshotStoreError(
            "PRICE_SYNC_STATE_INVALID",
            `snapshot '${snapshot.price_snapshot_id}' source does not match sync state source`
          );
        }
      }
    }
    if (byId.size === 0) {
      return Object.freeze({ inserted: 0, duplicates: 0, snapshots: Object.freeze([]) });
    }

    const lockToken = this.#acquireCommitLock();
    try {
      const visible = this.#visibleSnapshotMap();
      let duplicates = 0;
      const pending: Array<{ readonly snapshot: PriceSnapshot; readonly content: string }> = [];
      for (const snapshot of byId.values()) {
        const content = canonicalSnapshot(snapshot);
        const existing = visible.get(snapshot.price_snapshot_id);
        if (existing !== undefined) {
          if (canonicalSnapshot(existing) !== content) {
            throw new PriceSnapshotStoreError(
              "PRICE_SNAPSHOT_CONFLICT",
              `price_snapshot_id '${snapshot.price_snapshot_id}' already exists with different data`
            );
          }
          duplicates += 1;
        } else {
          pending.push(Object.freeze({ snapshot, content }));
        }
      }

      if (pending.length === 0) {
        if (syncState !== undefined) this.writeSyncState(syncState);
        return Object.freeze({
          inserted: 0,
          duplicates,
          snapshots: Object.freeze([...byId.values()])
        });
      }

      const batchId = randomUUID();
      const stageDirectory = join(this.#stagingDir, batchId);
      const stageSnapshots = join(stageDirectory, "snapshots");
      const committedDirectory = join(this.#batchesDir, batchId);
      let committed = false;
      mkdirSync(stageDirectory);
      mkdirSync(stageSnapshots);
      try {
        const members: BatchManifestMember[] = [];
        for (const item of pending) {
          const filename = snapshotFileName(item.snapshot.price_snapshot_id);
          writeFileSync(join(stageSnapshots, filename), item.content, { encoding: "utf8", flag: "wx" });
          members.push(Object.freeze({
            price_snapshot_id: item.snapshot.price_snapshot_id,
            content_sha256: sha256(item.content)
          }));
        }
        members.sort((a, b) => a.price_snapshot_id.localeCompare(b.price_snapshot_id));
        const manifest: BatchManifest = Object.freeze({
          schema_version: BATCH_MANIFEST_VERSION,
          batch_id: batchId,
          members: Object.freeze(members),
          ...(syncState === undefined ? {} : { sync_state: syncState })
        });
        writeFileSync(
          join(stageDirectory, "manifest.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
          { encoding: "utf8", flag: "wx" }
        );

        this.#readCommittedBatch(stageDirectory, batchId);
        renameSync(stageDirectory, committedDirectory);
        committed = true;
      } finally {
        if (!committed && nodeExists(stageDirectory)) {
          rmSync(stageDirectory, { recursive: true, force: true });
        }
      }

      return Object.freeze({
        inserted: pending.length,
        duplicates,
        snapshots: Object.freeze([...byId.values()])
      });
    } finally {
      this.#releaseCommitLock(lockToken);
    }
  }

  get(priceSnapshotId: string): PriceSnapshot | undefined {
    if (typeof priceSnapshotId !== "string" || priceSnapshotId.length === 0 || priceSnapshotId.includes("\u0000")) {
      throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", "invalid price snapshot id");
    }
    return this.#visibleSnapshotMap().get(priceSnapshotId);
  }

  list(sourceId?: string): readonly PriceSnapshot[] {
    const snapshots = [...this.#visibleSnapshotMap().values()]
      .filter((snapshot) => sourceId === undefined || snapshot.source.source_id === sourceId);
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
    let entries: string[] = [];
    if (nodeExists(directory)) {
      const directoryInfo = lstatSync(directory);
      if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
        throw new PriceSnapshotStoreError("PRICE_SYNC_STATE_INVALID", `unsafe sync-state directory: ${directory}`);
      }
      entries = readdirSync(directory).sort();
      if (entries.length > MAX_STORE_ENTRIES) throw new PriceSnapshotStoreError("PRICE_SYNC_STATE_INVALID", "sync-state directory exceeds supported entry count");
    }
    let latest: PricingSyncState | undefined;
    let latestName = "";
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
      const candidateName = `state/${name}`;
      if (
        latest === undefined
        || Date.parse(state.last_attempt_at) > Date.parse(latest.last_attempt_at)
        || (state.last_attempt_at === latest.last_attempt_at && candidateName > latestName)
      ) {
        latest = state;
        latestName = candidateName;
      }
    }

    const batchEntries = readdirSync(this.#batchesDir).sort();
    if (batchEntries.length > MAX_STORE_ENTRIES) {
      throw new PriceSnapshotStoreError("PRICE_SYNC_STATE_INVALID", "pricing batch directory exceeds supported entry count");
    }
    for (const batchId of batchEntries) {
      const batchDirectory = join(this.#batchesDir, batchId);
      assertSafeDirectory(batchDirectory, "PRICE_STORE_CORRUPT");
      const manifest = parseBatchManifest(join(batchDirectory, "manifest.json"), batchId);
      const state = manifest.sync_state;
      if (state === undefined || state.source_id !== sourceId) continue;
      const candidateName = `batch/${batchId}`;
      if (
        latest === undefined
        || Date.parse(state.last_attempt_at) > Date.parse(latest.last_attempt_at)
        || (state.last_attempt_at === latest.last_attempt_at && candidateName > latestName)
      ) {
        latest = state;
        latestName = candidateName;
      }
    }
    return latest;
  }

  #visibleSnapshotMap(): Map<string, PriceSnapshot> {
    const visible = new Map<string, PriceSnapshot>();
    const add = (snapshot: PriceSnapshot, origin: string): void => {
      const existing = visible.get(snapshot.price_snapshot_id);
      if (existing === undefined) {
        visible.set(snapshot.price_snapshot_id, snapshot);
        return;
      }
      if (canonicalSnapshot(existing) !== canonicalSnapshot(snapshot)) {
        throw new PriceSnapshotStoreError(
          "PRICE_STORE_CORRUPT",
          `conflicting committed price snapshot '${snapshot.price_snapshot_id}' at ${origin}`
        );
      }
    };

    const legacyEntries = readdirSync(this.#snapshotsDir).sort();
    if (legacyEntries.length > MAX_STORE_ENTRIES) {
      throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", "pricing snapshot directory exceeds supported entry count");
    }
    for (const name of legacyEntries) {
      if (!name.endsWith(".json")) continue;
      add(parseSnapshotFile(join(this.#snapshotsDir, name)), `legacy snapshot '${name}'`);
    }

    const batchEntries = readdirSync(this.#batchesDir).sort();
    if (batchEntries.length > MAX_STORE_ENTRIES) {
      throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", "pricing batch directory exceeds supported entry count");
    }
    for (const batchId of batchEntries) {
      const batchDirectory = join(this.#batchesDir, batchId);
      const info = lstatSync(batchDirectory);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", `unsafe committed price batch: ${batchDirectory}`);
      }
      for (const snapshot of this.#readCommittedBatch(batchDirectory, batchId)) {
        add(snapshot, `committed batch '${batchId}'`);
      }
    }
    return visible;
  }

  #readCommittedBatch(batchDirectory: string, batchId: string): readonly PriceSnapshot[] {
    const manifest = parseBatchManifest(join(batchDirectory, "manifest.json"), batchId);
    const snapshotsDirectory = join(batchDirectory, "snapshots");
    assertSafeDirectory(snapshotsDirectory, "PRICE_STORE_CORRUPT");
    const entries = readdirSync(snapshotsDirectory).sort();
    if (entries.length !== manifest.members.length || entries.length > MAX_STORE_ENTRIES) {
      throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", `committed price batch member count mismatch: ${batchDirectory}`);
    }
    const allowedFiles = new Set(manifest.members.map((member) => snapshotFileName(member.price_snapshot_id)));
    for (const name of entries) {
      if (!allowedFiles.has(name)) {
        throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", `unexpected committed price batch member: ${join(snapshotsDirectory, name)}`);
      }
    }
    const snapshots: PriceSnapshot[] = [];
    for (const member of manifest.members) {
      const path = join(snapshotsDirectory, snapshotFileName(member.price_snapshot_id));
      const snapshot = parseSnapshotFile(path);
      const content = canonicalSnapshot(snapshot);
      if (
        snapshot.price_snapshot_id !== member.price_snapshot_id
        || sha256(content) !== member.content_sha256
      ) {
        throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", `committed price batch member digest mismatch: ${path}`);
      }
      snapshots.push(snapshot);
    }
    return Object.freeze(snapshots);
  }

  #acquireCommitLock(): string {
    const token = randomUUID();
    const owner: CommitLockOwner = Object.freeze({
      schema_version: LOCK_OWNER_VERSION,
      token,
      pid: process.pid,
      hostname: hostname(),
      acquired_at_ms: Date.now()
    });
    const content = `${JSON.stringify(owner)}\n`;
    const deadline = Date.now() + COMMIT_LOCK_WAIT_MS;

    for (;;) {
      try {
        writeFileSync(this.#commitLockPath, content, { encoding: "utf8", flag: "wx" });
        return token;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }

      if (!nodeExists(this.#commitLockPath)) continue;
      const observed = parseLockOwner(this.#commitLockPath);
      const ageMs = Date.now() - observed.owner.acquired_at_ms;
      if (
        observed.owner.hostname === hostname()
        && ageMs >= COMMIT_LOCK_RECLAIM_GRACE_MS
        && !processIsAlive(observed.owner.pid)
      ) {
        if (nodeExists(this.#commitLockPath)) {
          const current = parseLockOwner(this.#commitLockPath);
          if (current.raw === observed.raw && current.owner.token === observed.owner.token) {
            unlinkSync(this.#commitLockPath);
            continue;
          }
        }
      }

      if (Date.now() >= deadline) {
        throw new PriceSnapshotStoreError("PRICE_STORE_BUSY", "timed out waiting for pricing batch commit lock");
      }
      sleepSync(COMMIT_LOCK_POLL_MS);
    }
  }

  #releaseCommitLock(token: string): void {
    if (!nodeExists(this.#commitLockPath)) {
      throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", "pricing batch commit lock disappeared before release");
    }
    const current = parseLockOwner(this.#commitLockPath);
    if (current.owner.token !== token) {
      throw new PriceSnapshotStoreError("PRICE_STORE_CORRUPT", "pricing batch commit lock ownership changed before release");
    }
    unlinkSync(this.#commitLockPath);
  }
}