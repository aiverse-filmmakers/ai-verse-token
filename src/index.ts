export const PACKAGE_NAME = "@ai-verse/token" as const;
export const PACKAGE_VERSION = "0.1.0-beta.3" as const;
export const EXTENSION_ID = "ai-verse-token" as const;
export const PROTOCOL_VERSION = "ai-verse-token/0.1" as const;

export type { CostStatus } from "./protocol/types.js";
export { COST_STATUSES } from "./protocol/constants.js";
export { TokenProtocolValidationError, validateCostStatus, validateUsageEvent } from "./protocol/validation.js";

export { PRICE_PROTOCOL_VERSION } from "./pricing/constants.js";
export type { PriceSnapshot } from "./pricing/types.js";
export { PriceProtocolValidationError, validatePriceSnapshot } from "./pricing/validation.js";

export interface BuildIdentity {
  readonly packageName: typeof PACKAGE_NAME;
  readonly packageVersion: typeof PACKAGE_VERSION;
  readonly extensionId: typeof EXTENSION_ID;
  readonly protocolVersion: typeof PROTOCOL_VERSION;
}

export function getBuildIdentity(): BuildIdentity {
  return {
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    extensionId: EXTENSION_ID,
    protocolVersion: PROTOCOL_VERSION
  };
}
