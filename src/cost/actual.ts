import { ACTUAL_CHARGE_SOURCES } from "../protocol/constants.js";
import type { ActualCharge, ActualChargeSource, UsageEvent } from "../protocol/types.js";
import { validateUsageEvent } from "../protocol/validation.js";
import { numberToPlainDecimal } from "./decimal.js";

export type ActualCostPlatformScope = readonly string[] | "*";
export type ActualCostRuntimeScope = readonly string[] | "*";

export interface ActualCostSourceDefinition {
  readonly source_id: string;
  readonly charge_source: ActualChargeSource;
  readonly billing_platforms?: ActualCostPlatformScope;
  readonly runtimes?: ActualCostRuntimeScope;
}

export interface ActualChargeObservation {
  readonly source_id: string;
  /** Prefer exact decimal text. Numbers are accepted for provider SDK compatibility and canonicalized immediately. */
  readonly amount: string | number;
  readonly currency: string;
  readonly external_charge_id?: string | null;
  readonly reported_at?: string | null;
}

interface NormalizedActualChargeObservation extends Omit<ActualChargeObservation, "amount"> {
  readonly amount: string;
}

export interface ActualChargeIngestResult {
  readonly event: UsageEvent;
  readonly source: ActualCostSourceDefinition;
  readonly replay: boolean;
}

export type ActualChargeIngestionErrorCode =
  | "ACTUAL_COST_SOURCE_INVALID"
  | "ACTUAL_COST_SOURCE_UNKNOWN"
  | "ACTUAL_COST_ROUTE_MISMATCH"
  | "ACTUAL_COST_CONFLICT";

export class ActualChargeIngestionError extends Error {
  readonly code: ActualChargeIngestionErrorCode;

  constructor(code: ActualChargeIngestionErrorCode, message: string) {
    super(message);
    this.name = "ActualChargeIngestionError";
    this.code = code;
  }
}

const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

function invalid(message: string): never {
  throw new ActualChargeIngestionError("ACTUAL_COST_SOURCE_INVALID", message);
}

function boundedString(value: unknown, path: string, max = 500): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    invalid(`${path}: must be a non-empty string up to ${max} characters`);
  }
  if (value.includes("\u0000")) invalid(`${path}: must not contain NUL`);
  return value;
}

function normalizeScope(value: ActualCostPlatformScope | ActualCostRuntimeScope | undefined, path: string): readonly string[] | "*" | undefined {
  if (value === undefined || value === "*") return value;
  if (!Array.isArray(value) || value.length === 0) invalid(`${path}: must be '*' or a non-empty list`);
  const entries = value.map((item, index) => boundedString(item, `${path}[${index}]`, 200));
  if (new Set(entries).size !== entries.length) invalid(`${path}: duplicate entries are not allowed`);
  return Object.freeze(entries);
}

function validateDefinition(value: ActualCostSourceDefinition, index: number): ActualCostSourceDefinition {
  const sourceId = boundedString(value.source_id, `sources[${index}].source_id`, 200);
  if (!(ACTUAL_CHARGE_SOURCES as readonly string[]).includes(value.charge_source)) {
    invalid(`sources[${index}].charge_source: must be one of ${ACTUAL_CHARGE_SOURCES.join(", ")}`);
  }
  const platforms = normalizeScope(value.billing_platforms, `sources[${index}].billing_platforms`);
  const runtimes = normalizeScope(value.runtimes, `sources[${index}].runtimes`);
  if (value.charge_source === "provider_reported" && platforms === undefined) {
    invalid(`sources[${index}].billing_platforms: provider-reported sources require platform scope`);
  }
  if (value.charge_source === "runtime_reported" && runtimes === undefined) {
    invalid(`sources[${index}].runtimes: runtime-reported sources require runtime scope`);
  }
  return Object.freeze({
    source_id: sourceId,
    charge_source: value.charge_source,
    ...(platforms === undefined ? {} : { billing_platforms: platforms }),
    ...(runtimes === undefined ? {} : { runtimes })
  });
}

function inScope(scope: readonly string[] | "*" | undefined, value: string | null | undefined): boolean {
  if (scope === undefined) return true;
  if (value === null || value === undefined) return false;
  return scope === "*" || scope.includes(value);
}

function normalizeObservation(observation: ActualChargeObservation): NormalizedActualChargeObservation {
  const sourceId = boundedString(observation.source_id, "observation.source_id", 200);
  let amount: string;
  if (typeof observation.amount === "number") {
    if (!Number.isFinite(observation.amount) || observation.amount < 0) {
      invalid("observation.amount: must be a finite non-negative number or exact decimal string");
    }
    amount = numberToPlainDecimal(observation.amount);
  } else if (typeof observation.amount === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(observation.amount)) {
    amount = observation.amount;
  } else {
    invalid("observation.amount: must be a finite non-negative number or exact decimal string");
  }
  const currency = boundedString(observation.currency, "observation.currency", 3);
  if (!CURRENCY_RE.test(currency)) invalid("observation.currency: must be a 3-letter uppercase currency code");
  const externalId = observation.external_charge_id === undefined || observation.external_charge_id === null
    ? observation.external_charge_id
    : boundedString(observation.external_charge_id, "observation.external_charge_id", 500);
  let reportedAt = observation.reported_at;
  if (reportedAt !== undefined && reportedAt !== null) {
    reportedAt = boundedString(reportedAt, "observation.reported_at", 64);
    if (!ISO_DATETIME_RE.test(reportedAt) || Number.isNaN(Date.parse(reportedAt))) {
      invalid("observation.reported_at: must be an ISO 8601 date-time with timezone");
    }
  }
  return Object.freeze({
    source_id: sourceId,
    amount,
    currency,
    ...(externalId === undefined ? {} : { external_charge_id: externalId }),
    ...(reportedAt === undefined ? {} : { reported_at: reportedAt })
  });
}

function chargesEqual(left: ActualCharge, right: ActualCharge): boolean {
  return left.amount === right.amount
    && left.currency === right.currency
    && left.source === right.source
    && (left.external_charge_id ?? null) === (right.external_charge_id ?? null)
    && (left.reported_at ?? null) === (right.reported_at ?? null);
}

export const FIRST_RELEASE_ACTUAL_COST_SOURCES: readonly ActualCostSourceDefinition[] = Object.freeze([
  Object.freeze({
    source_id: "openrouter-generation-api",
    charge_source: "provider_reported",
    billing_platforms: Object.freeze(["openrouter"])
  }),
  Object.freeze({
    source_id: "hermes-state-db",
    charge_source: "runtime_reported",
    runtimes: Object.freeze(["hermes"])
  }),
  Object.freeze({
    source_id: "commandcode-usage-api",
    charge_source: "provider_reported",
    billing_platforms: Object.freeze(["commandcode"])
  })
]);

export class ActualCostSourceRegistry {
  readonly #sources: ReadonlyMap<string, ActualCostSourceDefinition>;

  constructor(definitions: readonly ActualCostSourceDefinition[]) {
    const sources = new Map<string, ActualCostSourceDefinition>();
    definitions.forEach((definition, index) => {
      const normalized = validateDefinition(definition, index);
      if (sources.has(normalized.source_id)) invalid(`sources[${index}].source_id: duplicate source id '${normalized.source_id}'`);
      sources.set(normalized.source_id, normalized);
    });
    this.#sources = sources;
  }

  source(sourceId: string): ActualCostSourceDefinition | undefined {
    return this.#sources.get(sourceId);
  }

  list(): readonly ActualCostSourceDefinition[] {
    return Object.freeze([...this.#sources.values()]);
  }

  attach(eventValue: unknown, observationValue: ActualChargeObservation): ActualChargeIngestResult {
    const event = validateUsageEvent(eventValue);
    const observation = normalizeObservation(observationValue);
    const source = this.#sources.get(observation.source_id);
    if (source === undefined) {
      throw new ActualChargeIngestionError("ACTUAL_COST_SOURCE_UNKNOWN", `unknown actual-cost source '${observation.source_id}'`);
    }
    if (!inScope(source.billing_platforms, event.identity.billing_platform)) {
      throw new ActualChargeIngestionError(
        "ACTUAL_COST_ROUTE_MISMATCH",
        `source '${source.source_id}' is not trusted for billing platform '${event.identity.billing_platform ?? "unknown"}'`
      );
    }
    if (!inScope(source.runtimes, event.source.runtime)) {
      throw new ActualChargeIngestionError(
        "ACTUAL_COST_ROUTE_MISMATCH",
        `source '${source.source_id}' is not trusted for runtime '${event.source.runtime}'`
      );
    }

    const actualCharge: ActualCharge = {
      amount: observation.amount,
      currency: observation.currency,
      source: source.charge_source,
      ...(observation.external_charge_id === undefined ? {} : { external_charge_id: observation.external_charge_id }),
      ...(observation.reported_at === undefined ? {} : { reported_at: observation.reported_at })
    };

    if (event.actual_charge !== undefined && event.actual_charge !== null) {
      if (chargesEqual(event.actual_charge, actualCharge)) {
        return Object.freeze({ event, source, replay: true });
      }
      throw new ActualChargeIngestionError(
        "ACTUAL_COST_CONFLICT",
        `event '${event.event_id}' already carries a different actual charge`
      );
    }

    const normalizedEvent = validateUsageEvent({ ...event, actual_charge: actualCharge });
    return Object.freeze({ event: normalizedEvent, source, replay: false });
  }
}

export function createDefaultActualCostSourceRegistry(): ActualCostSourceRegistry {
  return new ActualCostSourceRegistry(FIRST_RELEASE_ACTUAL_COST_SOURCES);
}
