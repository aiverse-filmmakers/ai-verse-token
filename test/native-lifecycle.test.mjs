import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AI_VERSE_EXTENSION_REGISTRY_LOCK_PATH,
  AI_VERSE_EXTENSION_REGISTRY_PATH,
  AI_VERSE_TOKEN_EXTENSION_ENGINE,
  AI_VERSE_TOKEN_EXTENSION_ID,
  AI_VERSE_TOKEN_EXTENSION_INSTRUCTIONS,
  AI_VERSE_TOKEN_EXTENSION_MANIFEST,
  AI_VERSE_TOKEN_LEDGER_PATH,
  disableTokenExtension,
  enableTokenExtension,
  inspectAiVerseOs,
  inspectTokenNative,
  installTokenExtension,
  uninstallTokenExtension,
  updateTokenExtension
} from "../dist/src/native/index.js";
import { openTokenLedger } from "../dist/src/storage/index.js";

function fixture(registry) {
  const root = mkdtempSync(join(tmpdir(), "ai-verse-token-native-"));
  mkdirSync(join(root, "operator"));
  mkdirSync(join(root, "workspaces"));
  mkdirSync(join(root, "system", "extensions"), { recursive: true });
  writeFileSync(join(root, "AI-VERSE.yaml"), 'schema_version: "2.0"\narchitecture: unified-workspace\n');
  writeFileSync(join(root, "AGENTS.md"), "# runtime\n");
  writeFileSync(join(root, "system", "extensions", "README.md"), "Local registry: `/.aiverse/extensions/registry.json`\n");
  if (registry !== undefined) {
    mkdirSync(join(root, ".aiverse", "extensions"), { recursive: true });
    writeFileSync(join(root, AI_VERSE_EXTENSION_REGISTRY_PATH), `${JSON.stringify(registry, null, 2)}\n`);
  }
  return root;
}

function tracked(root) {
  return {
    manifest: readFileSync(join(root, "AI-VERSE.yaml"), "utf8"),
    agents: readFileSync(join(root, "AGENTS.md"), "utf8"),
    contract: readFileSync(join(root, "system", "extensions", "README.md"), "utf8")
  };
}

function registry(root) {
  return JSON.parse(readFileSync(join(root, AI_VERSE_EXTENSION_REGISTRY_PATH), "utf8"));
}

function cleanup(root) { rmSync(root, { recursive: true, force: true }); }

test("detects the current AI-Verse OS v2 extension contract", () => {
  const root = fixture();
  try {
    const result = inspectAiVerseOs(root);
    assert.equal(result.status, "compatible");
    assert.equal(result.schema_major, 2);
    assert.equal(result.architecture, "unified-workspace");
  } finally { cleanup(root); }
});

test("status and doctor report standalone mode without masking an AI-Verse-like broken host", () => {
  const standalone = mkdtempSync(join(tmpdir(), "token-standalone-"));
  const broken = mkdtempSync(join(tmpdir(), "token-broken-os-"));
  try {
    assert.equal(inspectTokenNative(standalone).mode, "standalone");
    assert.equal(inspectTokenNative(standalone, true).healthy, true);
    mkdirSync(join(broken, "system", "extensions"), { recursive: true });
    writeFileSync(join(broken, "system", "extensions", "README.md"), "registry");
    const result = inspectTokenNative(broken);
    assert.equal(result.mode, "incompatible");
    assert.equal(result.healthy, false);
  } finally { cleanup(standalone); cleanup(broken); }
});

test("install materializes only Token-owned local extension files and preserves tracked OS bytes", () => {
  const root = fixture();
  const before = tracked(root);
  try {
    const result = installTokenExtension(root);
    assert.equal(result.status, "installed");
    assert.equal(result.state_preserved, true);
    assert.deepEqual(result.tracked_os_files_mutated, []);
    assert.deepEqual(tracked(root), before);
    for (const path of [AI_VERSE_TOKEN_EXTENSION_INSTRUCTIONS, AI_VERSE_TOKEN_EXTENSION_ENGINE, AI_VERSE_TOKEN_EXTENSION_MANIFEST]) {
      assert.equal(existsSync(join(root, path)), true);
    }
    const entry = registry(root).extensions[AI_VERSE_TOKEN_EXTENSION_ID];
    assert.equal(entry.supported, true);
    assert.equal(entry.installed, true);
    assert.equal(entry.enabled, true);
  } finally { cleanup(root); }
});

test("install/update preserve unknown registry fields, sibling entries and disabled state", () => {
  const root = fixture({
    schema_version: "1.0",
    custom_top: { keep: [1, 2, 3] },
    extensions: {
      "ai-verse-memory": { id: "ai-verse-memory", supported: true, installed: true, enabled: false, custom: "sibling" },
      "ai-verse-token": { id: "ai-verse-token", supported: true, installed: true, enabled: false, future_field: { keep: true } }
    }
  });
  try {
    installTokenExtension(root);
    const afterInstall = registry(root);
    assert.deepEqual(afterInstall.custom_top, { keep: [1, 2, 3] });
    assert.equal(afterInstall.extensions["ai-verse-memory"].custom, "sibling");
    assert.equal(afterInstall.extensions[AI_VERSE_TOKEN_EXTENSION_ID].enabled, false);
    assert.deepEqual(afterInstall.extensions[AI_VERSE_TOKEN_EXTENSION_ID].future_field, { keep: true });
    const updated = updateTokenExtension(root);
    assert.equal(updated.status, "unchanged");
    assert.equal(updated.enabled, false);
  } finally { cleanup(root); }
});

test("enable/disable change only Token enabled state", () => {
  const root = fixture({ schema_version: "1.0", unknown: 9, extensions: { sibling: { id: "sibling", enabled: false, nested: { keep: true } } } });
  try {
    installTokenExtension(root);
    assert.equal(disableTokenExtension(root).status, "disabled");
    let doc = registry(root);
    assert.equal(doc.extensions[AI_VERSE_TOKEN_EXTENSION_ID].enabled, false);
    assert.deepEqual(doc.extensions.sibling, { id: "sibling", enabled: false, nested: { keep: true } });
    assert.equal(doc.unknown, 9);
    assert.equal(enableTokenExtension(root).status, "enabled");
    doc = registry(root);
    assert.equal(doc.extensions[AI_VERSE_TOKEN_EXTENSION_ID].enabled, true);
    assert.deepEqual(doc.extensions.sibling, { id: "sibling", enabled: false, nested: { keep: true } });
  } finally { cleanup(root); }
});

test("registry lock contention fails before materialization", () => {
  const root = fixture({ schema_version: "1.0", extensions: {} });
  try {
    writeFileSync(join(root, AI_VERSE_EXTENSION_REGISTRY_LOCK_PATH), "busy");
    assert.throws(() => installTokenExtension(root), (error) => error?.code === "EXTENSION_REGISTRY_BUSY");
    assert.equal(existsSync(join(root, AI_VERSE_TOKEN_EXTENSION_INSTRUCTIONS)), false);
  } finally { cleanup(root); }
});

test("malformed registry fails closed without replacing it", () => {
  const root = fixture();
  mkdirSync(join(root, ".aiverse", "extensions"), { recursive: true });
  const path = join(root, AI_VERSE_EXTENSION_REGISTRY_PATH);
  writeFileSync(path, "{ definitely-not-json\n");
  const before = readFileSync(path, "utf8");
  try {
    assert.throws(() => installTokenExtension(root), (error) => error?.code === "INVALID_EXTENSION_REGISTRY");
    assert.equal(readFileSync(path, "utf8"), before);
  } finally { cleanup(root); }
});

test("symlinked extension directory is rejected", (t) => {
  const root = fixture();
  const outside = mkdtempSync(join(tmpdir(), "token-outside-"));
  try {
    mkdirSync(join(root, ".aiverse"));
    try {
      symlinkSync(outside, join(root, ".aiverse", "extensions"), "dir");
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") { t.skip("Host does not permit directory symlinks"); return; }
      throw error;
    }
    assert.throws(() => installTokenExtension(root), (error) => error?.code === "SYMLINK_PATH_REJECTED");
    assert.equal(existsSync(join(outside, "registry.json")), false);
  } finally { cleanup(root); cleanup(outside); }
});

test("uninstall preserves the native Token ledger byte-for-byte and removes only owned registration/files", () => {
  const root = fixture({ schema_version: "1.0", top_unknown: "keep", extensions: { sibling: { id: "sibling", keep: 7 } } });
  try {
    installTokenExtension(root);
    const ledgerPath = join(root, AI_VERSE_TOKEN_LEDGER_PATH);
    mkdirSync(join(root, ".aiverse", "extensions", "ai-verse-token", "state"), { recursive: true });
    const ledger = openTokenLedger({ path: ledgerPath, mode: "create-or-open" });
    ledger.close();
    const before = readFileSync(ledgerPath);
    const result = uninstallTokenExtension(root);
    assert.equal(result.status, "uninstalled");
    assert.equal(existsSync(ledgerPath), true);
    assert.deepEqual(readFileSync(ledgerPath), before);
    assert.equal(existsSync(join(root, AI_VERSE_TOKEN_EXTENSION_INSTRUCTIONS)), false);
    assert.equal(existsSync(join(root, AI_VERSE_TOKEN_EXTENSION_ENGINE)), false);
    assert.equal(existsSync(join(root, AI_VERSE_TOKEN_EXTENSION_MANIFEST)), false);
    const doc = registry(root);
    assert.equal(doc.extensions[AI_VERSE_TOKEN_EXTENSION_ID], undefined);
    assert.deepEqual(doc.extensions.sibling, { id: "sibling", keep: 7 });
    assert.equal(doc.top_unknown, "keep");
  } finally { cleanup(root); }
});

test("doctor checks a native ledger read-only and disable is a notice rather than corruption", () => {
  const root = fixture();
  try {
    installTokenExtension(root);
    const ledgerPath = join(root, AI_VERSE_TOKEN_LEDGER_PATH);
    mkdirSync(join(root, ".aiverse", "extensions", "ai-verse-token", "state"), { recursive: true });
    const ledger = openTokenLedger({ path: ledgerPath });
    ledger.close();
    const before = readFileSync(ledgerPath);
    let result = inspectTokenNative(root, true);
    assert.equal(result.healthy, true);
    assert.deepEqual(result.ledger_integrity, { checked: true, ok: true, details: ["ok"] });
    assert.deepEqual(readFileSync(ledgerPath), before);
    disableTokenExtension(root);
    result = inspectTokenNative(root, true);
    assert.equal(result.healthy, true);
    assert.equal(result.notices.some((notice) => notice.code === "EXTENSION_DISABLED"), true);
  } finally { cleanup(root); }
});

test("doctor reports malformed native ledger without modifying it", () => {
  const root = fixture();
  try {
    installTokenExtension(root);
    const ledgerPath = join(root, AI_VERSE_TOKEN_LEDGER_PATH);
    mkdirSync(join(root, ".aiverse", "extensions", "ai-verse-token", "state"), { recursive: true });
    writeFileSync(ledgerPath, "not sqlite and must survive");
    const before = readFileSync(ledgerPath);
    const result = inspectTokenNative(root, true);
    assert.equal(result.healthy, false);
    assert.equal(result.problems.some((problem) => problem.code === "LEDGER_UNHEALTHY"), true);
    assert.deepEqual(readFileSync(ledgerPath), before);
  } finally { cleanup(root); }
});

test("native CLI install/status/disable/enable/uninstall has stable JSON behavior", () => {
  const root = fixture();
  const cli = new URL("../bin/ai-verse-token.mjs", import.meta.url);
  try {
    const installed = JSON.parse(execFileSync(process.execPath, [cli.pathname, "install", "--root", root, "--json"], { encoding: "utf8" }));
    assert.equal(installed.status, "installed");
    const status = JSON.parse(execFileSync(process.execPath, [cli.pathname, "status", "--root", root, "--json"], { encoding: "utf8" }));
    assert.equal(status.state, "setup-required");
    assert.equal(status.ready, false);
    assert.equal(status.installed, true);
    execFileSync(process.execPath, [cli.pathname, "disable", "--root", root, "--json"], { encoding: "utf8" });
    execFileSync(process.execPath, [cli.pathname, "enable", "--root", root, "--json"], { encoding: "utf8" });
    const removed = JSON.parse(execFileSync(process.execPath, [cli.pathname, "uninstall", "--root", root, "--json"], { encoding: "utf8" }));
    assert.equal(removed.status, "uninstalled");
  } finally { cleanup(root); }
});

test("install creates no telemetry ledger or state directory", () => {
  const root = fixture();
  try {
    installTokenExtension(root);
    assert.equal(existsSync(join(root, AI_VERSE_TOKEN_LEDGER_PATH)), false);
    assert.equal(existsSync(join(root, ".aiverse", "extensions", "ai-verse-token", "state")), false);
  } finally { cleanup(root); }
});

test("unsupported registry schema and incompatible OS fail before Token-owned mutation", async () => {
  const root = fixture({ schema_version: "9.0", extensions: {} });
  const incompatible = fixture();
  try {
    assert.throws(() => installTokenExtension(root), (error) => error?.code === "UNSUPPORTED_EXTENSION_REGISTRY_SCHEMA");
    assert.equal(existsSync(join(root, AI_VERSE_TOKEN_EXTENSION_INSTRUCTIONS)), false);
    writeFileSync(join(incompatible, "AI-VERSE.yaml"), 'schema_version: "3.0"\narchitecture: unified-workspace\n');
    assert.throws(() => installTokenExtension(incompatible), (error) => error?.code === "INCOMPATIBLE_AI_VERSE_OS");
    assert.equal(existsSync(join(incompatible, ".aiverse")), false);
  } finally { cleanup(root); cleanup(incompatible); }
});

test("atomic registry write rejects a stale snapshot instead of losing a competing update", async () => {
  const root = fixture({ schema_version: "1.0", extensions: {}, marker: "first" });
  try {
    const { readRegistry, writeRegistryAtomic } = await import("../dist/src/native/registry.js");
    const snapshot = readRegistry(root);
    writeFileSync(join(root, AI_VERSE_EXTENSION_REGISTRY_PATH), `${JSON.stringify({ schema_version: "1.0", extensions: {}, marker: "second" }, null, 2)}\n`);
    assert.throws(
      () => writeRegistryAtomic(root, snapshot, { ...snapshot.document, marker: "token-write" }),
      (error) => error?.code === "EXTENSION_REGISTRY_CHANGED"
    );
    assert.equal(registry(root).marker, "second");
  } finally { cleanup(root); }
});

test("update repairs Token-owned materialization while preserving existing ledger bytes", () => {
  const root = fixture();
  try {
    installTokenExtension(root);
    const ledgerPath = join(root, AI_VERSE_TOKEN_LEDGER_PATH);
    mkdirSync(join(root, ".aiverse", "extensions", "ai-verse-token", "state"), { recursive: true });
    const ledger = openTokenLedger({ path: ledgerPath });
    ledger.close();
    const before = readFileSync(ledgerPath);
    writeFileSync(join(root, AI_VERSE_TOKEN_EXTENSION_INSTRUCTIONS), "tampered\n");
    const result = updateTokenExtension(root);
    assert.equal(result.status, "updated");
    assert.equal(readFileSync(join(root, AI_VERSE_TOKEN_EXTENSION_INSTRUCTIONS), "utf8").includes("canonical usage"), true);
    assert.deepEqual(readFileSync(ledgerPath), before);
  } finally { cleanup(root); }
});

test("dangling symlink at a Token-owned file path is rejected as unsafe rather than treated as missing", (t) => {
  const root = fixture();
  try {
    const extensionRoot = join(root, ".aiverse", "extensions", "ai-verse-token");
    mkdirSync(extensionRoot, { recursive: true });
    const instructionPath = join(root, AI_VERSE_TOKEN_EXTENSION_INSTRUCTIONS);
    try {
      symlinkSync(join(root, "does-not-exist.md"), instructionPath);
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        t.skip("Host does not permit file symlinks");
        return;
      }
      throw error;
    }
    assert.throws(
      () => installTokenExtension(root),
      (error) => error?.code === "SYMLINK_PATH_REJECTED"
    );
    assert.equal(existsSync(join(root, AI_VERSE_TOKEN_EXTENSION_ENGINE)), false);
    assert.equal(existsSync(join(root, AI_VERSE_TOKEN_EXTENSION_MANIFEST)), false);
    assert.equal(existsSync(join(root, AI_VERSE_EXTENSION_REGISTRY_PATH)), false);
  } finally {
    cleanup(root);
  }
});
