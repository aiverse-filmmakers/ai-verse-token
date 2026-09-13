const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export class TokenEcosystemError extends Error {
  readonly code: "ECOSYSTEM_INVALID" | "ATTRIBUTION_CONFLICT" | "READ_LIMIT_EXCEEDED";
  constructor(code: TokenEcosystemError["code"], message: string) {
    super(message);
    this.name = "TokenEcosystemError";
    this.code = code;
  }
}

export function safeId(value: string, label: string): string {
  if (!SAFE_ID.test(value) || value === "." || value === ".." || value.includes("\u0000")) {
    throw new TokenEcosystemError("ECOSYSTEM_INVALID", `${label} must be a safe opaque identifier`);
  }
  return value;
}

export function mergeExact(existing: string | null | undefined, incoming: string | undefined, label: string): string | null | undefined {
  if (incoming === undefined) return existing;
  safeId(incoming, label);
  if (existing !== undefined && existing !== null && existing !== incoming) {
    throw new TokenEcosystemError("ATTRIBUTION_CONFLICT", `${label} conflicts with existing canonical attribution`);
  }
  return incoming;
}

export function tokenReference(kind: "event" | "session" | "run" | "task", id: string): string {
  return `token://${kind}/${encodeURIComponent(safeId(id, `${kind}_id`))}`;
}
