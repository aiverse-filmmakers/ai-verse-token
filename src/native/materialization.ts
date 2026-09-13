import { cpSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AI_VERSE_TOKEN_EXTENSION_BUNDLE,
  AI_VERSE_TOKEN_EXTENSION_ENGINE,
  AI_VERSE_TOKEN_EXTENSION_ID,
  AI_VERSE_TOKEN_EXTENSION_INSTRUCTIONS,
  AI_VERSE_TOKEN_EXTENSION_MANIFEST,
  AI_VERSE_TOKEN_EXTENSION_ROOT,
  AI_VERSE_TOKEN_EXTENSION_SOURCE,
  AI_VERSE_TOKEN_EXTENSION_VERSION,
  AI_VERSE_TOKEN_LEDGER_PATH,
  AI_VERSE_TOKEN_PRICING_ROOT,
  AI_VERSE_TOKEN_RUNTIME_CONFIG
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
  if (relativePath === AI_VERSE_TOKEN_EXTENSION_INSTRUCTIONS) return `# AI-Verse Token Extension\n\nAI-Verse Token is the canonical usage, token, timing and AI-cost telemetry layer for this host.\n\nRules:\n- Treat the Token ledger as Token-owned telemetry truth.\n- Consumers use Token owner-backed read/projection surfaces and must not open Token SQLite directly.\n- Do not copy prompt or response content into Token.\n- ACTUAL means a trusted provider/runtime reported charge. CALCULATED means exact usage rated against verified pricing. UNKNOWN must never be displayed as zero.\n- Workspace, task, Bot, Worker and Skill IDs are telemetry attribution only. They never grant permission.\n- Gateway/OS supplies read authorization and Token enforces its immutable scope floor.\n- Memory may receive explicit evidence/candidates only. Data may reference Token facts but does not own the Token ledger.\n- The state ledger, runtime config and pricing evidence are user-owned and survive extension uninstall.\n\nNative ledger: \`${AI_VERSE_TOKEN_LEDGER_PATH}\`\nRuntime config: \`${AI_VERSE_TOKEN_RUNTIME_CONFIG}\`\nPricing store: \`${AI_VERSE_TOKEN_PRICING_ROOT}\`\n`;
  if (relativePath === AI_VERSE_TOKEN_EXTENSION_ENGINE) return `const runtime = () => import("./bundle/src/runtime/index.js");\nconst gateway = () => import("./bundle/src/gateway/index.js");\n\nexport const extension = Object.freeze({\n  id: ${JSON.stringify(AI_VERSE_TOKEN_EXTENSION_ID)},\n  version: ${JSON.stringify(AI_VERSE_TOKEN_EXTENSION_VERSION)},\n  package: "@ai-verse/token",\n  stateRelativePath: ${JSON.stringify(AI_VERSE_TOKEN_LEDGER_PATH)},\n  setup: async (root) => (await runtime()).setupTokenRuntime(root),\n  collect: async (root) => (await runtime()).collectTokenUsage(root),\n  doctor: async (root) => (await runtime()).doctorTokenRuntime(root),\n  pricingSync: async (root) => (await runtime()).syncTokenPricing(root),\n  openUsageProjection: async (options) => (await gateway()).openTokenGatewayProjection(options)\n});\n`;
  return `${JSON.stringify({
    schema_version: "1.1",
    id: AI_VERSE_TOKEN_EXTENSION_ID,
    source: AI_VERSE_TOKEN_EXTENSION_SOURCE,
    version: AI_VERSE_TOKEN_EXTENSION_VERSION,
    package: "@ai-verse/token",
    engine: "./engine.mjs",
    bundle: "./bundle/src",
    lifecycle: ["install", "setup", "status", "doctor", "enable", "disable", "update", "uninstall"],
    runtime_operations: ["collect", "pricing-sync", "usage-projection"],
    state: { ledger: AI_VERSE_TOKEN_LEDGER_PATH, runtime_config: AI_VERSE_TOKEN_RUNTIME_CONFIG, pricing: AI_VERSE_TOKEN_PRICING_ROOT, ownership: "user", survives_uninstall: true },
    privacy: { prompt_response_content: false },
    authority: { telemetry_attribution_is_permission: false, read_authorization_owner: "host" }
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

function compiledSourceRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function bundlePackageContents(): string {
  return `${JSON.stringify({ name: "@ai-verse/token-native-bundle", version: AI_VERSE_TOKEN_EXTENSION_VERSION, private: true, type: "module" }, null, 2)}\n`;
}

function bundleHealthy(rootPath: string): boolean {
  const bundle = safeRelativePath(rootPath, AI_VERSE_TOKEN_EXTENSION_BUNDLE);
  const packagePath = `${bundle}/package.json`;
  const runtimePath = `${bundle}/src/runtime/index.js`;
  const gatewayPath = `${bundle}/src/gateway/index.js`;
  if (!existsSync(packagePath) || !existsSync(runtimePath) || !existsSync(gatewayPath)) return false;
  try { return readFileSync(packagePath, "utf8") === bundlePackageContents(); } catch { return false; }
}

function materializeBundle(rootPath: string): boolean {
  if (bundleHealthy(rootPath)) return false;
  const extensionRoot = ensureSafeDirectory(rootPath, AI_VERSE_TOKEN_EXTENSION_ROOT);
  const bundle = safeRelativePath(rootPath, AI_VERSE_TOKEN_EXTENSION_BUNDLE);
  const temp = `${bundle}.tmp-${randomUUID()}`;
  const backup = `${bundle}.bak-${randomUUID()}`;
  const source = compiledSourceRoot();
  try {
    ensureSafeDirectory(extensionRoot, temp.slice(extensionRoot.length + 1));
    cpSync(source, `${temp}/src`, { recursive: true, force: true });
    writeFileSync(`${temp}/package.json`, bundlePackageContents(), { encoding: "utf8", flag: "wx" });
    const hadBundle = existsSync(bundle);
    if (hadBundle) renameSync(bundle, backup);
    try { renameSync(temp, bundle); }
    catch (error) {
      if (hadBundle && existsSync(backup)) renameSync(backup, bundle);
      throw error;
    }
    if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
    return true;
  } catch (error) {
    try { if (existsSync(temp)) rmSync(temp, { recursive: true, force: true }); } catch { /* preserve primary */ }
    throw new TokenNativeError("EXTENSION_WRITE_FAILED", "Failed to materialize durable Token runtime bundle.", error);
  }
}

export function materializeTokenExtension(rootPath: string): readonly string[] {
  ensureSafeDirectory(rootPath, AI_VERSE_TOKEN_EXTENSION_ROOT);
  const previous = captureTokenOwnedFiles(rootPath);
  const changed: string[] = [];
  try {
    for (const relativePath of TOKEN_OWNED_FILES) if (writeAtomic(rootPath, relativePath, ownedContents(relativePath))) changed.push(relativePath);
    if (materializeBundle(rootPath)) changed.push(AI_VERSE_TOKEN_EXTENSION_BUNDLE);
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
  return bundleHealthy(rootPath);
}

export function removeTokenOwnedFiles(rootPath: string): readonly string[] {
  const previous = captureTokenOwnedFiles(rootPath);
  const removed: string[] = [];
  try {
    for (const relativePath of TOKEN_OWNED_FILES) {
      const path = assertSafeExistingFile(rootPath, relativePath);
      if (existsSync(path)) { unlinkSync(path); removed.push(relativePath); }
    }
    const bundle = safeRelativePath(rootPath, AI_VERSE_TOKEN_EXTENSION_BUNDLE);
    if (existsSync(bundle)) { rmSync(bundle, { recursive: true, force: true }); removed.push(AI_VERSE_TOKEN_EXTENSION_BUNDLE); }
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
