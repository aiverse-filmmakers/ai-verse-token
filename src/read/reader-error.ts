export class TokenReadError extends Error {
  readonly code: "READ_INVALID" | "READ_LIMIT_EXCEEDED" | "READ_CLOSED" | "READ_UNAUTHORIZED_SCOPE";
  constructor(code: TokenReadError["code"], message: string) {
    super(message);
    this.name = "TokenReadError";
    this.code = code;
  }
}
