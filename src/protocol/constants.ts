export const TOKEN_PROTOCOL_VERSION = "ai-verse-token/0.1" as const;

export const COST_STATUSES = ["ACTUAL", "CALCULATED", "UNKNOWN"] as const;
export const USAGE_QUALITIES = [
  "provider_reported",
  "runtime_reported",
  "derived_exact",
  "estimated",
  "unknown"
] as const;
export const TIMING_QUALITIES = USAGE_QUALITIES;
export const ACTUAL_CHARGE_SOURCES = ["provider_reported", "runtime_reported"] as const;

export const TOKEN_PROTOCOL_LIMITS = Object.freeze({
  maxIdLength: 500,
  maxShortTextLength: 200,
  maxModelLength: 500,
  maxFingerprintLength: 256,
  minFingerprintLength: 16,
  maxTokenCount: Number.MAX_SAFE_INTEGER,
  maxUnitCount: Number.MAX_SAFE_INTEGER,
  maxDurationMs: 30 * 24 * 60 * 60 * 1000,
  maxChargeAmount: 1_000_000_000_000
});
