from pathlib import Path


def one(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


store_path = Path("src/pricing/store.ts")
store = store_path.read_text(encoding="utf-8")

store = one(
    store,
    '''interface BatchManifest {
  readonly schema_version: typeof BATCH_MANIFEST_VERSION;
  readonly batch_id: string;
  readonly members: readonly BatchManifestMember[];
}''',
    '''interface BatchManifest {
  readonly schema_version: typeof BATCH_MANIFEST_VERSION;
  readonly batch_id: string;
  readonly members: readonly BatchManifestMember[];
  readonly sync_state?: PricingSyncState;
}''',
    "batch manifest interface",
)

store = one(
    store,
    '''    return Object.freeze({
      schema_version: BATCH_MANIFEST_VERSION,
      batch_id: expectedBatchId,
      members: Object.freeze(members)
    });''',
    '''    const syncState = Object.prototype.hasOwnProperty.call(obj, "sync_state")
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
    });''',
    "batch manifest parsing",
)

store = one(
    store,
    '''  putMany(snapshotValues: readonly unknown[]): PutSnapshotsResult {
    const snapshots = snapshotValues.map((value) => validatePriceSnapshot(value));''',
    '''  putMany(snapshotValues: readonly unknown[]): PutSnapshotsResult {
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
    const snapshots = snapshotValues.map((value) => validatePriceSnapshot(value));''',
    "putMany refactor",
)

store = one(
    store,
    '''      byId.set(snapshot.price_snapshot_id, snapshot);
    }
    if (byId.size === 0) {''',
    '''      byId.set(snapshot.price_snapshot_id, snapshot);
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
    if (byId.size === 0) {''',
    "sync source binding",
)

store = one(
    store,
    '''      if (pending.length === 0) {
        return Object.freeze({
          inserted: 0,
          duplicates,
          snapshots: Object.freeze([...byId.values()])
        });
      }''',
    '''      if (pending.length === 0) {
        if (syncState !== undefined) this.writeSyncState(syncState);
        return Object.freeze({
          inserted: 0,
          duplicates,
          snapshots: Object.freeze([...byId.values()])
        });
      }''',
    "duplicate-only success state",
)

store = one(
    store,
    '''        const manifest: BatchManifest = Object.freeze({
          schema_version: BATCH_MANIFEST_VERSION,
          batch_id: batchId,
          members: Object.freeze(members)
        });''',
    '''        const manifest: BatchManifest = Object.freeze({
          schema_version: BATCH_MANIFEST_VERSION,
          batch_id: batchId,
          members: Object.freeze(members),
          ...(syncState === undefined ? {} : { sync_state: syncState })
        });''',
    "embedded success state",
)

store = one(
    store,
    '''      if (
        latest === undefined
        || Date.parse(state.last_attempt_at) > Date.parse(latest.last_attempt_at)
        || (state.last_attempt_at === latest.last_attempt_at && name > latestName)
      ) {
        latest = state;
        latestName = name;
      }
    }
    return latest;
  }''',
    '''      const candidateName = `state/${name}`;
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
  }''',
    "embedded sync state read",
)

store_path.write_text(store, encoding="utf-8")

sync_path = Path("src/pricing/sync.ts")
sync = sync_path.read_text(encoding="utf-8")
sync = one(
    sync,
    '''      const stored = this.store.putMany(normalized);
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
      });''',
    '''      const stored = this.store.putManyWithSyncState(normalized, {
        schema_version: "ai-verse-token-price-sync-state/0.1",
        source_id: options.source_id,
        last_attempt_at: nowIso,
        last_status: "updated",
        last_success_at: checkedAt,
        last_checked_at: checkedAt,
        ...(etag === undefined ? {} : { etag }),
        ...(digest === undefined ? {} : { content_digest_sha256: digest }),
        snapshot_count: normalized.length
      });''',
    "synchronizer atomic success commit",
)
sync_path.write_text(sync, encoding="utf-8")
