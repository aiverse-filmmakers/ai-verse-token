import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, {
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  PriceSnapshotStore,
  PriceSnapshotStoreError
} from "../dist/src/pricing/index.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "pricing-batch-writer-fixture.mjs");

function rawSnapshot({ id, amount = "1.25", model = id } = {}) {
  return {
    schema_version: "ai-verse-token-price/0.1",
    price_snapshot_id: id,
    identity: {
      billing_platform: "openai",
      resolved_model: model
    },
    currency: "USD",
    effective: { starts_at: "2026-10-03T00:00:00Z" },
    rates: { input_tokens: { amount, per: 1000000 } },
    source: {
      authority: "official_public_pricing",
      source_id: "openai-official-pricing",
      retrieved_at: "2026-10-03T12:00:00Z",
      source_url: "https://example.com/pricing"
    },
    verification: {
      status: "verified",
      verified_at: "2026-10-03T12:00:00Z"
    }
  };
}

function withTempRoot(run) {
  const root = mkdtempSync(join(tmpdir(), "ai-verse-token-price-tx-"));
  return Promise.resolve(run(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

function runFixture(config) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE], {
      env: {
        ...process.env,
        AI_VERSE_TOKEN_BATCH_FIXTURE: JSON.stringify(config)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("WSA-2026-025: later staged-member I/O failure exposes none of the batch", async () => {
  await withTempRoot((root) => {
    const store = new PriceSnapshotStore(root);
    const originalWriteFileSync = fs.writeFileSync;
    let stagedMemberWrites = 0;
    fs.writeFileSync = function patchedWriteFileSync(path, data, options) {
      const normalized = String(path);
      if (
        normalized.includes(`${sep}.snapshot-batch-staging${sep}`)
        && normalized.includes(`${sep}snapshots${sep}`)
        && normalized.endsWith(".json")
      ) {
        stagedMemberWrites += 1;
        if (stagedMemberWrites === 2) {
          const error = new Error("deterministic staged member write failure");
          error.code = "EIO";
          throw error;
        }
      }
      return originalWriteFileSync.call(fs, path, data, options);
    };
    syncBuiltinESMExports();

    try {
      assert.throws(() => store.putMany([
        rawSnapshot({ id: "fault-first" }),
        rawSnapshot({ id: "fault-second" })
      ]), /deterministic staged member write failure/);
    } finally {
      fs.writeFileSync = originalWriteFileSync;
      syncBuiltinESMExports();
    }

    assert.equal(stagedMemberWrites, 2);
    assert.equal(store.get("fault-first"), undefined);
    assert.equal(store.get("fault-second"), undefined);
    assert.equal(store.list().length, 0);
    assert.deepEqual(readdirSync(join(root, "snapshot-batches")), []);
    assert.deepEqual(readdirSync(join(root, ".snapshot-batch-staging")), []);
  });
});

test("WSA-2026-025: competing cross-process batches publish exactly one whole winner", async () => {
  await withTempRoot(async (root) => {
    const store = new PriceSnapshotStore(root);
    const startFile = join(root, "start-race");
    const batchA = [
      rawSnapshot({ id: "winner-a-only", amount: "1.00" }),
      rawSnapshot({ id: "shared-conflict", amount: "2.00" })
    ];
    const batchB = [
      rawSnapshot({ id: "winner-b-only", amount: "3.00" }),
      rawSnapshot({ id: "shared-conflict", amount: "4.00" })
    ];

    const writerA = runFixture({ root, start_file: startFile, batch: batchA, mode: "normal" });
    const writerB = runFixture({ root, start_file: startFile, batch: batchB, mode: "normal" });
    writeFileSync(startFile, "go\n", "utf8");
    const results = await Promise.all([writerA, writerB]);

    assert.deepEqual(results.map((result) => result.code).sort(), [0, 2]);
    const loser = results.find((result) => result.code === 2);
    assert.match(loser.stderr, /PRICE_SNAPSHOT_CONFLICT/);

    const snapshots = store.list();
    assert.equal(snapshots.length, 2);
    const shared = store.get("shared-conflict");
    assert.ok(shared);
    if (shared.rates.input_tokens.amount === "2.00") {
      assert.ok(store.get("winner-a-only"));
      assert.equal(store.get("winner-b-only"), undefined);
    } else {
      assert.equal(shared.rates.input_tokens.amount, "4.00");
      assert.ok(store.get("winner-b-only"));
      assert.equal(store.get("winner-a-only"), undefined);
    }
  });
});

test("WSA-2026-025: crashed commit holder is recovered without publishing its staged subset", async () => {
  await withTempRoot(async (root) => {
    const store = new PriceSnapshotStore(root);
    const startFile = join(root, "start-crash");
    const crashed = runFixture({
      root,
      start_file: startFile,
      mode: "crash_after_first_stage_member",
      batch: [
        rawSnapshot({ id: "crash-first" }),
        rawSnapshot({ id: "crash-second" })
      ]
    });
    writeFileSync(startFile, "go\n", "utf8");
    const crashedResult = await crashed;
    assert.equal(crashedResult.code, 71);

    assert.equal(store.get("crash-first"), undefined);
    assert.equal(store.get("crash-second"), undefined);
    assert.equal(store.list().length, 0);

    const recovery = store.putMany([
      rawSnapshot({ id: "recovery-first", amount: "5.00" }),
      rawSnapshot({ id: "recovery-second", amount: "6.00" })
    ]);
    assert.equal(recovery.inserted, 2);
    assert.equal(recovery.duplicates, 0);
    assert.equal(store.list().length, 2);
    assert.ok(store.get("recovery-first"));
    assert.ok(store.get("recovery-second"));
    assert.equal(store.get("crash-first"), undefined);
  });
});

test("WSA-2026-025: live commit lock is never reclaimed by age alone", async () => {
  await withTempRoot(async (root) => {
    const store = new PriceSnapshotStore(root);
    const lockPath = join(root, ".snapshot-batch-commit.lock");
    writeFileSync(lockPath, `${JSON.stringify({
      schema_version: "ai-verse-token-price-commit-lock/0.1",
      token: "live-holder",
      pid: process.pid,
      hostname: (await import("node:os")).hostname(),
      acquired_at_ms: Date.now() - 60_000
    })}\n`, { encoding: "utf8", flag: "wx" });

    assert.throws(
      () => store.put(rawSnapshot({ id: "must-not-steal-live-lock" })),
      (error) => error instanceof PriceSnapshotStoreError && error.code === "PRICE_STORE_BUSY"
    );
    assert.equal(store.get("must-not-steal-live-lock"), undefined);
  });
});
