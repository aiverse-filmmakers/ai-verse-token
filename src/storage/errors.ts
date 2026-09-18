export type TokenLedgerErrorCode =
  | "PATH_INVALID"
  | "NOT_FOUND"
  | "OPEN_FAILED"
  | "FOREIGN_DATABASE"
  | "FORMAT_MISMATCH"
  | "VERSION_UNSUPPORTED"
  | "INTEGRITY_FAILED"
  | "CLOSED"
  | "READ_ONLY"
  | "INGEST_INVALID"
  | "ACTUAL_CHARGE_UNTRUSTED"
  | "INGEST_CONFLICT";

export class TokenLedgerError extends Error {
  readonly code: TokenLedgerErrorCode;
  override readonly cause?: unknown;

  constructor(code: TokenLedgerErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "TokenLedgerError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}
