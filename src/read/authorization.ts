import type { UsageQueryFilter } from "../query/index.js";
import { TokenReadError } from "./reader-error.js";

export const TOKEN_AUTHORIZATION_DIMENSIONS = [
  "system_id",
  "workspace_id",
  "project_id",
  "agent_id",
  "bot_id",
  "worker_id",
  "skill_id",
  "automation_id",
  "tool_id",
  "run_id",
  "task_id",
  "session_id"
] as const;

export type TokenAuthorizationDimension = (typeof TOKEN_AUTHORIZATION_DIMENSIONS)[number];
export type TokenAuthorizationScopeFloor = Readonly<Partial<Record<TokenAuthorizationDimension, string>>>;

export interface TokenReadAuthorization {
  /** Identity is supplied by the outer host. Token does not authenticate this principal. */
  readonly principal_id: string;
  /** owner means the outer host explicitly authorized full local Token visibility. */
  readonly mode: "owner" | "scoped";
  /** Immutable exact scope floor imposed by the outer host for scoped readers. */
  readonly scope_floor?: TokenAuthorizationScopeFloor;
}

function safePrincipal(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 500 || value.includes("\u0000")) {
    throw new TokenReadError("READ_UNAUTHORIZED_SCOPE", "authorization principal_id must be a bounded non-empty string");
  }
  return value;
}

function safeScope(value: TokenAuthorizationScopeFloor | undefined): TokenAuthorizationScopeFloor {
  if (value === undefined) return Object.freeze({});
  const result: Partial<Record<TokenAuthorizationDimension, string>> = {};
  for (const key of TOKEN_AUTHORIZATION_DIMENSIONS) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    if (typeof candidate !== "string" || candidate.length < 1 || candidate.length > 500 || candidate.includes("\u0000")) {
      throw new TokenReadError("READ_UNAUTHORIZED_SCOPE", `authorization scope_floor.${key} must be a bounded non-empty string`);
    }
    result[key] = candidate;
  }
  return Object.freeze(result);
}

export function validateReadAuthorization(value: TokenReadAuthorization | undefined): TokenReadAuthorization {
  if (value === undefined) throw new TokenReadError("READ_UNAUTHORIZED_SCOPE", "a host or local-owner authorization envelope is required");
  safePrincipal(value.principal_id);
  if (value.mode !== "owner" && value.mode !== "scoped") {
    throw new TokenReadError("READ_UNAUTHORIZED_SCOPE", "authorization mode must be owner or scoped");
  }
  const floor = safeScope(value.scope_floor);
  if (value.mode === "scoped" && Object.keys(floor).length === 0) {
    throw new TokenReadError("READ_UNAUTHORIZED_SCOPE", "scoped authorization requires at least one immutable scope floor dimension");
  }
  return Object.freeze({
    principal_id: value.principal_id,
    mode: value.mode,
    ...(Object.keys(floor).length === 0 ? {} : { scope_floor: floor })
  });
}

export function authorizeFilter(filter: UsageQueryFilter | undefined, authorization: TokenReadAuthorization | undefined): UsageQueryFilter | undefined {
  if (authorization === undefined || authorization.mode === "owner") return filter;
  const floor = authorization.scope_floor ?? {};
  const next: Record<string, unknown> = { ...(filter ?? {}) };
  for (const key of TOKEN_AUTHORIZATION_DIMENSIONS) {
    const required = floor[key];
    if (required === undefined) continue;
    if (Object.prototype.hasOwnProperty.call(next, key) && next[key] !== required) {
      throw new TokenReadError(
        "READ_UNAUTHORIZED_SCOPE",
        `requested ${key} is outside the immutable authorization floor for principal '${authorization.principal_id}'`
      );
    }
    next[key] = required;
  }
  return Object.freeze(next) as UsageQueryFilter;
}
