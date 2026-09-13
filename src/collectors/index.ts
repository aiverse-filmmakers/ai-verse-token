export { CollectorRegistry, CollectorRegistryError } from "./registry.js";
export type { CollectorRegistryErrorCode } from "./registry.js";
export { COLLECTOR_RUN_LIMITS, CollectorExecutionError, CollectorRunner } from "./runner.js";
export type { CollectorExecutionErrorCode } from "./runner.js";
export type {
  CollectorDefinition,
  CollectorDetection,
  CollectorDetectionStatus,
  CollectorEmission,
  CollectorHealth,
  CollectorHealthStatus,
  CollectorRunRequest,
  CollectorRunResult,
  CollectorRuntimeScope,
  CollectorScanRequest,
  CollectorScanResult,
  TokenCollector
} from "./types.js";

export { HERMES_PASSIVE_COLLECTOR, HermesCollectorError, discoverHermesStateSources } from "./hermes.js";
export type { HermesStateDiscoveryOptions, HermesStateSource } from "./hermes.js";

export { CLAUDE_CODE_COLLECTOR, discoverClaudeCodeSources } from "./claude-code.js";
export type { ClaudeCodeDiscoveryOptions } from "./claude-code.js";
export { CODEX_COLLECTOR, discoverCodexSources } from "./codex.js";
export type { CodexDiscoveryOptions } from "./codex.js";
export { OPENCODE_COLLECTOR, discoverOpenCodeSources } from "./opencode.js";
export type { OpenCodeDiscoveryOptions } from "./opencode.js";
export { GEMINI_CLI_COLLECTOR, discoverGeminiCliSources } from "./gemini-cli.js";
export type { GeminiCliDiscoveryOptions } from "./gemini-cli.js";
export { OPENCLAW_COLLECTOR, discoverOpenClawSources } from "./openclaw.js";
export type { OpenClawDiscoveryOptions } from "./openclaw.js";
export { LocalCollectorError } from "./local-common.js";
export type { LocalFileSource, LocalDbSource } from "./local-common.js";
