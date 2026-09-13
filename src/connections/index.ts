import { safeId } from "../ecosystem-common.js";

export interface TokenCredentialHandle {
  readonly connection_id: string;
  readonly credential_name: string;
  readonly billing_platform: string;
  readonly inference_provider?: string;
  readonly contains_secret: false;
}

export function createTokenCredentialHandle(input: {
  readonly connection_id: string;
  readonly credential_name: string;
  readonly billing_platform: string;
  readonly inference_provider?: string;
}): TokenCredentialHandle {
  const allowed = new Set(["connection_id", "credential_name", "billing_platform", "inference_provider"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`Unsupported credential-handle field '${key}'; Token accepts references only, never secret values`);
  }
  const connection_id = safeId(input.connection_id, "connection_id");
  const credential_name = safeId(input.credential_name, "credential_name");
  const billing_platform = safeId(input.billing_platform, "billing_platform");
  const inference_provider = input.inference_provider === undefined ? undefined : safeId(input.inference_provider, "inference_provider");
  return Object.freeze({
    connection_id,
    credential_name,
    billing_platform,
    ...(inference_provider === undefined ? {} : { inference_provider }),
    contains_secret: false
  });
}
