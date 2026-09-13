export const PRICE_PROTOCOL_VERSION = "ai-verse-token-price/0.1" as const;

export const PRICE_SOURCE_AUTHORITIES = [
  "provider_pricing_api",
  "official_public_pricing",
  "secondary_catalog"
] as const;

export const PRICE_VERIFICATION_STATUSES = [
  "verified",
  "cross_checked",
  "unverified",
  "disputed"
] as const;

export const PRICE_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export const PRICE_CONTEXT_BASES = [
  "input_tokens",
  "input_plus_cache_read_tokens"
] as const;

export const PRICE_RATE_FIELDS = [
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cached_input_tokens",
  "audio_input_tokens",
  "audio_output_tokens",
  "image_input_units",
  "image_output_units",
  "web_search_units",
  "request_units"
] as const;

export const PRICE_PROTOCOL_LIMITS = Object.freeze({
  maxIdLength: 500,
  maxShortTextLength: 200,
  maxModelLength: 500,
  maxUrlLength: 2_000,
  maxEtagLength: 1_000,
  maxRateScale: 1_000_000_000,
  maxConditionCount: Number.MAX_SAFE_INTEGER,
  maxUtcWindows: 24,
  maxDecimalIntegerDigits: 18,
  maxDecimalFractionDigits: 18
});
