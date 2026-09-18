import { sealTrustedActualChargeEvent } from "../dist/src/cost/trusted-actual-admission.js";

export function trustedActual(event, sourceId = "openrouter-generation-api") {
  return sealTrustedActualChargeEvent(event, sourceId);
}
