import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  normalizeCommandCodeUsageRecord,
  normalizeOpenRouterGeneration
} from "../dist/src/adapters/index.js";
import {
  CollectorExecutionError,
  CollectorRegistry,
  CollectorRunner
} from "../dist/src/collectors/index.js";
import { createDefaultActualCostSourceRegistry } from "../dist/src/cost/index.js";
import { TokenLedgerError, openTokenLedger } from "../dist/src/storage/index.js";

function tempLedger(prefix = "token-actual-authority-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    ledger: openTokenLedger({ path: join(dir, "token.sqlite"), mode: "create-or-open" })
  };
}

function plainEvent({
  id = "evt-forged-actual",
  collectorId = "fake",
  runtime = "fake-runtime",
  platform = "openrouter",
  amount = "9.99"
} = {}) {
  return {
    schema_version: "ai-verse-token/0.1",
    event_id: id,
    source: {
      runtime,
      source_type: "test",
      source_record_id: id,
      source_platform: platform
    },
    observed_at: "2026-09-12T12:00:00Z",
    identity: {
      billing_platform: platform,
      inference_provider: "test-provider",
      requested_model: "test-model",
      resolved_model: "test-model"
    },
    usage: { input_tokens: 1, output_tokens: 1 },
    timing: { started_at: "2026-09-12T11:59:59Z" },
    actual_charge: {
      amount,
      currency: "USD",
      source: "provider_reported",
      external_charge_id: id,
      reported_at: "2026-09-12T12:00:00Z"
    },
    provenance: {
      collector_id: collectorId,
      collector_version: "1.0.0",
      source_record_fingerprint: `fingerprint-${id}-1234567890`,
      usage_quality: "provider_reported",
      timing_quality: "provider_reported",
      content_stored: false
    }
  };
}

function openRouterRecord(id = "gen-wsa-024") {
  return {
    data: {
      id,
      total_cost: 0.0125,
      created_at: "2026-09-12T10:00:00Z",
      model: "anthropic/claude-sonnet-5",
      request_id: `req-${id}`,
      native_tokens_prompt: 10,
      native_tokens_completion: 5
    }
  };
}

function commandCodeRecord(id = "usage-wsa-024") {
  return {
    id,
    createdAt: "2026-09-12T11:00:00Z",
    modelId: "z-ai/glm-5.3-flash",
    tokens: { input: 4, output: 3 },
    costUsd: 0.00042
  };
}

test("WSA-2026-024 plain ledger callers cannot self-assert ACTUAL monetary truth", () => {
  const { dir, ledger } = tempLedger();
  try {
    assert.throws(
      () => ledger.ingestUsageEvent(plainEvent()),
      (error) => error instanceof TokenLedgerError && error.code === "ACTUAL_CHARGE_UNTRUSTED"
    );
    assert.equal(ledger.queryUsage().events.length, 0);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WSA-2026-024 public registry normalization alone does not grant canonical ledger authority", () => {
  const { dir, ledger } = tempLedger();
  try {
    const base = plainEvent({
      id: "evt-public-registry",
      collectorId: "caller",
      runtime: "hermes",
      platform: "openrouter"
    });
    delete base.actual_charge;
    const attached = createDefaultActualCostSourceRegistry().attach(base, {
      source_id: "openrouter-generation-api",
      amount: "1.25",
      currency: "USD",
      external_charge_id: "external-public-registry"
    });

    assert.throws(
      () => ledger.ingestUsageEvent(attached.event),
      (error) => error instanceof TokenLedgerError && error.code === "ACTUAL_CHARGE_UNTRUSTED"
    );
    assert.equal(ledger.queryUsage().events.length, 0);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WSA-2026-024 arbitrary collectors cannot emit ACTUAL and advance canonical state", async () => {
  const { dir, ledger } = tempLedger();
  const collector = {
    definition: { id: "fake", version: "1.0.0", runtimes: ["fake-runtime"] },
    detect() {
      return { status: "available", code: "SOURCE_READY" };
    },
    collect() {
      return {
        emissions: [{
          event: plainEvent({ id: "evt-forged-collector" }),
          checkpoint_cursor: "cursor-forged"
        }],
        complete: true
      };
    }
  };

  try {
    const runner = new CollectorRunner(new CollectorRegistry([collector]));
    await assert.rejects(
      runner.run({ collector_id: "fake", source: {}, ledger }),
      (error) => error instanceof CollectorExecutionError
        && error.code === "COLLECTOR_FAILED"
        && error.cause instanceof TokenLedgerError
        && error.cause.code === "ACTUAL_CHARGE_UNTRUSTED"
    );
    assert.equal(ledger.queryUsage().events.length, 0);
    assert.equal(ledger.collectorCheckpoint("fake"), null);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WSA-2026-024 OpenRouter and Command Code trusted adapters retain canonical ACTUAL admission", () => {
  const { dir, ledger } = tempLedger();
  try {
    const openrouter = normalizeOpenRouterGeneration(openRouterRecord()).event;
    const commandcode = normalizeCommandCodeUsageRecord(commandCodeRecord()).event;

    assert.equal(ledger.ingestUsageEvent(openrouter).status, "inserted");
    assert.equal(ledger.ingestUsageEvent(commandcode).status, "inserted");

    const events = ledger.queryUsage().events;
    assert.equal(events.length, 2);
    assert.equal(events.find((event) => event.event_id === openrouter.event_id)?.actual_charge?.amount, "0.0125");
    assert.equal(events.find((event) => event.event_id === commandcode.event_id)?.actual_charge?.amount, "0.00042");
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WSA-2026-024 trusted admission is exact-event and non-serializable", () => {
  {
    const { dir, ledger } = tempLedger("token-actual-clone-");
    try {
      const trusted = normalizeOpenRouterGeneration(openRouterRecord("gen-clone")).event;
      const clone = JSON.parse(JSON.stringify(trusted));
      assert.throws(
        () => ledger.ingestUsageEvent(clone),
        (error) => error instanceof TokenLedgerError && error.code === "ACTUAL_CHARGE_UNTRUSTED"
      );
      assert.equal(ledger.queryUsage().events.length, 0);
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  {
    const { dir, ledger } = tempLedger("token-actual-mutated-");
    try {
      const trusted = normalizeOpenRouterGeneration(openRouterRecord("gen-mutated")).event;
      trusted.actual_charge.amount = "999";
      assert.throws(
        () => ledger.ingestUsageEvent(trusted),
        (error) => error instanceof TokenLedgerError && error.code === "ACTUAL_CHARGE_UNTRUSTED"
      );
      assert.equal(ledger.queryUsage().events.length, 0);
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("WSA-2026-024 collector normalization preserves only an exact trusted adapter admission", async () => {
  const { dir, ledger } = tempLedger();
  const trusted = normalizeOpenRouterGeneration(openRouterRecord("gen-runner")).event;
  const collector = {
    definition: {
      id: "openrouter-generation-api",
      version: "0.1.0",
      runtimes: ["openrouter"]
    },
    detect() {
      return { status: "available", code: "SOURCE_READY" };
    },
    collect() {
      return {
        emissions: [{ event: trusted, checkpoint_cursor: "cursor-trusted" }],
        complete: true
      };
    }
  };

  try {
    const result = await new CollectorRunner(new CollectorRegistry([collector]))
      .run({ collector_id: "openrouter-generation-api", source: {}, ledger });
    assert.equal(result.inserted, 1);
    assert.equal(result.checkpoint_after, "cursor-trusted");
    assert.equal(ledger.queryUsage().events[0]?.actual_charge?.amount, "0.0125");
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
