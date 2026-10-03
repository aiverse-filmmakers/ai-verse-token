import assert from "node:assert/strict";
import fs, { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import {
  PriceSnapshotStore,
  PricingSynchronizer,
  createDefaultPricingSourceRegistry
} from "../dist/src/pricing/index.js";

function rawSnapshot(id, amount) {
  return {
    schema_version: "ai-verse-token-price/0.1",
    price_snapshot_id: id,
    identity: {
      billing_platform: "openai",
      resolved_model: id
    },
    currency: "USD",
    effective: { starts_at: "2026-10-03T00:00:00Z" },
    rates: { input_tokens: { amount, per: 1000000 } },
    source: {
      authority: "official_public_pricing",
      source_id: "openai-official-pricing",
      retrieved_at: "2026-01-01T00:00:00Z",
      source_url: "https://example.com/pricing"
    },
    verification: {
      status: "verified",
      verified_at: "2026-01-01T00:00:00Z"
    }
  };
}

function withTempRoot(run) {
  const root = mkdtempSync(join(tmpdir(), "ai-verse-token-sync-tx-"));
  return Promise.resolve(run(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

function synchronizer(store, snapshots) {
  return new PricingSynchronizer({
    registry: createDefaultPricingSourceRegistry(),
    store,
    fetchers: [{
      source_id: "openai-official-pricing",
      async fetch() {
        return {
          status: "updated",
          checked_at: "2026-10-03T12:00:00Z",
          etag: '"atomic-v1"',
          content_digest_sha256: "c".repeat(64),
          snapshots
        };
      }
    }]
  });
}

test("WSA-2026-025: successful updated refresh publishes snapshots and success observation together", async () => {
  await withTempRoot(async (root) => {
    const store = new PriceSnapshotStore(root);
    const sync = synchronizer(store, [
      rawSnapshot("sync-atomic-a", "1.00"),
      rawSnapshot("sync-atomic-b", "2.00")
    ]);

    const report = await sync.refreshSource({
      source_id: "openai-official-pricing",
      reason: "manual",
      now: "2026-10-03T12:00:00Z"
    });

    assert.equal(report.outcome, "updated");
    assert.equal(report.inserted, 2);
    assert.equal(store.list().length, 2);
    assert.deepEqual(readdirSync(join(root, "sync-state")), []);
    const state = store.syncState("openai-official-pricing");
    assert.equal(state.last_status, "updated");
    assert.equal(state.last_checked_at, "2026-10-03T12:00:00Z");
    assert.equal(state.snapshot_count, 2);
  });
});

test("WSA-2026-025: failure before atomic batch publish records failure and exposes no new snapshots", async () => {
  await withTempRoot(async (root) => {
    const store = new PriceSnapshotStore(root);
    const sync = synchronizer(store, [
      rawSnapshot("sync-fail-a", "3.00"),
      rawSnapshot("sync-fail-b", "4.00")
    ]);
    const originalWriteFileSync = fs.writeFileSync;
    let manifestFailures = 0;
    fs.writeFileSync = function patchedWriteFileSync(path, data, options) {
      const normalized = String(path);
      if (
        manifestFailures === 0
        && normalized.includes(`${sep}.snapshot-batch-staging${sep}`)
        && normalized.endsWith(`${sep}manifest.json`)
      ) {
        manifestFailures += 1;
        const error = new Error("deterministic batch manifest write failure");
        error.code = "EIO";
        throw error;
      }
      return originalWriteFileSync.call(fs, path, data, options);
    };
    syncBuiltinESMExports();

    let report;
    try {
      report = await sync.refreshSource({
        source_id: "openai-official-pricing",
        reason: "manual",
        now: "2026-10-03T12:00:00Z"
      });
    } finally {
      fs.writeFileSync = originalWriteFileSync;
      syncBuiltinESMExports();
    }

    assert.equal(manifestFailures, 1);
    assert.equal(report.outcome, "failed");
    assert.equal(report.error_code, "SYNC_INVALID");
    assert.equal(store.list().length, 0);
    assert.equal(store.get("sync-fail-a"), undefined);
    assert.equal(store.get("sync-fail-b"), undefined);
    const state = store.syncState("openai-official-pricing");
    assert.equal(state.last_status, "failed");
    assert.equal(state.last_error_code, "SYNC_INVALID");
  });
});
