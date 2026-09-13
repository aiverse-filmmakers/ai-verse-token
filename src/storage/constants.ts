export const TOKEN_LEDGER_FORMAT = "ai-verse-token/sqlite" as const;
export const TOKEN_LEDGER_FORMAT_VERSION = 2 as const;
export const TOKEN_LEDGER_APPLICATION_ID = 0x4156544b as const; // AVTK
export const TOKEN_LEDGER_BUSY_TIMEOUT_MS = 5_000 as const;

export const TOKEN_LEDGER_METADATA_KEYS = Object.freeze({
  format: "format",
  formatVersion: "format_version",
  protocolVersion: "protocol_version",
  createdAt: "created_at"
} as const);
