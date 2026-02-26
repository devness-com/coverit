/**
 * AI Provider Factory
 *
 * Creates the appropriate AI provider based on explicit config or
 * auto-detection. Detection order reflects cost/convenience tradeoffs:
 *
 *   1. Claude CLI  -- free if user has Pro/Max subscription
 *   2. Gemini CLI  -- free if user has Google AI subscription
 *   3. Codex CLI   -- free if user has OpenAI subscription
 *   4. Anthropic   -- best quality, requires API key
 *   5. OpenAI      -- widely available, requires API key
 *   6. Ollama      -- free & local, but quality varies by model
 *
 * The COVERIT_AI_PROVIDER env var can override auto-detection.
 */

import type { AIProvider, AIProviderConfig, AIProviderType } from "./types.js";
import { ClaudeCliProvider } from "./claude-cli-provider.js";
import { GeminiCliProvider } from "./gemini-cli-provider.js";
import { CodexCliProvider } from "./codex-cli-provider.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { OpenAIProvider } from "./openai-provider.js";
import { OllamaProvider } from "./ollama-provider.js";

/**
 * Create a provider from an explicit configuration.
 * Throws if the specified provider is not available.
 */
export async function createAIProvider(
  config?: AIProviderConfig,
): Promise<AIProvider> {
  // If no config, fall through to auto-detection
  if (!config) {
    return detectBestProvider();
  }

  const provider = buildProvider(config.provider, config);

  const available = await provider.isAvailable();
  if (!available) {
    throw new Error(
      `AI provider "${config.provider}" is not available. ${getProviderHint(config.provider)}`,
    );
  }

  return provider;
}

/**
 * Auto-detect the best available AI provider by probing each one
 * in priority order. Prefers providers that are free or already
 * configured.
 */
export async function detectBestProvider(): Promise<AIProvider> {
  // Allow env var to force a specific provider
  const envProvider = process.env["COVERIT_AI_PROVIDER"] as
    | AIProviderType
    | undefined;

  if (envProvider) {
    const provider = buildProvider(envProvider);
    const available = await provider.isAvailable();
    if (available) return provider;

    throw new Error(
      `COVERIT_AI_PROVIDER is set to "${envProvider}" but it is not available. ${getProviderHint(envProvider)}`,
    );
  }

  // Probe providers in priority order — CLI wrappers first (free via
  // existing subscriptions), then API-key providers, then local.
  const candidates: AIProvider[] = [
    new ClaudeCliProvider(),
    new GeminiCliProvider(),
    new CodexCliProvider(),
    new AnthropicProvider(),
    new OpenAIProvider(),
    new OllamaProvider(),
  ];

  for (const candidate of candidates) {
    const available = await candidate.isAvailable();
    if (available) return candidate;
  }

  throw new Error(
    [
      "No AI provider available. Configure one of the following:",
      "",
      "  1. Install Claude Code CLI (uses your Pro/Max subscription):",
      "     https://docs.anthropic.com/en/docs/claude-code",
      "",
      "  2. Install Gemini CLI (uses your Google AI subscription):",
      "     https://github.com/google-gemini/gemini-cli",
      "",
      "  3. Install Codex CLI (uses your OpenAI subscription):",
      "     https://github.com/openai/codex",
      "",
      "  4. Set ANTHROPIC_API_KEY for Anthropic API access",
      "",
      "  5. Set OPENAI_API_KEY for OpenAI API access",
      "",
      "  6. Run Ollama locally: https://ollama.com",
      "",
      "Or set COVERIT_AI_PROVIDER to force a specific provider.",
    ].join("\n"),
  );
}

/** Instantiate a provider by type without checking availability */
function buildProvider(
  type: AIProviderType,
  config?: Partial<AIProviderConfig>,
): AIProvider {
  switch (type) {
    case "claude-cli":
      return new ClaudeCliProvider(config);
    case "gemini-cli":
      return new GeminiCliProvider(config);
    case "codex-cli":
      return new CodexCliProvider(config);
    case "anthropic":
      return new AnthropicProvider(config);
    case "openai":
      return new OpenAIProvider(config);
    case "ollama":
      return new OllamaProvider(config);
    case "openai-compatible":
      return new OpenAIProvider({ ...config, provider: "openai-compatible" });
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown AI provider type: ${_exhaustive}`);
    }
  }
}

/** Return a setup hint for a specific provider */
function getProviderHint(type: AIProviderType): string {
  switch (type) {
    case "claude-cli":
      return "Install Claude Code: https://docs.anthropic.com/en/docs/claude-code";
    case "gemini-cli":
      return "Install the Gemini CLI: https://github.com/google-gemini/gemini-cli";
    case "codex-cli":
      return "Install the Codex CLI: https://github.com/openai/codex";
    case "anthropic":
      return "Set the ANTHROPIC_API_KEY environment variable.";
    case "openai":
    case "openai-compatible":
      return "Set the OPENAI_API_KEY environment variable.";
    case "ollama":
      return "Start Ollama: ollama serve";
    default:
      return "";
  }
}
