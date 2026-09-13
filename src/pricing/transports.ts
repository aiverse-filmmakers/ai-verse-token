import { createHash } from "node:crypto";
import { URL } from "node:url";
import type { PriceSnapshot } from "./types.js";
import type { PricingFetcher, PricingFetchRequest, PricingFetchResult } from "./sync.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

export class PricingTransportError extends Error {
  readonly code: "PRICING_TRANSPORT_INVALID" | "PRICING_TRANSPORT_HTTP" | "PRICING_TRANSPORT_TOO_LARGE";
  constructor(code: PricingTransportError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PricingTransportError";
    this.code = code;
  }
}

function httpsUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new PricingTransportError("PRICING_TRANSPORT_INVALID", "pricing endpoint must be a valid URL"); }
  if (parsed.protocol !== "https:") throw new PricingTransportError("PRICING_TRANSPORT_INVALID", "pricing endpoint must use https");
  if (parsed.username || parsed.password) throw new PricingTransportError("PRICING_TRANSPORT_INVALID", "pricing endpoint must not embed credentials");
  return parsed.toString();
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function boundedFetch(url: string, headers: Readonly<Record<string, string>>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{
  readonly status: number;
  readonly etag?: string;
  readonly body: Uint8Array;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal, redirect: "error" });
    if (response.status === 304) return Object.freeze({ status: 304, ...(response.headers.get("etag") === null ? {} : { etag: response.headers.get("etag") as string }), body: new Uint8Array() });
    if (!response.ok) throw new PricingTransportError("PRICING_TRANSPORT_HTTP", `pricing endpoint returned HTTP ${response.status}`);
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) throw new PricingTransportError("PRICING_TRANSPORT_TOO_LARGE", "pricing response exceeds maximum size");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new PricingTransportError("PRICING_TRANSPORT_TOO_LARGE", "pricing response exceeds maximum size");
    return Object.freeze({ status: response.status, ...(response.headers.get("etag") === null ? {} : { etag: response.headers.get("etag") as string }), body: bytes });
  } finally {
    clearTimeout(timeout);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function decimal(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value)) return undefined;
  return value;
}

function snapshotId(model: string, rates: Readonly<Record<string, unknown>>, checkedAt: string): string {
  const hash = createHash("sha256").update(JSON.stringify({ model, rates, checkedAt })).digest("hex");
  return `openrouter:${model}:${hash}`;
}

function openRouterSnapshots(payload: unknown, checkedAt: string): readonly PriceSnapshot[] {
  const root = record(payload);
  if (root === null || !Array.isArray(root.data)) throw new PricingTransportError("PRICING_TRANSPORT_INVALID", "OpenRouter models response must contain data[]");
  const snapshots: PriceSnapshot[] = [];
  for (const item of root.data) {
    const model = record(item);
    const pricing = record(model?.pricing);
    const id = typeof model?.id === "string" ? model.id : null;
    if (id === null || id.length < 1 || id.length > 500 || pricing === null) continue;
    const rates: Record<string, { amount: string; per: number }> = {};
    const input = decimal(pricing.prompt);
    const output = decimal(pricing.completion);
    const cacheRead = decimal(pricing.input_cache_read ?? pricing.cache_read);
    const cacheWrite = decimal(pricing.input_cache_write ?? pricing.cache_write);
    const request = decimal(pricing.request);
    const webSearch = decimal(pricing.web_search);
    if (input !== undefined) rates.input_tokens = { amount: input, per: 1 };
    if (output !== undefined) rates.output_tokens = { amount: output, per: 1 };
    if (cacheRead !== undefined) rates.cache_read_tokens = { amount: cacheRead, per: 1 };
    if (cacheWrite !== undefined) rates.cache_write_tokens = { amount: cacheWrite, per: 1 };
    if (request !== undefined) rates.request_units = { amount: request, per: 1 };
    if (webSearch !== undefined) rates.web_search_units = { amount: webSearch, per: 1 };
    if (Object.keys(rates).length === 0) continue;
    snapshots.push(Object.freeze({
      schema_version: "ai-verse-token-price/0.1",
      price_snapshot_id: snapshotId(id, rates, checkedAt),
      identity: Object.freeze({ billing_platform: "openrouter", resolved_model: id, provider_model_id: id }),
      currency: "USD",
      effective: Object.freeze({ starts_at: checkedAt }),
      rates: Object.freeze(rates),
      source: Object.freeze({ authority: "provider_pricing_api", source_id: "openrouter-models-api", source_url: OPENROUTER_MODELS_URL, retrieved_at: checkedAt }),
      verification: Object.freeze({ status: "verified", verified_at: checkedAt })
    }));
  }
  return Object.freeze(snapshots);
}

/**
 * Concrete first-party transport for OpenRouter's live model catalog.
 * Credentials are read from the environment at request time and are never persisted by Token.
 */
export function createOpenRouterModelsFetcher(options: {
  readonly api_key_env?: string;
  readonly endpoint?: string;
  readonly timeout_ms?: number;
} = {}): PricingFetcher {
  const endpoint = httpsUrl(options.endpoint ?? OPENROUTER_MODELS_URL);
  const envName = options.api_key_env ?? "OPENROUTER_API_KEY";
  return Object.freeze({
    source_id: "openrouter-models-api",
    async fetch(request: PricingFetchRequest): Promise<PricingFetchResult> {
      const headers: Record<string, string> = { accept: "application/json" };
      const key = process.env[envName];
      if (typeof key === "string" && key.length > 0) headers.authorization = `Bearer ${key}`;
      if (request.previous_etag !== undefined) headers["if-none-match"] = request.previous_etag;
      const result = await boundedFetch(endpoint, headers, options.timeout_ms);
      if (result.status === 304) return Object.freeze({ status: "not_modified", checked_at: request.now, ...(result.etag === undefined ? {} : { etag: result.etag }) });
      const bodyDigest = digest(result.body);
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder().decode(result.body)); }
      catch (error) { throw new PricingTransportError("PRICING_TRANSPORT_INVALID", "OpenRouter models response is not valid JSON", { cause: error }); }
      const snapshots = openRouterSnapshots(payload, request.now);
      return Object.freeze({ status: "updated", checked_at: request.now, snapshots, ...(result.etag === undefined ? {} : { etag: result.etag }), content_digest_sha256: bodyDigest });
    }
  });
}

/**
 * Source-bound transport for a Token-native pricing manifest: {"snapshots":[...]}.
 * The PricingSynchronizer still replaces source_id/authority with the trusted host registry definition.
 */
export function createTokenPriceManifestFetcher(options: {
  readonly source_id: string;
  readonly endpoint: string;
  readonly bearer_token_env?: string;
  readonly timeout_ms?: number;
}): PricingFetcher {
  const endpoint = httpsUrl(options.endpoint);
  if (!/^[a-z][a-z0-9]*(?:[-_.:][a-z0-9]+)*$/.test(options.source_id)) throw new PricingTransportError("PRICING_TRANSPORT_INVALID", "source_id is invalid");
  return Object.freeze({
    source_id: options.source_id,
    async fetch(request: PricingFetchRequest): Promise<PricingFetchResult> {
      const headers: Record<string, string> = { accept: "application/json" };
      if (options.bearer_token_env !== undefined) {
        const token = process.env[options.bearer_token_env];
        if (typeof token === "string" && token.length > 0) headers.authorization = `Bearer ${token}`;
      }
      if (request.previous_etag !== undefined) headers["if-none-match"] = request.previous_etag;
      const result = await boundedFetch(endpoint, headers, options.timeout_ms);
      if (result.status === 304) return Object.freeze({ status: "not_modified", checked_at: request.now, ...(result.etag === undefined ? {} : { etag: result.etag }) });
      const bodyDigest = digest(result.body);
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder().decode(result.body)); }
      catch (error) { throw new PricingTransportError("PRICING_TRANSPORT_INVALID", "pricing manifest response is not valid JSON", { cause: error }); }
      const root = record(payload);
      if (root === null || !Array.isArray(root.snapshots)) throw new PricingTransportError("PRICING_TRANSPORT_INVALID", "pricing manifest must contain snapshots[]");
      return Object.freeze({ status: "updated", checked_at: request.now, snapshots: Object.freeze(root.snapshots), ...(result.etag === undefined ? {} : { etag: result.etag }), content_digest_sha256: bodyDigest });
    }
  });
}

export const PRICING_TRANSPORT_LIMITS = Object.freeze({
  default_timeout_ms: DEFAULT_TIMEOUT_MS,
  max_response_bytes: MAX_RESPONSE_BYTES,
  openrouter_models_url: OPENROUTER_MODELS_URL
});
