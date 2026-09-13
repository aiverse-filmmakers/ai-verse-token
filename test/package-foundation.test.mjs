import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import {
  COST_STATUSES,
  EXTENSION_ID,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PROTOCOL_VERSION,
  getBuildIdentity
} from "../dist/src/index.js";

const cli = new URL("../bin/ai-verse-token.mjs", import.meta.url);

test("exports stable package identity", () => {
  assert.equal(PACKAGE_NAME, "@ai-verse/token");
  assert.equal(PACKAGE_VERSION, "0.1.0-beta.1");
  assert.equal(EXTENSION_ID, "ai-verse-token");
  assert.equal(PROTOCOL_VERSION, "ai-verse-token/0.1");
  assert.deepEqual(COST_STATUSES, ["ACTUAL", "CALCULATED", "UNKNOWN"]);
  assert.deepEqual(getBuildIdentity(), {
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    extensionId: EXTENSION_ID,
    protocolVersion: PROTOCOL_VERSION
  });
});

test("CLI help advertises implemented read and native lifecycle surfaces", () => {
  const output = execFileSync(process.execPath, [cli.pathname, "--help"], { encoding: "utf8" });
  assert.match(output, /AI-Verse Token 0\.1\.0-beta\.1/);
  assert.match(output, /Usage:/);
  assert.match(output, /summary --db/);
  assert.match(output, /query --db/);
  assert.match(output, /export --db/);
  assert.match(output, /privacy-safe by default/);
  assert.match(output, /install --root/);
  assert.match(output, /setup --root/);
  assert.match(output, /collect --root/);
  assert.match(output, /prices sync --root/);
  assert.match(output, /usage --root/);
  assert.match(output, /doctor --root/);
  assert.match(output, /UNKNOWN cost is never converted to zero/);
  assert.match(output, /state survives uninstall/);
  assert.doesNotMatch(output, /scan completed|cost calculated|ledger opened/i);
});

test("CLI version reports package version", () => {
  const output = execFileSync(process.execPath, [cli.pathname, "--version"], { encoding: "utf8" });
  assert.equal(output.trim(), PACKAGE_VERSION);
});

test("unknown CLI input fails with usage exit code", () => {
  const result = spawnSync(process.execPath, [cli.pathname, "scan"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown command or option: scan/);
  assert.equal(result.stdout, "");
});
