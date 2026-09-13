import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  COLLECTOR_RUN_LIMITS,
  CollectorExecutionError,
  CollectorRegistry,
  CollectorRegistryError,
  CollectorRunner
} from "../dist/src/collectors/index.js";
import { openTokenLedger } from "../dist/src/storage/index.js";

function tempLedger() {
  const dir = mkdtempSync(join(tmpdir(), "token-collector-"));
  return { dir, ledger: openTokenLedger({ path: join(dir, "token.sqlite"), mode: "create-or-open" }) };
}

function event({ id = "evt-c1", fingerprint = "collector-fingerprint-1", collectorId = "fake", collectorVersion = "1.0.0", runtime = "fake-runtime" } = {}) {
  return {
    schema_version: "ai-verse-token/0.1",
    event_id: id,
    source: { runtime, source_type: "fake" },
    observed_at: "2026-09-12T12:00:00Z",
    identity: { billing_platform: "openai", requested_model: "m", resolved_model: "m" },
    usage: { input_tokens: 1, output_tokens: 1 },
    timing: { started_at: "2026-09-12T11:59:59Z" },
    provenance: {
      collector_id: collectorId,
      collector_version: collectorVersion,
      source_record_fingerprint: fingerprint,
      usage_quality: "provider_reported",
      timing_quality: "provider_reported",
      content_stored: false
    }
  };
}

function fakeCollector({ detect = { status: "available", code: "SOURCE_READY" }, collect } = {}) {
  return {
    definition: { id: "fake", version: "1.0.0", runtimes: ["fake-runtime"] },
    detect() { return detect; },
    collect: collect ?? ((request) => ({
      emissions: [{ event: event(), checkpoint_cursor: "cursor-1" }],
      complete: true,
      request
    }))
  };
}

test("collector registry validates/freeze definitions and rejects duplicate IDs", () => {
  const registry = new CollectorRegistry([fakeCollector()]);
  assert.deepEqual(registry.list(), [{ id: "fake", version: "1.0.0", runtimes: ["fake-runtime"] }]);
  assert.equal(Object.isFrozen(registry.list()[0]), true);
  assert.throws(() => new CollectorRegistry([fakeCollector(), fakeCollector()]), (error) =>
    error instanceof CollectorRegistryError && error.code === "COLLECTOR_DUPLICATE");
});

test("runner ingests normalized events and advances only its own checkpoint", async () => {
  const { dir, ledger } = tempLedger();
  try {
    const runner = new CollectorRunner(new CollectorRegistry([fakeCollector()]));
    const result = await runner.run({ collector_id: "fake", source: {}, ledger });
    assert.equal(result.inserted, 1);
    assert.equal(result.duplicates, 0);
    assert.equal(result.checkpoint_before, null);
    assert.equal(result.checkpoint_after, "cursor-1");
    assert.equal(ledger.collectorCheckpoint("fake")?.cursor, "cursor-1");
    assert.equal(ledger.collectorCheckpoint("other"), null);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner passes the prior checkpoint back for incremental scans", async () => {
  const { dir, ledger } = tempLedger();
  try {
    const seen = [];
    let sequence = 0;
    const collector = fakeCollector({
      collect(request) {
        seen.push(request.checkpoint_cursor);
        sequence += 1;
        return {
          emissions: [{
            event: event({ id: `evt-${sequence}`, fingerprint: `collector-fingerprint-${sequence}` }),
            checkpoint_cursor: `cursor-${sequence}`
          }],
          complete: true
        };
      }
    });
    const runner = new CollectorRunner(new CollectorRegistry([collector]));
    await runner.run({ collector_id: "fake", source: {}, ledger });
    await runner.run({ collector_id: "fake", source: {}, ledger });
    assert.deepEqual(seen, [null, "cursor-1"]);
    assert.equal(ledger.collectorCheckpoint("fake")?.cursor, "cursor-2");
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unavailable detection returns health without calling collect or mutating ledger", async () => {
  const { dir, ledger } = tempLedger();
  try {
    let collected = false;
    const collector = fakeCollector({
      detect: { status: "unavailable", code: "SOURCE_NOT_FOUND" },
      collect() { collected = true; return { emissions: [], complete: true }; }
    });
    const result = await new CollectorRunner(new CollectorRegistry([collector]))
      .run({ collector_id: "fake", source: {}, ledger });
    assert.equal(collected, false);
    assert.equal(result.health.status, "unavailable");
    assert.equal(ledger.queryUsage().events.length, 0);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("degraded detection can still collect but remains visible in health", async () => {
  const { dir, ledger } = tempLedger();
  try {
    const collector = fakeCollector({ detect: { status: "degraded", code: "PARTIAL_HISTORY" } });
    const result = await new CollectorRunner(new CollectorRegistry([collector]))
      .run({ collector_id: "fake", source: {}, ledger });
    assert.equal(result.inserted, 1);
    assert.equal(result.health.status, "degraded");
    assert.equal(result.health.code, "PARTIAL_HISTORY");
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collector cannot impersonate another collector or version", async () => {
  for (const badEvent of [
    event({ collectorId: "other" }),
    event({ collectorVersion: "9.9.9" })
  ]) {
    const { dir, ledger } = tempLedger();
    try {
      const collector = fakeCollector({ collect: () => ({ emissions: [{ event: badEvent, checkpoint_cursor: "x" }], complete: true }) });
      await assert.rejects(
        new CollectorRunner(new CollectorRegistry([collector])).run({ collector_id: "fake", source: {}, ledger }),
        (error) => error instanceof CollectorExecutionError && error.code === "COLLECTOR_PROVENANCE_MISMATCH"
      );
      assert.equal(ledger.queryUsage().events.length, 0);
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("collector cannot emit an unregistered runtime", async () => {
  const { dir, ledger } = tempLedger();
  try {
    const collector = fakeCollector({ collect: () => ({
      emissions: [{ event: event({ runtime: "other-runtime" }), checkpoint_cursor: "x" }], complete: true
    }) });
    await assert.rejects(
      new CollectorRunner(new CollectorRegistry([collector])).run({ collector_id: "fake", source: {}, ledger }),
      (error) => error instanceof CollectorExecutionError && error.code === "COLLECTOR_RUNTIME_MISMATCH"
    );
    assert.equal(ledger.queryUsage().events.length, 0);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collector output and requested scan size are hard bounded", async () => {
  const { dir, ledger } = tempLedger();
  try {
    const tooMany = fakeCollector({ collect: () => ({
      emissions: [
        { event: event({ id: "a", fingerprint: "collector-fingerprint-a" }), checkpoint_cursor: "a" },
        { event: event({ id: "b", fingerprint: "collector-fingerprint-b" }), checkpoint_cursor: "b" }
      ],
      complete: true
    }) });
    await assert.rejects(
      new CollectorRunner(new CollectorRegistry([tooMany])).run({ collector_id: "fake", source: {}, ledger, max_events: 1 }),
      (error) => error instanceof CollectorExecutionError && error.code === "COLLECTOR_LIMIT_EXCEEDED"
    );
    await assert.rejects(
      new CollectorRunner(new CollectorRegistry([fakeCollector()])).run({
        collector_id: "fake", source: {}, ledger, max_events: COLLECTOR_RUN_LIMITS.hard_max_events + 1
      }),
      /max_events/
    );
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("duplicate source replay remains duplicate while checkpoint still advances atomically", async () => {
  const { dir, ledger } = tempLedger();
  try {
    let pass = 0;
    const collector = fakeCollector({
      collect() {
        pass += 1;
        return { emissions: [{ event: event(), checkpoint_cursor: `cursor-${pass}` }], complete: true };
      }
    });
    const runner = new CollectorRunner(new CollectorRegistry([collector]));
    const first = await runner.run({ collector_id: "fake", source: {}, ledger });
    const second = await runner.run({ collector_id: "fake", source: {}, ledger });
    assert.equal(first.inserted, 1);
    assert.equal(second.duplicates, 1);
    assert.equal(ledger.queryUsage().events.length, 1);
    assert.equal(ledger.collectorCheckpoint("fake")?.cursor, "cursor-2");
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
