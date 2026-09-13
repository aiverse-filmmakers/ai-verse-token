import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  AI_VERSE_EXTENSION_REGISTRY_LOCK_PATH,
  AI_VERSE_EXTENSION_REGISTRY_PATH,
  AI_VERSE_EXTENSION_REGISTRY_SCHEMA,
  AI_VERSE_TOKEN_EXTENSION_ID
} from "./constants.js";
import { assertSafeExistingFile, ensureSafeDirectory, safeRelativePath } from "./paths.js";
import { TokenNativeError, type JsonObject } from "./types.js";

const MAX_REGISTRY_BYTES = 1024 * 1024;

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface RegistrySnapshot {
  readonly exists: boolean;
  readonly raw: string | null;
  readonly document: JsonObject;
  readonly extensions: JsonObject;
}

export function readRegistry(rootPath: string): RegistrySnapshot {
  const path = assertSafeExistingFile(rootPath, AI_VERSE_EXTENSION_REGISTRY_PATH);
  if (!existsSync(path)) return { exists: false, raw: null, document: { schema_version: AI_VERSE_EXTENSION_REGISTRY_SCHEMA, extensions: {} }, extensions: {} };
  const raw = readFileSync(path, "utf8");
  if (raw.length > MAX_REGISTRY_BYTES) throw new TokenNativeError("INVALID_EXTENSION_REGISTRY", "Extension registry exceeds the maximum supported size.");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) { throw new TokenNativeError("INVALID_EXTENSION_REGISTRY", "Extension registry is not valid JSON.", error); }
  if (!object(parsed)) throw new TokenNativeError("INVALID_EXTENSION_REGISTRY", "Extension registry must be a JSON object.");
  if (parsed.schema_version !== AI_VERSE_EXTENSION_REGISTRY_SCHEMA) throw new TokenNativeError("UNSUPPORTED_EXTENSION_REGISTRY_SCHEMA", `Extension registry schema must be ${AI_VERSE_EXTENSION_REGISTRY_SCHEMA}.`);
  if (!object(parsed.extensions)) throw new TokenNativeError("INVALID_EXTENSION_REGISTRY", "Extension registry extensions must be an object.");
  return { exists: true, raw, document: parsed, extensions: parsed.extensions };
}

export function currentTokenEntry(extensions: JsonObject): JsonObject | null {
  const value = extensions[AI_VERSE_TOKEN_EXTENSION_ID];
  if (value === undefined) return null;
  if (!object(value)) throw new TokenNativeError("INVALID_EXISTING_EXTENSION_ENTRY", "Existing ai-verse-token registry entry must be an object.");
  if (value.id !== undefined && value.id !== AI_VERSE_TOKEN_EXTENSION_ID) throw new TokenNativeError("INVALID_EXISTING_EXTENSION_ENTRY", "Existing ai-verse-token entry has a conflicting id.");
  for (const key of ["supported", "installed", "enabled"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") throw new TokenNativeError("INVALID_EXISTING_EXTENSION_ENTRY", `Existing ai-verse-token '${key}' must be boolean.`);
  }
  return value;
}

export function withRegistryLock<T>(rootPath: string, operation: () => T): T {
  ensureSafeDirectory(rootPath, ".aiverse/extensions");
  const lockPath = safeRelativePath(rootPath, AI_VERSE_EXTENSION_REGISTRY_LOCK_PATH);
  try {
    writeFileSync(lockPath, JSON.stringify({ extension: AI_VERSE_TOKEN_EXTENSION_ID, pid: "local" }), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code ?? "")
      : "";
    if (code === "EEXIST") {
      throw new TokenNativeError("EXTENSION_REGISTRY_BUSY", "Extension registry lock is already held.", error);
    }
    throw new TokenNativeError("EXTENSION_WRITE_FAILED", "Extension registry lock could not be created.", error);
  }
  try { return operation(); }
  finally {
    try { unlinkSync(lockPath); } catch { /* preserve primary result/error */ }
  }
}

export function writeRegistryAtomic(rootPath: string, snapshot: RegistrySnapshot, document: JsonObject): void {
  ensureSafeDirectory(rootPath, ".aiverse/extensions");
  const path = safeRelativePath(rootPath, AI_VERSE_EXTENSION_REGISTRY_PATH);
  const currentExists = existsSync(path);
  const currentRaw = currentExists ? readFileSync(path, "utf8") : null;
  if (currentExists !== snapshot.exists || currentRaw !== snapshot.raw) throw new TokenNativeError("EXTENSION_REGISTRY_CHANGED", "Extension registry changed after it was read; refusing a lost update.");
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temp, path);
  } catch (error) {
    try { if (existsSync(temp)) unlinkSync(temp); } catch { /* preserve primary error */ }
    if (error instanceof TokenNativeError) throw error;
    throw new TokenNativeError("EXTENSION_WRITE_FAILED", "Failed to atomically update extension registry.", error);
  }
}
