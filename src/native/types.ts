export type JsonObject = Record<string, unknown>;

export type AiVerseHostMode = "ai-verse-os-v2" | "standalone" | "incompatible";
export type AiVerseCompatibilityStatus = "compatible" | "no-os" | "incompatible";

export interface AiVerseCompatibilityIssue {
  readonly code: string;
  readonly message: string;
  readonly relative_path?: string;
}

export interface AiVerseCompatibilityResult {
  readonly status: AiVerseCompatibilityStatus;
  readonly root_path: string;
  readonly schema_major: number | null;
  readonly architecture: string | null;
  readonly issues: readonly AiVerseCompatibilityIssue[];
}

export type TokenLifecycleCommand = "install" | "update" | "enable" | "disable" | "uninstall";
export type TokenLifecycleStatus = "installed" | "updated" | "enabled" | "disabled" | "uninstalled" | "unchanged" | "not-installed";

export interface TokenLifecycleResult {
  readonly command: TokenLifecycleCommand;
  readonly status: TokenLifecycleStatus;
  readonly root_path: string;
  readonly registry_written: boolean;
  readonly materialized_paths: readonly string[];
  readonly removed_paths: readonly string[];
  readonly enabled: boolean | null;
  readonly state_preserved: true;
  readonly tracked_os_files_mutated: readonly [];
}

export interface TokenNativeRegistrationStatus {
  readonly registry_exists: boolean;
  readonly registered: boolean;
  readonly supported: boolean | null;
  readonly installed: boolean | null;
  readonly enabled: boolean | null;
  readonly version: string | null;
}

export interface TokenNativeStatusResult {
  readonly command: "status" | "doctor";
  readonly healthy: boolean;
  readonly mode: AiVerseHostMode;
  readonly root_path: string;
  readonly host: AiVerseCompatibilityResult;
  readonly registration: TokenNativeRegistrationStatus | null;
  readonly materialized: boolean | null;
  readonly state_path: string | null;
  readonly ledger_exists: boolean | null;
  readonly ledger_integrity: { readonly checked: boolean; readonly ok: boolean | null; readonly details: readonly string[] } | null;
  readonly problems: readonly { readonly code: string; readonly message: string; readonly next_step: string }[];
  readonly notices: readonly { readonly code: string; readonly message: string }[];
}

export type TokenNativeErrorCode =
  | "AI_VERSE_OS_NOT_FOUND"
  | "INCOMPATIBLE_AI_VERSE_OS"
  | "UNSAFE_PATH"
  | "SYMLINK_PATH_REJECTED"
  | "INVALID_EXTENSION_REGISTRY"
  | "UNSUPPORTED_EXTENSION_REGISTRY_SCHEMA"
  | "INVALID_EXISTING_EXTENSION_ENTRY"
  | "EXTENSION_REGISTRY_BUSY"
  | "EXTENSION_REGISTRY_CHANGED"
  | "EXTENSION_WRITE_FAILED"
  | "EXTENSION_NOT_INSTALLED";

export class TokenNativeError extends Error {
  readonly code: TokenNativeErrorCode;
  constructor(code: TokenNativeErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TokenNativeError";
    this.code = code;
  }
}
