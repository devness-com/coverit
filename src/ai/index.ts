/**
 * AI Provider Layer — Barrel Exports
 *
 * This module is the public API for coverit's AI integration.
 * Import everything you need from "@coverit/ai" (or "./ai").
 */

// Types
export type {
  AIProviderType,
  AIProviderConfig,
  AIMessage,
  AIResponse,
  AIGenerateOptions,
  AIProvider,
} from "./types.js";

// Providers
export { ClaudeCliProvider } from "./claude-cli-provider.js";
export { GeminiCliProvider } from "./gemini-cli-provider.js";
export { CodexCliProvider } from "./codex-cli-provider.js";
export { AnthropicProvider } from "./anthropic-provider.js";
export { OpenAIProvider } from "./openai-provider.js";
export { OllamaProvider } from "./ollama-provider.js";

// Factory
export { createAIProvider, detectBestProvider } from "./provider-factory.js";

// Prompts
export {
  buildTestGenerationPrompt,
  buildTestRefinementPrompt,
} from "./prompts.js";
export type {
  TestGenerationParams,
  TestRefinementParams,
} from "./prompts.js";

// Triage prompts
export {
  buildTriagePrompt,
  parseTriageResponse,
} from "./triage-prompts.js";

// Specialized test type prompts
export { buildIntegrationPrompt } from "./integration-prompts.js";
export type { IntegrationPromptParams } from "./integration-prompts.js";
export { buildApiPrompt } from "./api-prompts.js";
export type { ApiPromptParams } from "./api-prompts.js";
export { buildContractPrompt } from "./contract-prompts.js";
export type { ContractPromptParams } from "./contract-prompts.js";
