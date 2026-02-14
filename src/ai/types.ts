/**
 * AI Provider Types
 *
 * Defines the contract for all AI providers used in CLI mode.
 * When running as an MCP server inside Claude Code, Claude IS the AI
 * and none of these providers are used. This layer exists solely for
 * standalone CLI usage where we need to call an LLM directly.
 */

export type AIProviderType =
  | "claude-cli"
  | "anthropic"
  | "openai"
  | "ollama"
  | "openai-compatible";

export interface AIProviderConfig {
  provider: AIProviderType;
  model?: string;
  apiKey?: string;
  /** Base URL override for ollama or openai-compatible endpoints */
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AIResponse {
  content: string;
  model: string;
  tokensUsed?: number;
  truncated?: boolean;
}

export interface AIGenerateOptions {
  maxTokens?: number;
  temperature?: number;
  /** Built-in tools the AI can use (e.g. ["Read", "Grep", "Glob"]) — Claude CLI only */
  allowedTools?: string[];
  /** Working directory for tool access — Claude CLI only */
  cwd?: string;
  /** Timeout in milliseconds — Claude CLI only. Defaults to 600_000 (10 min). */
  timeoutMs?: number;
}

export interface AIProvider {
  readonly name: string;
  generate(
    messages: AIMessage[],
    options?: AIGenerateOptions,
  ): Promise<AIResponse>;
  isAvailable(): Promise<boolean>;
}
