import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  AI_VERSE_TOKEN_RUNTIME_CONFIG,
  AI_VERSE_TOKEN_STATE_ROOT
} from "../native/constants.js";
import { ensureSafeDirectory, safeRelativePath } from "../native/paths.js";
import type { TokenRuntimeConfig } from "./types.js";

const MAX_CONFIG_BYTES = 256 * 1024;

export class TokenRuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TokenRuntimeError";
    this.code = code;
  }
}

function defaultConfig(now = new Date().toISOString()): TokenRuntimeConfig {
  return Object.freeze({
    schema_version: "ai-verse-token-runtime/0.1",
    setup_at: now,
    collection: Object.freeze({ enabled: true, default_collectors: true }),
    pricing: Object.freeze({ openrouter_models_api: Object.freeze({ enabled: true, api_key_env: "OPENROUTER_API_KEY" }) }),
    authority: Object.freeze({ telemetry_attribution_is_permission: false, external_authorization_owner: "host" })
  });
}

function parseConfig(value: unknown): TokenRuntimeConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TokenRuntimeError("RUNTIME_CONFIG_INVALID", "runtime config must be an object");
  const row = value as Record<string, unknown>;
  if (row.schema_version !== "ai-verse-token-runtime/0.1") throw new TokenRuntimeError("RUNTIME_CONFIG_INVALID", "unsupported runtime config schema");
  if (typeof row.setup_at !== "string" || !Number.isFinite(Date.parse(row.setup_at))) throw new TokenRuntimeError("RUNTIME_CONFIG_INVALID", "runtime setup_at is invalid");
  const collection = row.collection as Record<string, unknown> | undefined;
  const pricing = row.pricing as Record<string, unknown> | undefined;
  const openrouter = pricing?.openrouter_models_api as Record<string, unknown> | undefined;
  const authority = row.authority as Record<string, unknown> | undefined;
  if (collection?.enabled !== true && collection?.enabled !== false) throw new TokenRuntimeError("RUNTIME_CONFIG_INVALID", "collection.enabled must be boolean");
  if (collection.default_collectors !== true) throw new TokenRuntimeError("RUNTIME_CONFIG_INVALID", "default_collectors must be true in runtime v0.1");
  if (openrouter?.enabled !== true && openrouter?.enabled !== false) throw new TokenRuntimeError("RUNTIME_CONFIG_INVALID", "pricing.openrouter_models_api.enabled must be boolean");
  if (typeof openrouter.api_key_env !== "string" || openrouter.api_key_env.length < 1 || openrouter.api_key_env.length > 200 || openrouter.api_key_env.includes("\u0000")) throw new TokenRuntimeError("RUNTIME_CONFIG_INVALID", "pricing api_key_env is invalid");
  if (authority?.telemetry_attribution_is_permission !== false || authority.external_authorization_owner !== "host") throw new TokenRuntimeError("RUNTIME_CONFIG_INVALID", "runtime authority boundary is invalid");
  return Object.freeze({
    schema_version: "ai-verse-token-runtime/0.1",
    setup_at: row.setup_at,
    collection: Object.freeze({ enabled: collection.enabled as boolean, default_collectors: true }),
    pricing: Object.freeze({ openrouter_models_api: Object.freeze({ enabled: openrouter.enabled as boolean, api_key_env: openrouter.api_key_env }) }),
    authority: Object.freeze({ telemetry_attribution_is_permission: false, external_authorization_owner: "host" })
  });
}

export function readTokenRuntimeConfig(root: string): TokenRuntimeConfig | null {
  const path = safeRelativePath(root, AI_VERSE_TOKEN_RUNTIME_CONFIG);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  if (raw.length > MAX_CONFIG_BYTES) throw new TokenRuntimeError("RUNTIME_CONFIG_INVALID", "runtime config exceeds supported size");
  try { return parseConfig(JSON.parse(raw)); }
  catch (error) { if (error instanceof TokenRuntimeError) throw error; throw new TokenRuntimeError("RUNTIME_CONFIG_INVALID", "runtime config is not valid JSON", { cause: error }); }
}

export function ensureTokenRuntimeConfig(root: string): { readonly config: TokenRuntimeConfig; readonly created: boolean } {
  ensureSafeDirectory(root, AI_VERSE_TOKEN_STATE_ROOT);
  const existing = readTokenRuntimeConfig(root);
  if (existing !== null) return Object.freeze({ config: existing, created: false });
  const config = defaultConfig();
  const path = safeRelativePath(root, AI_VERSE_TOKEN_RUNTIME_CONFIG);
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temp, path);
  } catch (error) {
    throw new TokenRuntimeError("RUNTIME_CONFIG_WRITE_FAILED", "failed to write Token runtime config", { cause: error });
  }
  return Object.freeze({ config, created: true });
}
