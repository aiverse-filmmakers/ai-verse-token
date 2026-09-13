import { existsSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  AI_VERSE_TOKEN_EXTENSION_ENGINE,
  AI_VERSE_TOKEN_EXTENSION_ID,
  AI_VERSE_TOKEN_EXTENSION_INSTRUCTIONS,
  AI_VERSE_TOKEN_EXTENSION_MANIFEST,
  AI_VERSE_TOKEN_EXTENSION_ROOT,
  AI_VERSE_TOKEN_EXTENSION_SOURCE,
  AI_VERSE_TOKEN_EXTENSION_VERSION,
  AI_VERSE_TOKEN_LEDGER_PATH
} from "./constants.js";
import { assertSafeExistingFile, ensureSafeDirectory, safeRelativePath } from "./paths.js";
import { TokenNativeError } from "./types.js";

export const TOKEN_OWNED_FILES = [
  AI_VERSE_TOKEN_EXTENSION_INSTRUCTIONS,
  AI_VERSE_TOKEN_EXTENSION_ENGINE,
  AI_VERSE_TOKEN_EXTENSION_MANIFEST
] as const;

export interface TokenOwnedFileSnapshot {
  readonly relativePath: string;
  readonly existed: boolean;
  readonly contents: string | null;
}

export function captureTokenOwnedFiles(rootPath: string): readonly TokenOwnedFileSnapshot[] {
  return Object.freeze(TOKEN_OWNED_FILES.map((relativePath) => {
    const path = assertSafeExistingFile(rootPath, relativePath);
    const existed = existsSync(path);
    return Object.freeze({
      relativePath,
      existed,
      contents: existed ? readFileSync(path, "utf8") : null
    });
  }));
}

export function restoreTokenOwnedFiles(rootPath: string, snapshot: readonly TokenOwnedFileSnapshot[]): void {
  for (const item of snapshot) {
    const path = assertSafeExistingFile(rootPath, item.relativePath);
    if (item.existed) {
      writeFileSync(path, item.contents ?? "", { encoding: "utf8" });
    } else if (existsSync(path)) {
      unlinkSync(path);
    }
  }
}

function ownedContents(relativePath: string): string {
  if (relativePath === AI_VERSE_TOKEN_EXTENSION_INSTRUCTIONS) return `# AI-Verse Token Extension\n\nAI-Verse Token is the canonical usage, token, timing and AI-cost telemetry layer for this host.\n\nRules:\n- Treat the Token ledger as Token-owned telemetry truth.\n- Consumers must use the registered engine/package read surfaces and must not open Token SQLite directly.\n- Do not copy prompt or response content into Token.\n- ACTUAL means a trusted provider/runtime reported charge. CALCULATED means exact usage rated against verified pricing. UNKNOWN must never be displayed as zero.\n- Memory may receive explicit evidence/candidates only. Data may reference Token facts but does not own the Token ledger.\n- Missing sibling layers never block Token.\n- The state ledger is user-owned and survives extension uninstall.\n\nNative ledger: \`${AI_VERSE_TOKEN_LEDGER_PATH}\`\n`;
  if (relativePath === AI_VERSE_TOKEN_EXTENSION_ENGINE) return `export const extension = Object.freeze({\n  id: ${JSON.stringify(AI_VERSE_TOKEN_EXTENSION_ID)},\n  version: ${JSON.stringify(AI_VERSE_TOKEN_EXTENSION_VERSION)},\n  package: "@ai-verse/token",\n  readExport: "@ai-verse/token/read",\n  dashboardExport: "@ai-verse/token/read",\n  stateRelativePath: ${JSON.stringify(AI_VERSE_TOKEN_LEDGER_PATH)}\n});\n`;
  return `${JSON.stringify({
    schema_version: "1.0",
    id: AI_VERSE_TOKEN_EXTENSION_ID,
    source: AI_VERSE_TOKEN_EXTENSION_SOURCE,
    version: AI_VERSE_TOKEN_EXTENSION_VERSION,
    package: "@ai-verse/token",
    state: { ledger: AI_VERSE_TOKEN_LEDGER_PATH, ownership: "user", survives_uninstall: true },
    privacy: { prompt_response_content: false }
  }, null, 2)}\n`;
}

function writeAtomic(rootPath: string, relativePath: string, contents: string): boolean {
  const path = assertSafeExistingFile(rootPath, relativePath);
  if (existsSync(path) && readFileSync(path, "utf8") === contents) return false;
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temp, contents, { encoding: "utf8", flag: "wx" });
    renameSync(temp, path);
    return true;
  } catch (error) {
    try { if (existsSync(temp)) unlinkSync(temp); } catch { /* preserve primary error */ }
    throw new TokenNativeError("EXTENSION_WRITE_FAILED", `Failed to materialize '${relativePath}'.`, error);
  }
}

export function materializeTokenExtension(rootPath: string): readonly string[] {
  ensureSafeDirectory(rootPath, AI_VERSE_TOKEN_EXTENSION_ROOT);
  const previous = captureTokenOwnedFiles(rootPath);
  const changed: string[] = [];
  try {
    for (const relativePath of TOKEN_OWNED_FILES) if (writeAtomic(rootPath, relativePath, ownedContents(relativePath))) changed.push(relativePath);
    return changed;
  } catch (error) {
    try { restoreTokenOwnedFiles(rootPath, previous); } catch { /* preserve primary error */ }
    throw error;
  }
}

export function tokenMaterialized(rootPath: string): boolean {
  for (const relativePath of TOKEN_OWNED_FILES) {
    const path = assertSafeExistingFile(rootPath, relativePath);
    if (!existsSync(path) || readFileSync(path, "utf8") !== ownedContents(relativePath)) return false;
  }
  return true;
}

export function removeTokenOwnedFiles(rootPath: string): readonly string[] {
  const previous = captureTokenOwnedFiles(rootPath);
  const removed: string[] = [];
  try {
    for (const relativePath of TOKEN_OWNED_FILES) {
      const path = assertSafeExistingFile(rootPath, relativePath);
      if (existsSync(path)) { unlinkSync(path); removed.push(relativePath); }
    }
    const root = safeRelativePath(rootPath, AI_VERSE_TOKEN_EXTENSION_ROOT);
    if (existsSync(root) && readdirSync(root).length === 0) { rmdirSync(root); removed.push(AI_VERSE_TOKEN_EXTENSION_ROOT); }
    return removed;
  } catch (error) {
    try {
      ensureSafeDirectory(rootPath, AI_VERSE_TOKEN_EXTENSION_ROOT);
      restoreTokenOwnedFiles(rootPath, previous);
    } catch { /* preserve primary error */ }
    throw error;
  }
}
