import { createHash } from "node:crypto";
import type { UsageEvent, UsageIdentity, UsageTiming, UsageCounts } from "../protocol/types.js";
import { validateUsageEvent } from "../protocol/validation.js";

export type RemoteAdapterErrorCode =
  | "REMOTE_RECORD_INVALID"
  | "REMOTE_USAGE_INVALID"
  | "REMOTE_COST_INVALID"
  | "REMOTE_WINDOW_INVALID";

export class RemoteAdapterError extends Error {
  readonly code: RemoteAdapterErrorCode;

  constructor(code: RemoteAdapterErrorCode, message: string) {
    super(message);
    this.name = "RemoteAdapterError";
    this.code = code;
  }
}

export function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RemoteAdapterError("REMOTE_RECORD_INVALID", `${path}: must be an object`);
  }
  return value as Record<string, unknown>;
}

export function text(value: unknown, path: string, max = 500): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.includes("\u0000")) {
    throw new RemoteAdapterError("REMOTE_RECORD_INVALID", `${path}: must be non-empty text up to ${max} characters without NUL`);
  }
  return value;
}

export function optionalText(value: unknown, path: string, max = 500): string | null {
  if (value === undefined || value === null || value === "") return null;
  return text(value, path, max);
}

export function nonNegativeInt(value: unknown, path: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RemoteAdapterError("REMOTE_USAGE_INVALID", `${path}: must be a non-negative safe integer`);
  }
  return value as number;
}

export function nonNegativeNumber(value: unknown, path: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RemoteAdapterError("REMOTE_COST_INVALID", `${path}: must be a finite non-negative number`);
  }
  return value;
}

export function iso(value: unknown, path: string): string {
  const raw = text(value, path, 100);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new RemoteAdapterError("REMOTE_RECORD_INVALID", `${path}: must be an ISO 8601 date-time`);
  }
  return new Date(parsed).toISOString();
}

export function optionalIso(value: unknown, path: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return iso(value, path);
}

export function hash(parts: readonly string[]): string {
  const digest = createHash("sha256");
  for (const part of parts) digest.update(`${part.length}:${part}|`);
  return digest.digest("hex");
}

export function aliasValue(
  row: Record<string, unknown>,
  aliases: readonly string[],
  path: string
): unknown {
  const found = aliases.filter((key) => row[key] !== undefined).map((key) => ({ key, value: row[key] }));
  if (found.length === 0) return undefined;
  const canonical = JSON.stringify(found[0]?.value);
  for (const candidate of found.slice(1)) {
    if (JSON.stringify(candidate.value) !== canonical) {
      throw new RemoteAdapterError(
        "REMOTE_RECORD_INVALID",
        `${path}: conflicting aliases '${found[0]?.key}' and '${candidate.key}'`
      );
    }
  }
  return found[0]?.value;
}

export interface RemoteEventArgs {
  readonly collectorId: string;
  readonly collectorVersion: string;
  readonly runtime: string;
  readonly sourceType: string;
  readonly sourceRecordId: string;
  readonly observedAt: string;
  readonly requestId?: string | null;
  readonly sessionId?: string | null;
  readonly identity: UsageIdentity;
  readonly usage: UsageCounts;
  readonly timing?: UsageTiming;
  readonly usageQuality?: UsageEvent["provenance"]["usage_quality"];
  readonly timingQuality?: UsageEvent["provenance"]["timing_quality"];
}

export function remoteEvent(args: RemoteEventArgs): UsageEvent {
  const fingerprint = hash([args.runtime, args.sourceType, args.sourceRecordId]);
  return validateUsageEvent({
    schema_version: "ai-verse-token/0.1",
    event_id: `evt_${args.runtime.replace(/[^a-z0-9]+/gi, "_")}_${fingerprint.slice(0, 40)}`,
    ...(args.requestId === undefined ? {} : { request_id: args.requestId }),
    ...(args.sessionId === undefined ? {} : { session_id: args.sessionId }),
    source: {
      runtime: args.runtime,
      source_type: args.sourceType,
      source_record_id: args.sourceRecordId,
      source_platform: args.identity.billing_platform
    },
    observed_at: args.observedAt,
    identity: args.identity,
    usage: args.usage,
    timing: args.timing ?? {},
    provenance: {
      collector_id: args.collectorId,
      collector_version: args.collectorVersion,
      source_type: args.sourceType,
      source_record_fingerprint: fingerprint,
      usage_quality: args.usageQuality ?? "provider_reported",
      timing_quality: args.timingQuality ?? "unknown",
      content_stored: false
    }
  });
}
