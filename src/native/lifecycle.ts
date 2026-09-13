import {
  AI_VERSE_TOKEN_EXTENSION_ENGINE,
  AI_VERSE_TOKEN_EXTENSION_ID,
  AI_VERSE_TOKEN_EXTENSION_INSTRUCTIONS,
  AI_VERSE_TOKEN_EXTENSION_ROOT,
  AI_VERSE_TOKEN_EXTENSION_SOURCE,
  AI_VERSE_TOKEN_EXTENSION_VERSION
} from "./constants.js";
import { inspectAiVerseOs } from "./compatibility.js";
import {
  captureTokenOwnedFiles,
  materializeTokenExtension,
  removeTokenOwnedFiles,
  restoreTokenOwnedFiles
} from "./materialization.js";
import { ensureSafeDirectory } from "./paths.js";
import { currentTokenEntry, readRegistry, withRegistryLock, writeRegistryAtomic } from "./registry.js";
import { TokenNativeError, type JsonObject, type TokenLifecycleCommand, type TokenLifecycleResult } from "./types.js";

function requireCompatible(rootPath: string): string {
  const host = inspectAiVerseOs(rootPath);
  if (host.status === "no-os") throw new TokenNativeError("AI_VERSE_OS_NOT_FOUND", "No compatible AI-Verse OS is present at the requested root.");
  if (host.status !== "compatible") throw new TokenNativeError("INCOMPATIBLE_AI_VERSE_OS", `AI-Verse OS is incompatible: ${host.issues.map((value) => value.code).join(", ")}.`);
  return host.root_path;
}

function entryFrom(current: JsonObject | null): JsonObject {
  return {
    ...(current ?? {}),
    id: AI_VERSE_TOKEN_EXTENSION_ID,
    supported: true,
    installed: true,
    enabled: typeof current?.enabled === "boolean" ? current.enabled : true,
    version: AI_VERSE_TOKEN_EXTENSION_VERSION,
    source: AI_VERSE_TOKEN_EXTENSION_SOURCE,
    instructions: AI_VERSE_TOKEN_EXTENSION_INSTRUCTIONS,
    engine: AI_VERSE_TOKEN_EXTENSION_ENGINE,
    adapters: []
  };
}

function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

function base(command: TokenLifecycleCommand, root_path: string, values: Partial<TokenLifecycleResult>): TokenLifecycleResult {
  return {
    command,
    status: values.status ?? "unchanged",
    root_path,
    registry_written: values.registry_written ?? false,
    materialized_paths: values.materialized_paths ?? [],
    removed_paths: values.removed_paths ?? [],
    enabled: values.enabled ?? null,
    state_preserved: true,
    tracked_os_files_mutated: []
  };
}

function installOrUpdate(command: "install" | "update", rootPath: string): TokenLifecycleResult {
  const root = requireCompatible(rootPath);
  return withRegistryLock(root, () => {
    const snapshot = readRegistry(root);
    const current = currentTokenEntry(snapshot.extensions);
    const next = entryFrom(current);
    const previousFiles = captureTokenOwnedFiles(root);
    let materialized: readonly string[] = [];
    const registryChanged = !same(current, next) || !snapshot.exists;
    try {
      materialized = materializeTokenExtension(root);
      if (registryChanged) {
        writeRegistryAtomic(root, snapshot, { ...snapshot.document, schema_version: "1.0", extensions: { ...snapshot.extensions, [AI_VERSE_TOKEN_EXTENSION_ID]: next } });
      }
    } catch (error) {
      try { restoreTokenOwnedFiles(root, previousFiles); } catch { /* preserve primary error */ }
      throw error;
    }
    const changed = materialized.length > 0 || registryChanged;
    return base(command, root, {
      status: changed ? (current === null ? "installed" : "updated") : "unchanged",
      registry_written: registryChanged,
      materialized_paths: materialized,
      enabled: next.enabled as boolean
    });
  });
}

function setEnabled(command: "enable" | "disable", rootPath: string, enabled: boolean): TokenLifecycleResult {
  const root = requireCompatible(rootPath);
  return withRegistryLock(root, () => {
    const snapshot = readRegistry(root);
    const current = currentTokenEntry(snapshot.extensions);
    if (current === null) throw new TokenNativeError("EXTENSION_NOT_INSTALLED", "ai-verse-token is not installed.");
    if (current.enabled === enabled) return base(command, root, { status: "unchanged", enabled });
    const next = { ...current, id: AI_VERSE_TOKEN_EXTENSION_ID, enabled };
    writeRegistryAtomic(root, snapshot, { ...snapshot.document, extensions: { ...snapshot.extensions, [AI_VERSE_TOKEN_EXTENSION_ID]: next } });
    return base(command, root, { status: enabled ? "enabled" : "disabled", registry_written: true, enabled });
  });
}

export function installTokenExtension(rootPath: string): TokenLifecycleResult { return installOrUpdate("install", rootPath); }
export function updateTokenExtension(rootPath: string): TokenLifecycleResult { return installOrUpdate("update", rootPath); }
export function enableTokenExtension(rootPath: string): TokenLifecycleResult { return setEnabled("enable", rootPath, true); }
export function disableTokenExtension(rootPath: string): TokenLifecycleResult { return setEnabled("disable", rootPath, false); }

export function uninstallTokenExtension(rootPath: string): TokenLifecycleResult {
  const root = requireCompatible(rootPath);
  return withRegistryLock(root, () => {
    const snapshot = readRegistry(root);
    const current = currentTokenEntry(snapshot.extensions);
    if (current === null) return base("uninstall", root, { status: "not-installed" });
    const previousFiles = captureTokenOwnedFiles(root);
    const { [AI_VERSE_TOKEN_EXTENSION_ID]: _removed, ...rest } = snapshot.extensions;
    void _removed;
    const removed = removeTokenOwnedFiles(root);
    try {
      writeRegistryAtomic(root, snapshot, { ...snapshot.document, extensions: rest });
    } catch (error) {
      try {
        ensureSafeDirectory(root, AI_VERSE_TOKEN_EXTENSION_ROOT);
        restoreTokenOwnedFiles(root, previousFiles);
      } catch { /* preserve primary error */ }
      throw error;
    }
    return base("uninstall", root, { status: "uninstalled", registry_written: true, removed_paths: removed });
  });
}
