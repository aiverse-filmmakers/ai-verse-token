import type { UsageEvent } from "../protocol/types.js";
import { validateUsageEvent } from "../protocol/validation.js";
import { FIRST_RELEASE_ACTUAL_COST_SOURCES } from "./actual.js";

interface TrustedActualChargeProof {
  readonly sourceId: string;
  readonly canonicalEventJson: string;
}

const TRUSTED_ACTUAL_CHARGE_PROOF = Symbol("ai-verse-token.trusted-actual-charge");

type ProofCarrier = UsageEvent & {
  readonly [TRUSTED_ACTUAL_CHARGE_PROOF]?: TrustedActualChargeProof;
};

function proof(value: unknown): TrustedActualChargeProof | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as ProofCarrier)[TRUSTED_ACTUAL_CHARGE_PROOF];
}

function sourceDefinition(sourceId: string) {
  return FIRST_RELEASE_ACTUAL_COST_SOURCES.find((source) => source.source_id === sourceId);
}

function inScope(scope: readonly string[] | "*" | undefined, value: string | null | undefined): boolean {
  if (scope === undefined) return true;
  if (value === null || value === undefined) return false;
  return scope === "*" || scope.includes(value);
}

function sourceMatchesEvent(sourceId: string, event: UsageEvent): boolean {
  const source = sourceDefinition(sourceId);
  if (!source || event.actual_charge === undefined || event.actual_charge === null) return false;
  if (event.actual_charge.source !== source.charge_source) return false;
  if (!inScope(source.billing_platforms, event.identity.billing_platform)) return false;
  if (!inScope(source.runtimes, event.source.runtime)) return false;
  return true;
}

function canonical(event: UsageEvent): string {
  return JSON.stringify(event);
}

function attachProof(event: UsageEvent, value: TrustedActualChargeProof): UsageEvent {
  Object.defineProperty(event, TRUSTED_ACTUAL_CHARGE_PROOF, {
    value,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return event;
}

/**
 * Internal-only canonical admission issued by concrete trusted source adapters.
 *
 * This module is intentionally not exported through package.json. The public
 * ActualCostSourceRegistry validates source semantics but does not itself grant
 * canonical ledger authority.
 */
export function sealTrustedActualChargeEvent(eventValue: unknown, sourceId: string): UsageEvent {
  const event = validateUsageEvent(eventValue);
  if (!sourceMatchesEvent(sourceId, event)) {
    throw new TypeError(`Trusted ACTUAL source '${sourceId}' does not match the event route/charge`);
  }
  return attachProof(event, Object.freeze({
    sourceId,
    canonicalEventJson: canonical(event)
  }));
}

/**
 * Collector normalization creates a new canonical UsageEvent object. Preserve
 * a valid internal admission across that normalization without allowing plain
 * structural events to manufacture one.
 */
export function normalizeUsageEventWithTrustedActualChargeAdmission(value: unknown): UsageEvent {
  const event = validateUsageEvent(value);
  const existing = proof(value);
  if (
    existing
    && existing.canonicalEventJson === canonical(event)
    && sourceMatchesEvent(existing.sourceId, event)
  ) {
    return attachProof(event, existing);
  }
  return event;
}

export function hasTrustedActualChargeAdmission(value: unknown, event: UsageEvent): boolean {
  if (event.actual_charge === undefined || event.actual_charge === null) return true;
  const existing = proof(value);
  if (!existing) return false;
  return existing.canonicalEventJson === canonical(event)
    && sourceMatchesEvent(existing.sourceId, event);
}
