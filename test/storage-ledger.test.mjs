import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  TOKEN_LEDGER_APPLICATION_ID,
  TOKEN_LEDGER_FORMAT,
  TOKEN_LEDGER_FORMAT_VERSION,
  TokenLedgerError,
  openTokenLedger
} from "../dist/src/storage/index.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ai-verse-token-storage-"));
  return { root, dbPath: join(root, "token.sqlite") };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

test("creates a versioned WAL ledger and reopens it", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    const diagnostics = ledger.diagnostics();
    assert.equal(diagnostics.journalMode, "wal");
    assert.equal(diagnostics.foreignKeys, true);
    assert.equal(diagnostics.applicationId, TOKEN_LEDGER_APPLICATION_ID);
    assert.equal(diagnostics.userVersion, TOKEN_LEDGER_FORMAT_VERSION);
    assert.equal(diagnostics.metadata.format, TOKEN_LEDGER_FORMAT);
    assert.equal(diagnostics.metadata.protocolVersion, "ai-verse-token/0.1");
    assert.equal(ledger.integrityCheck().ok, true);
    ledger.close();

    const reopened = openTokenLedger({ path: dbPath, mode: "open-existing" });
    assert.equal(reopened.metadata().formatVersion, TOKEN_LEDGER_FORMAT_VERSION);
    assert.equal(reopened.integrityCheck("full").ok, true);
    reopened.close();
  } finally {
    cleanup(root);
  }
});

test("read-only open does not mutate and refuses writes", () => {
  const { root, dbPath } = fixture();
  try {
    const writer = openTokenLedger({ path: dbPath });
    writer.close();

    const before = new DatabaseSync(dbPath, { readOnly: true });
    const createdAtBefore = before.prepare("SELECT value FROM token_metadata WHERE key='created_at'").get().value;
    before.close();

    const reader = openTokenLedger({ path: dbPath, mode: "read-only" });
    assert.equal(reader.readOnly, true);
    assert.equal(reader.diagnostics().journalMode, "wal");
    reader.close();

    const after = new DatabaseSync(dbPath, { readOnly: true });
    const createdAtAfter = after.prepare("SELECT value FROM token_metadata WHERE key='created_at'").get().value;
    after.close();
    assert.equal(createdAtAfter, createdAtBefore);
  } finally {
    cleanup(root);
  }
});

test("refuses missing existing/read-only ledgers instead of creating them", () => {
  const { root, dbPath } = fixture();
  try {
    assert.throws(
      () => openTokenLedger({ path: dbPath, mode: "open-existing" }),
      (error) => error instanceof TokenLedgerError && error.code === "NOT_FOUND"
    );
    assert.throws(
      () => openTokenLedger({ path: dbPath, mode: "read-only" }),
      (error) => error instanceof TokenLedgerError && error.code === "NOT_FOUND"
    );
  } finally {
    cleanup(root);
  }
});

test("refuses a foreign non-empty SQLite database", () => {
  const { root, dbPath } = fixture();
  try {
    const foreign = new DatabaseSync(dbPath);
    foreign.exec("CREATE TABLE unrelated(id INTEGER PRIMARY KEY, value TEXT);");
    foreign.close();

    assert.throws(
      () => openTokenLedger({ path: dbPath }),
      (error) => error instanceof TokenLedgerError && error.code === "FOREIGN_DATABASE"
    );
  } finally {
    cleanup(root);
  }
});

test("refuses ledger metadata/version tampering", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    ledger.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA user_version = 999;");
    raw.close();

    assert.throws(
      () => openTokenLedger({ path: dbPath, mode: "open-existing" }),
      (error) => error instanceof TokenLedgerError && error.code === "VERSION_UNSUPPORTED"
    );
  } finally {
    cleanup(root);
  }
});

test("storage schema has no prompt, response, secret or credential columns", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    ledger.close();
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    const schema = raw.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all()
      .map((row) => row.sql)
      .join("\n")
      .toLowerCase();
    raw.close();
    for (const forbidden of ["prompt", "response", "api_key", "credential", "secret"]) {
      assert.equal(schema.includes(forbidden), false, `schema must not contain ${forbidden}`);
    }
  } finally {
    cleanup(root);
  }
});

test("content_stored invariant is enforced by SQLite itself", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    ledger.close();
    const raw = new DatabaseSync(dbPath);
    const columns = raw.prepare("PRAGMA table_info(usage_events)").all();
    const contentColumn = columns.find((column) => column.name === "content_stored");
    assert.equal(contentColumn?.dflt_value, "0");
    const schema = raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='usage_events'").get().sql;
    assert.match(schema, /CHECK \(content_stored = 0\)/);
    raw.close();
  } finally {
    cleanup(root);
  }
});

test("close is idempotent and operations after close fail closed", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    ledger.close();
    ledger.close();
    assert.throws(
      () => ledger.metadata(),
      (error) => error instanceof TokenLedgerError && error.code === "CLOSED"
    );
  } finally {
    cleanup(root);
  }
});


test("refuses a symlinked final ledger path", (t) => {
  const { root, dbPath } = fixture();
  const target = join(root, "real.sqlite");
  try {
    const ledger = openTokenLedger({ path: target });
    ledger.close();
    try {
      symlinkSync(target, dbPath);
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        t.skip("Host does not permit file symlinks");
        return;
      }
      throw error;
    }
    assert.throws(
      () => openTokenLedger({ path: dbPath, mode: "open-existing" }),
      (error) => error instanceof TokenLedgerError && error.code === "PATH_INVALID"
    );
  } finally {
    cleanup(root);
  }
});

test("same-named weakened immutable trigger is detected as schema tampering", () => {
  const { root, dbPath } = fixture();
  try {
    const ledger = openTokenLedger({ path: dbPath });
    ledger.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      DROP TRIGGER usage_events_no_update;
      CREATE TRIGGER usage_events_no_update BEFORE UPDATE ON usage_events BEGIN SELECT 1; END;
    `);
    raw.close();
    assert.throws(
      () => openTokenLedger({ path: dbPath, mode: "open-existing" }),
      (error) => error instanceof TokenLedgerError && error.code === "FORMAT_MISMATCH"
    );
  } finally {
    cleanup(root);
  }
});
