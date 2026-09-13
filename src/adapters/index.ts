export { RemoteAdapterError } from "./common.js";
export type { RemoteAdapterErrorCode } from "./common.js";
export { normalizeOpenRouterGeneration } from "./openrouter.js";
export type { OpenRouterGenerationNormalizationResult } from "./openrouter.js";
export { normalizeCommandCodeUsageRecord, normalizeCommandCodeUsageWindows } from "./command-code.js";
export type {
  CommandCodeUsageNormalizationResult,
  CommandCodeUsageWindowSnapshot,
  CommandCodeWindow
} from "./command-code.js";

export { normalizeOpenAIResponse, OPENAI_PRICING_SOURCE_ID } from "./openai.js";
export type { OpenAIResponseNormalizationResult } from "./openai.js";
export { normalizeAnthropicMessage, ANTHROPIC_PRICING_SOURCE_ID } from "./anthropic.js";
export type { AnthropicMessageNormalizationResult, AnthropicMessageOptions } from "./anthropic.js";
export { normalizeGoogleGeminiResponse, GOOGLE_GEMINI_PRICING_SOURCE_ID } from "./google-gemini.js";
export type { GoogleGeminiNormalizationResult, GoogleGeminiOptions } from "./google-gemini.js";
export { normalizeOpenTelemetryGenAISpan } from "./opentelemetry.js";
export type {
  OpenTelemetryGenAINormalizationResult,
  OpenTelemetryGenAISpanOptions
} from "./opentelemetry.js";
export {
  normalizeBifrostLog,
  normalizeLiteLLMSpendLog,
  normalizeOpenAICompatibleGateway
} from "./gateways.js";
export type {
  BifrostLogOptions,
  GatewayNormalizationResult,
  LiteLLMSpendLogOptions,
  OpenAICompatibleGatewayOptions
} from "./gateways.js";
