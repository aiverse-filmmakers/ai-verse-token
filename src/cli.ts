import { exportUsage, privacySafeUsageEvent } from "./export/index.js";
import { PACKAGE_VERSION } from "./index.js";
import {
  disableTokenExtension,
  enableTokenExtension,
  inspectTokenNative,
  installTokenExtension,
  uninstallTokenExtension,
  updateTokenExtension,
  type TokenLifecycleResult,
  type TokenNativeStatusResult
} from "./native/index.js";
import { openTokenReader } from "./read/index.js";

export interface CliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

const HELP = `AI-Verse Token ${PACKAGE_VERSION}

Usage:
  ai-verse-token --help
  ai-verse-token --version
  ai-verse-token summary --db <token.sqlite> [--json]
  ai-verse-token query --db <token.sqlite> [--limit <1..100>] [--json]
  ai-verse-token export --db <token.sqlite> --format <json|csv> [--limit <1..50000>]
  ai-verse-token install --root <ai-verse-os-root> [--json]
  ai-verse-token update --root <ai-verse-os-root> [--json]
  ai-verse-token enable --root <ai-verse-os-root> [--json]
  ai-verse-token disable --root <ai-verse-os-root> [--json]
  ai-verse-token uninstall --root <ai-verse-os-root> [--json]
  ai-verse-token status --root <candidate-root> [--json]
  ai-verse-token doctor --root <candidate-root> [--json]

Read commands are privacy-safe by default and never modify the Token ledger.
Native lifecycle commands modify only AI-Verse Token's local extension entry/files. Token state survives uninstall.
`;

interface ReadCommand {
  readonly kind: "read";
  readonly command: "summary" | "query" | "export";
  readonly db: string;
  readonly json: boolean;
  readonly limit?: number;
  readonly format?: "json" | "csv";
}

interface NativeCommand {
  readonly kind: "native";
  readonly command: "install" | "update" | "enable" | "disable" | "uninstall" | "status" | "doctor";
  readonly root: string;
  readonly json: boolean;
}

type ParsedCommand = ReadCommand | NativeCommand;

class CliUsageError extends Error {}

function int(value: string | undefined, label: string, min: number, max: number): number {
  if (value === undefined || !/^\d+$/.test(value)) throw new CliUsageError(`${label} requires an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new CliUsageError(`${label} must be in ${min}..${max}`);
  return parsed;
}

function filesystemPath(value: string | undefined, label: string): string {
  if (value === undefined || value.length < 1 || value.includes("\u0000")) throw new CliUsageError(`${label} requires a filesystem path`);
  return value;
}

function parseCommand(args: readonly string[]): ParsedCommand {
  const command = args[0];
  const native = command === "install" || command === "update" || command === "enable" || command === "disable" || command === "uninstall" || command === "status" || command === "doctor";
  if (native) {
    let root: string | undefined;
    let json = false;
    for (let index = 1; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--json") { json = true; continue; }
      if (arg === "--root") { root = filesystemPath(args[++index], "--root"); continue; }
      throw new CliUsageError(`Unknown option: ${String(arg)}`);
    }
    if (root === undefined) throw new CliUsageError("--root is required");
    return { kind: "native", command, root, json };
  }

  if (command !== "summary" && command !== "query" && command !== "export") {
    throw new CliUsageError(`Unknown command or option: ${args.join(" ")}`);
  }
  let db: string | undefined;
  let json = false;
  let limit: number | undefined;
  let format: "json" | "csv" | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      if (command === "export") throw new CliUsageError("export uses --format json instead of --json");
      json = true;
      continue;
    }
    if (arg === "--db") { db = filesystemPath(args[++index], "--db"); continue; }
    if (arg === "--limit") {
      const max = command === "export" ? 50_000 : command === "query" ? 100 : 0;
      if (max === 0) throw new CliUsageError("--limit is not supported for summary");
      limit = int(args[++index], "--limit", 1, max);
      continue;
    }
    if (arg === "--format") {
      if (command !== "export") throw new CliUsageError("--format is supported only for export");
      const value = args[++index];
      if (value !== "json" && value !== "csv") throw new CliUsageError("--format must be json or csv");
      format = value;
      continue;
    }
    throw new CliUsageError(`Unknown option: ${String(arg)}`);
  }
  if (db === undefined) throw new CliUsageError("--db is required");
  if (command === "export" && format === undefined) throw new CliUsageError("export requires --format json or csv");
  return { kind: "read", command, db, json, ...(limit === undefined ? {} : { limit }), ...(format === undefined ? {} : { format }) };
}

function textSummary(summary: ReturnType<ReturnType<typeof openTokenReader>["summary"]>): string {
  return [
    `Requests: ${String(summary.request_count)}`,
    `Input tokens: ${String(summary.input_tokens ?? "unknown")}`,
    `Output tokens: ${String(summary.output_tokens ?? "unknown")}`,
    `Reasoning tokens: ${String(summary.reasoning_tokens ?? "unknown")}`,
    `Cache read tokens: ${String(summary.cache_read_tokens ?? "unknown")}`,
    `Cache write tokens: ${String(summary.cache_write_tokens ?? "unknown")}`,
    `Cached input tokens: ${String(summary.cached_input_tokens ?? "unknown")}`,
    `Reported total tokens: ${String(summary.total_tokens_reported ?? "unknown")}`
  ].join("\n");
}

function textLifecycle(result: TokenLifecycleResult): string {
  return [
    `${result.command}: ${result.status}`,
    `Root: ${result.root_path}`,
    `Enabled: ${result.enabled === null ? "n/a" : String(result.enabled)}`,
    `Registry written: ${String(result.registry_written)}`,
    `State preserved: ${String(result.state_preserved)}`
  ].join("\n");
}

function textNativeStatus(result: TokenNativeStatusResult): string {
  return [
    `${result.command}: ${result.healthy ? "healthy" : "problems"}`,
    `Mode: ${result.mode}`,
    `Root: ${result.root_path}`,
    `Registered: ${result.registration === null ? "n/a" : String(result.registration.registered)}`,
    `Enabled: ${result.registration?.enabled === null || result.registration?.enabled === undefined ? "n/a" : String(result.registration.enabled)}`,
    `Ledger: ${result.ledger_exists === null ? "n/a" : result.ledger_exists ? "present" : "not-created"}`,
    ...result.problems.map((problem) => `Problem ${problem.code}: ${problem.message}`),
    ...result.notices.map((notice) => `Notice ${notice.code}: ${notice.message}`)
  ].join("\n");
}

function runNative(parsed: NativeCommand, io: CliIo): number {
  try {
    if (parsed.command === "status" || parsed.command === "doctor") {
      const result = inspectTokenNative(parsed.root, parsed.command === "doctor");
      io.stdout(parsed.json ? JSON.stringify(result, null, 2) : textNativeStatus(result));
      return result.healthy ? 0 : 1;
    }
    const result = parsed.command === "install" ? installTokenExtension(parsed.root)
      : parsed.command === "update" ? updateTokenExtension(parsed.root)
      : parsed.command === "enable" ? enableTokenExtension(parsed.root)
      : parsed.command === "disable" ? disableTokenExtension(parsed.root)
      : uninstallTokenExtension(parsed.root);
    io.stdout(parsed.json ? JSON.stringify(result, null, 2) : textLifecycle(result));
    return 0;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
    io.stderr(`${code ? `${code}: ` : ""}${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export function runCli(args: readonly string[], io: CliIo): number {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) { io.stdout(HELP); return 0; }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) { io.stdout(PACKAGE_VERSION); return 0; }

  let parsed: ParsedCommand;
  try { parsed = parseCommand(args); }
  catch (error) { io.stderr(`${error instanceof Error ? error.message : String(error)}\nRun ai-verse-token --help for usage.`); return 2; }
  if (parsed.kind === "native") return runNative(parsed, io);

  let reader: ReturnType<typeof openTokenReader> | undefined;
  try {
    reader = openTokenReader({ path: parsed.db });
    if (parsed.command === "summary") {
      const summary = reader.summary();
      io.stdout(parsed.json ? JSON.stringify(summary, null, 2) : textSummary(summary));
      return 0;
    }
    if (parsed.command === "query") {
      const result = reader.query({ limit: parsed.limit ?? 20 });
      const safe = { events: result.events.map(privacySafeUsageEvent), hasMore: result.hasMore, nextCursor: result.nextCursor };
      if (parsed.json) io.stdout(JSON.stringify(safe, null, 2));
      else io.stdout(safe.events.map((event) => [
        event.observed_at,
        event.source.runtime,
        event.identity.resolved_model ?? event.identity.requested_model ?? "unknown-model",
        `in=${String(event.usage.input_tokens ?? "?")}`,
        `out=${String(event.usage.output_tokens ?? "?")}`
      ].join("  ")).join("\n"));
      return 0;
    }
    io.stdout(exportUsage(reader, { format: parsed.format!, max_events: parsed.limit ?? 10_000 }));
    return 0;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
    io.stderr(`${code ? `${code}: ` : ""}${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally { reader?.close(); }
}
