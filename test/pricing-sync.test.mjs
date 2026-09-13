import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PriceSnapshotStore,
  PriceSnapshotStoreError,
  PricingSynchronizer,
  PricingSynchronizerError,
  createDefaultPricingSourceRegistry
} from "../dist/src/pricing/index.js";

function withTempStore(run) {
  const root = mkdtempSync(join(tmpdir(), "ai-verse-token-price-"));
  const store = new PriceSnapshotStore(root);
  return Promise.resolve(run(store, root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

function rawSnapshot({
  id = "price-openai-test",
  platform = "openai",
  model = "gpt-test",
  startsAt = "2026-09-01T00:00:00Z",
  amount = "1.25"
} = {}) {
  return {
    schema_version: "ai-verse-token-price/0.1",
    price_snapshot_id: id,
    identity: {
      billing_platform: platform,
      resolved_model: model
    },
    currency: "USD",
    effective: { starts_at: startsAt },
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

function updatedFetcher(sourceId, getNow, calls = []) {
  return {
    source_id: sourceId,
    async fetch(request) {
      calls.push(request);
      const checkedAt = getNow();
      return {
        status: "updated",
        checked_at: checkedAt,
        etag: '"prices-v1"',
        content_digest_sha256: "a".repeat(64),
        snapshots: [rawSnapshot()]
      };
    }
  };
}

test("immutable price store persists exact snapshots and treats exact replay as duplicate", async () => {
  await withTempStore((store, root) => {
    const snapshot = rawSnapshot();
    const first = store.put(snapshot);
    assert.equal(first.inserted, 1);
    assert.equal(first.duplicates, 0);

    const second = store.put(snapshot);
    assert.equal(second.inserted, 0);
    assert.equal(second.duplicates, 1);

    const reopened = new PriceSnapshotStore(root);
    assert.equal(reopened.get(snapshot.price_snapshot_id)?.rates.input_tokens.amount, "1.25");
    assert.equal(reopened.list().length, 1);
  });
});

test("price store refuses conflicting data under an existing snapshot id", async () => {
  await withTempStore((store) => {
    store.put(rawSnapshot());
    assert.throws(
      () => store.put(rawSnapshot({ amount: "9.99" })),
      (error) => error instanceof PriceSnapshotStoreError && error.code === "PRICE_SNAPSHOT_CONFLICT"
    );
    assert.equal(store.list().length, 1);
  });
});

test("batch validation occurs before any price snapshot is written", async () => {
  await withTempStore((store) => {
    const invalid = rawSnapshot({ id: "bad" });
    invalid.rates.input_tokens.amount = 1.5;
    assert.throws(() => store.putMany([rawSnapshot({ id: "good" }), invalid]));
    assert.equal(store.list().length, 0);
  });
});

test("updated sync stamps trusted source provenance and writes immutable history", async () => {
  await withTempStore(async (store) => {
    const registry = createDefaultPricingSourceRegistry();
    const calls = [];
    const now = "2026-09-12T10:00:00Z";
    const sync = new PricingSynchronizer({
      registry,
      store,
      fetchers: [updatedFetcher("openai-official-pricing", () => now, calls)]
    });

    const report = await sync.refreshSource({
      source_id: "openai-official-pricing",
      reason: "startup",
      now
    });
    assert.equal(report.outcome, "updated");
    assert.equal(report.inserted, 1);
    assert.equal(calls.length, 1);

    const stored = store.list()[0];
    assert.equal(stored.source.source_id, "openai-official-pricing");
    assert.equal(stored.source.authority, "official_public_pricing");
    assert.equal(stored.source.retrieved_at, now);
    assert.equal(stored.source.etag, '"prices-v1"');
    assert.equal(stored.verification.verified_at, now);

    const state = store.syncState("openai-official-pricing");
    assert.equal(state.last_status, "updated");
    assert.equal(state.last_checked_at, now);
    assert.equal(state.snapshot_count, 1);
  });
});

test("startup refresh skips a source that is already fresh", async () => {
  await withTempStore(async (store) => {
    const registry = createDefaultPricingSourceRegistry();
    const calls = [];
    const now = "2026-09-12T10:00:00Z";
    const sync = new PricingSynchronizer({
      registry,
      store,
      fetchers: [updatedFetcher("openai-official-pricing", () => now, calls)]
    });
    await sync.refreshSource({ source_id: "openai-official-pricing", reason: "startup", now });
    const reports = await sync.refreshStale({ reason: "startup", now: "2026-09-12T11:00:00Z" });
    assert.equal(reports.length, 0);
    assert.equal(calls.length, 1);
  });
});

test("same-day policy forces a startup refresh on the next UTC day", async () => {
  await withTempStore(async (store) => {
    const registry = createDefaultPricingSourceRegistry();
    let checkedAt = "2026-09-11T23:59:00Z";
    const calls = [];
    const sync = new PricingSynchronizer({
      registry,
      store,
      fetchers: [updatedFetcher("openai-official-pricing", () => checkedAt, calls)]
    });
    await sync.refreshSource({ source_id: "openai-official-pricing", reason: "startup", now: checkedAt });
    checkedAt = "2026-09-12T00:01:00Z";
    const reports = await sync.refreshStale({ reason: "startup", now: checkedAt });
    assert.equal(reports.length, 1);
    assert.equal(calls.length, 2);
  });
});

test("304-style not-modified check renews freshness only through matching ETag/digest evidence", async () => {
  await withTempStore(async (store) => {
    const registry = createDefaultPricingSourceRegistry();
    let call = 0;
    const fetcher = {
      source_id: "openai-official-pricing",
      async fetch() {
        call += 1;
        if (call === 1) {
          return {
            status: "updated",
            checked_at: "2026-09-11T20:00:00Z",
            etag: '"same"',
            content_digest_sha256: "b".repeat(64),
            snapshots: [rawSnapshot()]
          };
        }
        return {
          status: "not_modified",
          checked_at: "2026-09-12T08:00:00Z",
          etag: '"same"'
        };
      }
    };
    const sync = new PricingSynchronizer({ registry, store, fetchers: [fetcher] });
    await sync.refreshSource({
      source_id: "openai-official-pricing",
      reason: "startup",
      now: "2026-09-11T20:00:00Z"
    });
    const stored = store.list()[0];
    const noEvidence = registry.assess(stored, "2026-09-12T09:00:00Z");
    assert.equal(noEvidence.freshness, "stale");

    const report = await sync.refreshSource({
      source_id: "openai-official-pricing",
      reason: "startup",
      now: "2026-09-12T08:00:00Z"
    });
    assert.equal(report.outcome, "not_modified");
    assert.equal(store.list().length, 1);

    const evidence = sync.freshnessEvidence("openai-official-pricing");
    const withEvidence = registry.assess(stored, "2026-09-12T09:00:00Z", evidence);
    assert.equal(withEvidence.freshness, "fresh");
    assert.equal(withEvidence.freshness_basis, "source_recheck");
    assert.equal(withEvidence.can_authorize_calculated_cost, true);

    const wrongEvidence = registry.assess(stored, "2026-09-12T09:00:00Z", {
      checked_at: "2026-09-12T08:00:00Z",
      etag: '"different"'
    });
    assert.equal(wrongEvidence.freshness, "stale");
    assert.equal(wrongEvidence.freshness_basis, "snapshot_retrieval");
  });
});

test("not-modified without previous ETag or digest fails closed", async () => {
  await withTempStore(async (store) => {
    const registry = createDefaultPricingSourceRegistry();
    let call = 0;
    const fetcher = {
      source_id: "openai-official-pricing",
      async fetch() {
        call += 1;
        if (call === 1) {
          return {
            status: "updated",
            checked_at: "2026-09-12T08:00:00Z",
            snapshots: [rawSnapshot()]
          };
        }
        return { status: "not_modified", checked_at: "2026-09-12T09:00:00Z" };
      }
    };
    const sync = new PricingSynchronizer({ registry, store, fetchers: [fetcher] });
    assert.equal((await sync.refreshSource({
      source_id: "openai-official-pricing", reason: "startup", now: "2026-09-12T08:00:00Z"
    })).outcome, "updated");
    const second = await sync.refreshSource({
      source_id: "openai-official-pricing", reason: "manual", now: "2026-09-12T09:00:00Z"
    });
    assert.equal(second.outcome, "failed");
    assert.equal(second.error_code, "SYNC_INVALID");
  });
});

test("unknown-model refresh is forced even when the source is already fresh", async () => {
  await withTempStore(async (store) => {
    const registry = createDefaultPricingSourceRegistry();
    let checkedAt = "2026-09-12T08:00:00Z";
    const calls = [];
    const sync = new PricingSynchronizer({
      registry,
      store,
      fetchers: [updatedFetcher("openai-official-pricing", () => checkedAt, calls)]
    });
    await sync.refreshSource({ source_id: "openai-official-pricing", reason: "startup", now: checkedAt });
    checkedAt = "2026-09-12T08:05:00Z";
    const reports = await sync.refreshForUnknownModel({
      billing_platform: "openai",
      resolved_model: "gpt-new-today",
      now: checkedAt
    });
    assert.equal(reports.length, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].reason, "unknown_model");
    assert.equal(calls[1].resolved_model, "gpt-new-today");
  });
});

test("fetch failure records a safe failure code while preserving last successful evidence", async () => {
  await withTempStore(async (store) => {
    const registry = createDefaultPricingSourceRegistry();
    let fail = false;
    const fetcher = {
      source_id: "openai-official-pricing",
      async fetch() {
        if (fail) throw new Error("secret URL or token must not persist");
        return {
          status: "updated",
          checked_at: "2026-09-12T08:00:00Z",
          etag: '"v1"',
          snapshots: [rawSnapshot()]
        };
      }
    };
    const sync = new PricingSynchronizer({ registry, store, fetchers: [fetcher] });
    await sync.refreshSource({ source_id: "openai-official-pricing", reason: "startup", now: "2026-09-12T08:00:00Z" });
    fail = true;
    const report = await sync.refreshSource({ source_id: "openai-official-pricing", reason: "manual", now: "2026-09-12T09:00:00Z" });
    assert.equal(report.outcome, "failed");
    assert.equal(report.error_code, "FETCH_FAILED");
    const state = store.syncState("openai-official-pricing");
    assert.equal(state.last_status, "failed");
    assert.equal(state.last_checked_at, "2026-09-12T08:00:00Z");
    assert.equal(state.etag, '"v1"');
    assert.equal(JSON.stringify(state).includes("secret"), false);
  });
});

test("invalid fetched snapshot cannot partially add a batch", async () => {
  await withTempStore(async (store) => {
    const registry = createDefaultPricingSourceRegistry();
    const invalid = rawSnapshot({ id: "bad" });
    invalid.currency = "usd";
    const fetcher = {
      source_id: "openai-official-pricing",
      async fetch() {
        return {
          status: "updated",
          checked_at: "2026-09-12T08:00:00Z",
          snapshots: [rawSnapshot({ id: "good" }), invalid]
        };
      }
    };
    const sync = new PricingSynchronizer({ registry, store, fetchers: [fetcher] });
    const report = await sync.refreshSource({ source_id: "openai-official-pricing", reason: "startup", now: "2026-09-12T08:00:00Z" });
    assert.equal(report.outcome, "failed");
    assert.equal(report.error_code, "SYNC_INVALID");
    assert.equal(store.list().length, 0);
  });
});

test("periodic refresh can be started/stopped and uses stale-source checks", async () => {
  await withTempStore(async (store) => {
    let callback;
    let cleared = false;
    const scheduler = {
      setInterval(fn, delay) {
        callback = fn;
        assert.equal(delay, 60000);
        return { fake: true };
      },
      clearInterval(handle) {
        assert.deepEqual(handle, { fake: true });
        cleared = true;
      }
    };
    let calls = 0;
    const fetcher = {
      source_id: "openai-official-pricing",
      async fetch() {
        calls += 1;
        return {
          status: "updated",
          checked_at: "2026-09-12T08:00:00Z",
          etag: '"v1"',
          snapshots: [rawSnapshot()]
        };
      }
    };
    const sync = new PricingSynchronizer({
      registry: createDefaultPricingSourceRegistry(),
      store,
      fetchers: [fetcher],
      scheduler
    });
    sync.startPeriodic({ interval_ms: 60000, now: () => new Date("2026-09-12T08:00:00Z") });
    assert.equal(sync.periodicActive, true);
    callback();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls, 1);
    sync.stopPeriodic();
    assert.equal(sync.periodicActive, false);
    assert.equal(cleared, true);
  });
});

test("constructor rejects unregistered or duplicate fetcher authority", async () => {
  await withTempStore((store) => {
    const registry = createDefaultPricingSourceRegistry();
    const unknown = { source_id: "fake-source", async fetch() { return {}; } };
    assert.throws(
      () => new PricingSynchronizer({ registry, store, fetchers: [unknown] }),
      PricingSynchronizerError
    );
    const fetcher = updatedFetcher("openai-official-pricing", () => "2026-09-12T08:00:00Z");
    assert.throws(
      () => new PricingSynchronizer({ registry, store, fetchers: [fetcher, fetcher] }),
      /duplicate fetcher/
    );
  });
});


test("pricing store rejects a symlinked root before creating child state", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "ai-verse-token-price-link-"));
  const outside = mkdtempSync(join(tmpdir(), "ai-verse-token-price-outside-"));
  const linked = join(parent, "store");
  try {
    try {
      symlinkSync(outside, linked, "dir");
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        t.skip("Host does not permit directory symlinks");
        return;
      }
      throw error;
    }
    assert.throws(
      () => new PriceSnapshotStore(linked),
      (error) => error instanceof PriceSnapshotStoreError && error.code === "PRICE_STORE_CORRUPT"
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("pricing store rejects oversized snapshot files instead of attempting to parse them", async () => {
  await withTempStore((store, root) => {
    writeFileSync(join(root, "snapshots", "oversized.json"), "x".repeat(2 * 1024 * 1024 + 1));
    assert.throws(
      () => store.list(),
      (error) => error instanceof PriceSnapshotStoreError && error.code === "PRICE_STORE_CORRUPT"
    );
  });
});
