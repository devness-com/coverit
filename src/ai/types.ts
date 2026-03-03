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
  | "gemini-cli"
  | "codex-cli"
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

/** Token usage statistics from a single AI generation call */
export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalCostUsd: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
}

export interface AIResponse {
  content: string;
  model: string;
  usage?: AIUsage;
}

/** Progress events emitted during AI generation (streaming) */
export type AIProgressEvent =
  | { type: "tool_use"; tool: string; input?: string }
  | { type: "tool_result"; tool: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking"; text: string }
  | { type: "phase"; name: string; step: number; total: number }
  | { type: "dimension_status"; name: string; status: "running" | "done" | "failed"; detail?: string }
  | { type: "module_status"; name: string; status: "pending" | "running" | "done" | "failed" | "timed_out"; stats?: { testsWritten: number; testsPassed: number; testsFailed: number } }
  | { type: "model_detected"; model: string };

export interface AIGenerateOptions {
  maxTokens?: number;
  temperature?: number;
  /** Built-in tools the AI can use (e.g. ["Read", "Grep", "Glob"]) — Claude CLI only */
  allowedTools?: string[];
  /** Working directory for tool access — Claude CLI only */
  cwd?: string;
  /** Inactivity timeout in milliseconds — Claude CLI only. Resets on each output chunk. Defaults to 600_000 (10 min). */
  timeoutMs?: number;
  /** Absolute wall-time timeout in milliseconds — Claude CLI only. Kills process regardless of activity. Defaults to 1_800_000 (30 min). */
  maxWallTimeMs?: number;
  /** Callback for streaming progress events — Claude CLI only */
  onProgress?: (event: AIProgressEvent) => void;
}

export interface AIProvider {
  readonly name: string;
  /** Configured model ID, if known (e.g. "claude-opus-4-6"). May be undefined for CLI providers using defaults. */
  readonly model?: string;
  generate(
    messages: AIMessage[],
    options?: AIGenerateOptions,
  ): Promise<AIResponse>;
  isAvailable(): Promise<boolean>;
}
