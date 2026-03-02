/**
 * Ollama Local Provider
 *
 * Connects to a locally running Ollama instance for fully offline,
 * zero-cost AI inference. Ollama must be running before use.
 * Default model is llama3.1 but any Ollama-supported model works.
 */

import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIGenerateOptions,
  AIProviderConfig,
} from "./types.js";

const DEFAULT_MODEL = "llama3.1";
const DEFAULT_BASE_URL = "http://localhost:11434";

/** Ollama /api/chat response shape */
interface OllamaChatResponse {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  total_duration?: number;
  eval_count?: number;
  error?: string;
}

/** Ollama /api/tags response shape */
interface OllamaTagsResponse {
  models: Array<{ name: string }>;
}

export class OllamaProvider implements AIProvider {
  readonly name = "ollama";
  readonly model: string;
  private readonly baseUrl: string;

  constructor(config?: Partial<AIProviderConfig>) {
    this.model = config?.model ?? DEFAULT_MODEL;
    this.baseUrl = (config?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);

      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) return false;

      // Verify the response looks like Ollama (has a models array)
      const data = (await response.json()) as OllamaTagsResponse;
      return Array.isArray(data.models);
    } catch {
      // Connection refused, timeout, or parse error means Ollama is not running
      return false;
    }
  }

  async generate(
    messages: AIMessage[],
    options?: AIGenerateOptions,
  ): Promise<AIResponse> {
    // Ollama's chat endpoint accepts the same message format as OpenAI
    const ollamaMessages = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const body: Record<string, unknown> = {
      model: this.model,
      messages: ollamaMessages,
      stream: false,
    };

    // Ollama uses an `options` object for generation parameters
    const ollamaOptions: Record<string, unknown> = {};
    if (options?.maxTokens) {
      ollamaOptions["num_predict"] = options.maxTokens;
    }
    if (options?.temperature !== undefined) {
      ollamaOptions["temperature"] = options.temperature;
    }
    if (Object.keys(ollamaOptions).length > 0) {
      body["options"] = ollamaOptions;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error("Ollama request timed out after 120s");
      }
      throw new Error(
        `Failed to connect to Ollama at ${this.baseUrl}. Is Ollama running? Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    clearTimeout(timeout);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Ollama API error (${response.status}): ${errorBody}`,
      );
    }

    const data = (await response.json()) as OllamaChatResponse;

    if (data.error) {
      throw new Error(`Ollama error: ${data.error}`);
    }

    if (!data.message?.content) {
      throw new Error("Ollama returned no content in the response.");
    }

    return {
      content: data.message.content,
      model: data.model,
      usage: typeof data.eval_count === "number" ? {
        inputTokens: 0,
        outputTokens: data.eval_count,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        totalCostUsd: 0,
        durationMs: 0,
        durationApiMs: 0,
        numTurns: 1,
      } : undefined,
    };
  }
}
