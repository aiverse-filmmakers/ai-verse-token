import { existsSync } from "node:fs";
import { openTokenLedger } from "../storage/index.js";
import { AI_VERSE_TOKEN_LEDGER_PATH } from "./constants.js";
import { inspectAiVerseOs } from "./compatibility.js";
import { tokenMaterialized } from "./materialization.js";
import { safeRelativePath } from "./paths.js";
import { currentTokenEntry, readRegistry } from "./registry.js";
import type { TokenNativeRegistrationStatus, TokenNativeStatusResult } from "./types.js";

function next(code: string): string {
  switch (code) {
    case "NOT_INSTALLED": return "Run ai-verse-token install --root <os-root>.";
    case "MATERIALIZATION_MISMATCH": return "Run ai-verse-token update --root <os-root>.";
    case "LEDGER_UNHEALTHY": return "Preserve the ledger, inspect the reported integrity/format problem, and recover from a verified copy if needed.";
    default: return "Fix the reported AI-Verse host or registry problem and retry.";
  }
}

export function inspectTokenNative(rootPath: string, deep = false): TokenNativeStatusResult {
  const command = deep ? "doctor" : "status";
  const host = inspectAiVerseOs(rootPath);
  const problems: Array<{ code: string; message: string; next_step: string }> = [];
  const notices: Array<{ code: string; message: string }> = [];
  if (host.status === "no-os") {
    notices.push({ code: "STANDALONE_MODE", message: "No AI-Verse OS detected. AI-Verse Token can operate in standalone mode." });
    return { command, healthy: true, mode: "standalone", root_path: host.root_path, host, registration: null, materialized: null, state_path: null, ledger_exists: null, ledger_integrity: deep ? { checked: false, ok: null, details: [] } : null, problems, notices };
  }
  if (host.status === "incompatible") {
    problems.push({ code: "INCOMPATIBLE_AI_VERSE_OS", message: host.issues.map((value) => `${value.code}: ${value.message}`).join("; "), next_step: next("INCOMPATIBLE_AI_VERSE_OS") });
    return { command, healthy: false, mode: "incompatible", root_path: host.root_path, host, registration: null, materialized: null, state_path: null, ledger_exists: null, ledger_integrity: null, problems, notices };
  }

  let registration: TokenNativeRegistrationStatus;
  try {
    const snapshot = readRegistry(host.root_path);
    const entry = currentTokenEntry(snapshot.extensions);
    registration = entry === null ? {
      registry_exists: snapshot.exists, registered: false, supported: null, installed: null, enabled: null, version: null
    } : {
      registry_exists: snapshot.exists,
      registered: true,
      supported: typeof entry.supported === "boolean" ? entry.supported : null,
      installed: typeof entry.installed === "boolean" ? entry.installed : null,
      enabled: typeof entry.enabled === "boolean" ? entry.enabled : true,
      version: typeof entry.version === "string" ? entry.version : null
    };
  } catch (error) {
    problems.push({ code: "INVALID_EXTENSION_REGISTRY", message: error instanceof Error ? error.message : "Registry is invalid.", next_step: next("INVALID_EXTENSION_REGISTRY") });
    return { command, healthy: false, mode: "ai-verse-os-v2", root_path: host.root_path, host, registration: null, materialized: false, state_path: safeRelativePath(host.root_path, AI_VERSE_TOKEN_LEDGER_PATH), ledger_exists: false, ledger_integrity: null, problems, notices };
  }

  let materialized = false;
  if (!registration.registered || registration.supported !== true || registration.installed !== true) {
    problems.push({ code: "NOT_INSTALLED", message: "ai-verse-token is not registered as supported and installed.", next_step: next("NOT_INSTALLED") });
  } else {
    try { materialized = tokenMaterialized(host.root_path); } catch (error) {
      problems.push({ code: "MATERIALIZATION_MISMATCH", message: error instanceof Error ? error.message : "Installed files are unsafe.", next_step: next("MATERIALIZATION_MISMATCH") });
    }
    if (!materialized) problems.push({ code: "MATERIALIZATION_MISMATCH", message: "ai-verse-token installed files are missing or differ from this package version.", next_step: next("MATERIALIZATION_MISMATCH") });
    if (registration.enabled === false) notices.push({ code: "EXTENSION_DISABLED", message: "ai-verse-token is installed but disabled." });
  }

  const statePath = safeRelativePath(host.root_path, AI_VERSE_TOKEN_LEDGER_PATH);
  const ledgerExists = existsSync(statePath);
  let ledgerIntegrity: TokenNativeStatusResult["ledger_integrity"] = deep ? { checked: false, ok: null, details: [] } : null;
  if (!ledgerExists) notices.push({ code: "LEDGER_NOT_CREATED", message: "No native Token ledger exists yet. Installation never creates usage data by itself." });
  else if (deep) {
    try {
      const ledger = openTokenLedger({ path: statePath, mode: "read-only" });
      try {
        const result = ledger.integrityCheck("quick");
        ledgerIntegrity = { checked: true, ok: result.ok, details: result.details };
        if (!result.ok) problems.push({ code: "LEDGER_UNHEALTHY", message: `Token ledger integrity check failed: ${result.details.join("; ")}`, next_step: next("LEDGER_UNHEALTHY") });
      } finally { ledger.close(); }
    } catch (error) {
      ledgerIntegrity = { checked: true, ok: false, details: [error instanceof Error ? error.message : "Ledger could not be opened."] };
      problems.push({ code: "LEDGER_UNHEALTHY", message: ledgerIntegrity.details.join("; "), next_step: next("LEDGER_UNHEALTHY") });
    }
  }

  return { command, healthy: problems.length === 0, mode: "ai-verse-os-v2", root_path: host.root_path, host, registration, materialized, state_path: statePath, ledger_exists: ledgerExists, ledger_integrity: ledgerIntegrity, problems, notices };
}
