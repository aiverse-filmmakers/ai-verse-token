import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_CODE_COLLECTOR,
  CODEX_COLLECTOR,
  GEMINI_CLI_COLLECTOR,
  HERMES_PASSIVE_COLLECTOR,
  OPENCLAW_COLLECTOR,
  OPENCODE_COLLECTOR,
  CollectorRegistry,
  discoverClaudeCodeSources,
  discoverCodexSources,
  discoverGeminiCliSources,
  discoverHermesStateSources,
  discoverOpenClawSources,
  discoverOpenCodeSources
} from "../collectors/index.js";
import type { TokenDiscoveredSource, TokenSourceDiscoveryResult } from "./types.js";

export function createDefaultCollectorRegistry(): CollectorRegistry {
  return new CollectorRegistry([
    HERMES_PASSIVE_COLLECTOR,
    CLAUDE_CODE_COLLECTOR,
    CODEX_COLLECTOR,
    OPENCODE_COLLECTOR,
    GEMINI_CLI_COLLECTOR,
    OPENCLAW_COLLECTOR
  ]);
}

function key(collectorId: string, source: unknown): string {
  return createHash("sha256").update(`${collectorId}\n${JSON.stringify(source)}`).digest("hex").slice(0, 40);
}

function pathOf(source: unknown): string | null {
  if (typeof source !== "object" || source === null || Array.isArray(source)) return null;
  const path = (source as Record<string, unknown>).path;
  return typeof path === "string" ? path : null;
}

function add(target: TokenDiscoveredSource[], collectorId: string, sources: readonly unknown[]): void {
  for (const source of sources) target.push(Object.freeze({ collector_id: collectorId, source_key: key(collectorId, source), source, path: pathOf(source) }));
}

export function defaultSourceRoots(): Readonly<Record<string, string>> {
  const home = homedir();
  const xdgData = process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
  const openCodeDefault = process.platform === "darwin"
    ? join(home, "Library", "Application Support", "opencode")
    : process.platform === "win32"
      ? join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "opencode")
      : join(xdgData, "opencode");
  return Object.freeze({
    hermes: process.env.HERMES_HOME ?? join(home, ".hermes"),
    claude_code: process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"),
    codex: process.env.CODEX_HOME ?? join(home, ".codex"),
    opencode: process.env.OPENCODE_DATA_DIR ?? openCodeDefault,
    gemini_cli: process.env.GEMINI_CLI_HOME ?? join(home, ".gemini"),
    openclaw: process.env.OPENCLAW_STATE_DIR ?? join(home, ".openclaw")
  });
}

export function discoverDefaultTokenSources(roots: Readonly<Record<string, string>> = defaultSourceRoots()): TokenSourceDiscoveryResult {
  const sources: TokenDiscoveredSource[] = [];
  const problems: Array<{ collector_id: string; code: string; message: string }> = [];
  const run = (collectorId: string, fn: () => readonly unknown[]): void => {
    try { add(sources, collectorId, fn()); }
    catch (error) { problems.push({ collector_id: collectorId, code: typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "DISCOVERY_FAILED") : "DISCOVERY_FAILED", message: error instanceof Error ? error.message : String(error) }); }
  };
  run("hermes-passive", () => discoverHermesStateSources({ hermes_home: roots.hermes ?? "" }));
  run("claude-code-local", () => discoverClaudeCodeSources({ claude_home: roots.claude_code ?? "" }));
  run("codex-local", () => discoverCodexSources({ codex_home: roots.codex ?? "" }));
  run("opencode-local", () => discoverOpenCodeSources({ data_dir: roots.opencode ?? "" }));
  run("gemini-cli-local", () => discoverGeminiCliSources({ gemini_home: roots.gemini_cli ?? "" }));
  run("openclaw-local", () => discoverOpenClawSources({ state_dir: roots.openclaw ?? "" }));
  sources.sort((a, b) => `${a.collector_id}:${a.source_key}`.localeCompare(`${b.collector_id}:${b.source_key}`));
  return Object.freeze({ roots: Object.freeze({ ...roots }), sources: Object.freeze(sources), problems: Object.freeze(problems) });
}
