import type {
  CollectorDefinition,
  CollectorRuntimeScope,
  TokenCollector
} from "./types.js";

export type CollectorRegistryErrorCode = "COLLECTOR_CONFIG_INVALID" | "COLLECTOR_DUPLICATE" | "COLLECTOR_UNKNOWN";

export class CollectorRegistryError extends Error {
  readonly code: CollectorRegistryErrorCode;

  constructor(code: CollectorRegistryErrorCode, message: string) {
    super(message);
    this.name = "CollectorRegistryError";
    this.code = code;
  }
}

const ID_RE = /^[a-z][a-z0-9]*(?:[-_.:][a-z0-9]+)*$/;

function fail(message: string): never {
  throw new CollectorRegistryError("COLLECTOR_CONFIG_INVALID", message);
}

function bounded(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.includes("\u0000")) {
    fail(`${path}: must be a non-empty string up to ${max} characters without NUL`);
  }
  return value;
}

function normalizeRuntimeScope(value: CollectorRuntimeScope, path: string): CollectorRuntimeScope {
  if (value === "*") return value;
  if (!Array.isArray(value) || value.length === 0) fail(`${path}: must be '*' or a non-empty runtime list`);
  const items = value.map((runtime, index) => bounded(runtime, `${path}[${index}]`, 200));
  if (new Set(items).size !== items.length) fail(`${path}: duplicate runtimes are not allowed`);
  return Object.freeze(items);
}

function validateDefinition(value: CollectorDefinition, index: number): CollectorDefinition {
  const id = bounded(value.id, `collectors[${index}].id`, 200);
  if (!ID_RE.test(id)) fail(`collectors[${index}].id: invalid collector id`);
  const version = bounded(value.version, `collectors[${index}].version`, 100);
  const runtimes = normalizeRuntimeScope(value.runtimes, `collectors[${index}].runtimes`);
  return Object.freeze({ id, version, runtimes });
}

export class CollectorRegistry {
  readonly #collectors: ReadonlyMap<string, TokenCollector>;

  constructor(collectors: readonly TokenCollector[] = []) {
    const map = new Map<string, TokenCollector>();
    collectors.forEach((collector, index) => {
      if (typeof collector !== "object" || collector === null) fail(`collectors[${index}]: must be an object`);
      if (typeof collector.detect !== "function" || typeof collector.collect !== "function") {
        fail(`collectors[${index}]: detect and collect functions are required`);
      }
      const definition = validateDefinition(collector.definition, index);
      if (map.has(definition.id)) {
        throw new CollectorRegistryError("COLLECTOR_DUPLICATE", `duplicate collector id '${definition.id}'`);
      }
      const normalized: TokenCollector = Object.freeze({
        definition,
        detect: collector.detect.bind(collector),
        collect: collector.collect.bind(collector)
      });
      map.set(definition.id, normalized);
    });
    this.#collectors = map;
  }

  get(collectorId: string): TokenCollector | undefined {
    return this.#collectors.get(collectorId);
  }

  require(collectorId: string): TokenCollector {
    const collector = this.#collectors.get(collectorId);
    if (collector === undefined) {
      throw new CollectorRegistryError("COLLECTOR_UNKNOWN", `unknown collector '${collectorId}'`);
    }
    return collector;
  }

  list(): readonly CollectorDefinition[] {
    return Object.freeze([...this.#collectors.values()].map((collector) => collector.definition));
  }
}
