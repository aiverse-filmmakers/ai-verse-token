declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function realpathSync(path: string): string;
}

declare module "node:sqlite" {
  export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
    allowExtension?: boolean;
    timeout?: number;
  }

  export interface StatementRunResult {
    readonly changes: number | bigint;
    readonly lastInsertRowid: number | bigint;
  }

  export class StatementSync {
    all(...anonymousParameters: unknown[]): unknown[];
    get(...anonymousParameters: unknown[]): unknown;
    run(...anonymousParameters: unknown[]): StatementRunResult;
  }

  export class DatabaseSync {
    constructor(location: string, options?: DatabaseSyncOptions);
    readonly isOpen: boolean;
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    aggregate<T>(
      name: string,
      options: {
        start: T;
        step: (accumulator: T, value: unknown) => T;
        result?: (accumulator: T) => unknown;
      }
    ): void;
  }
}


declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
  export class URL {
    constructor(input: string, base?: string | URL);
    readonly protocol: string;
    readonly username: string;
    readonly password: string;
    toString(): string;
  }
}

declare module "node:path" {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function dirname(path: string): string;
}

declare module "node:crypto" {
  export interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
  export function randomUUID(): string;
}

declare module "node:timers" {
  export interface Timeout {
    unref(): Timeout;
  }
  export function setInterval(callback: () => void, delay?: number): Timeout;
  export function clearInterval(timeout: Timeout): void;
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(
    path: string,
    data: string,
    options?: { encoding?: "utf8"; flag?: string }
  ): void;
  export function readdirSync(path: string): string[];
  export function linkSync(existingPath: string, newPath: string): void;
  export function unlinkSync(path: string): void;
  export function renameSync(oldPath: string, newPath: string): void;
  export function rmdirSync(path: string): void;
  export function cpSync(source: string, destination: string, options?: { recursive?: boolean; force?: boolean; errorOnExist?: boolean }): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare class Buffer extends Uint8Array {
  static alloc(size: number): Buffer;
  static allocUnsafe(size: number): Buffer;
  static from(value: Uint8Array): Buffer;
  static concat(list: readonly Uint8Array[]): Buffer;
  readonly byteLength: number;
  indexOf(value: number): number;
  subarray(start?: number, end?: number): Buffer;
  toString(encoding?: "utf8"): string;
}

declare module "node:fs" {
  export interface Stats {
    readonly size: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }
  export function openSync(path: string, flags: string): number;
  export function closeSync(fd: number): void;
  export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
  export function statSync(path: string): Stats;
  export function lstatSync(path: string): Stats;
  export function fstatSync(fd: number): Stats;
}

declare module "node:path" {
  export const sep: string;
  export function basename(path: string): string;
  export function relative(from: string, to: string): string;
}


declare const process: {
  readonly env: Record<string, string | undefined>;
  readonly platform: string;
};

declare class AbortSignal {}
declare class AbortController {
  readonly signal: AbortSignal;
  abort(): void;
}
declare function setTimeout(callback: () => void, delay?: number): unknown;
declare function clearTimeout(handle: unknown): void;
declare class TextDecoder { decode(input?: Uint8Array): string; }
interface FetchHeaders { get(name: string): string | null; }
interface FetchResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: FetchHeaders;
  arrayBuffer(): Promise<ArrayBuffer>;
}
declare function fetch(input: string, init?: {
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly redirect?: "error" | "follow" | "manual";
}): Promise<FetchResponse>;


declare module "node:os" {
  export function homedir(): string;
}

declare interface ImportMeta {
  readonly url: string;
}
