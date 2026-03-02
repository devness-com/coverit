/**
 * OpenAI-Compatible Provider
 *
 * Works with OpenAI, Azure OpenAI, Groq, Together, and any other
 * service that implements the OpenAI Chat Completions API contract.
 * Uses fetch directly to avoid SDK dependencies.
 */

import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIGenerateOptions,
  AIProviderConfig,
} from "./types.js";

const DEFAULT_MODEL = "gpt-4o";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MAX_TOKENS = 8192;

/** OpenAI Chat Completions response shape (subset we care about) */
interface OpenAIResponse {
  id: string;
  model: string;
  choices: Array<{
    message: { role: string; content: string | null };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  error?: { message: string; type: string; code: string };
}

export class OpenAIProvider implements AIProvider {
  readonly name: string;
  readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly temperature: number | undefined;

  constructor(config?: Partial<AIProviderConfig>) {
    this.model = config?.model ?? DEFAULT_MODEL;
    this.apiKey = config?.apiKey ?? process.env["OPENAI_API_KEY"];
    this.baseUrl = (config?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxTokens = config?.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.temperature = config?.temperature;

    // Name reflects whether this is standard OpenAI or a compatible endpoint
    this.name =
      config?.provider === "openai-compatible"
        ? `openai-compatible (${this.baseUrl})`
        : "openai";
  }

  async isAvailable(): Promise<boolean> {
    return typeof this.apiKey === "string" && this.apiKey.length > 0;
  }

  async generate(
    messages: AIMessage[],
    options?: AIGenerateOptions,
  ): Promise<AIResponse> {
    const apiKey = this.apiKey;
    if (!apiKey) {
      throw new Error(
        "OpenAI API key not configured. Set OPENAI_API_KEY or pass apiKey in config.",
      );
    }

    const temperature = options?.temperature ?? this.temperature;

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: options?.maxTokens ?? this.maxTokens,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };

    if (temperature !== undefined) {
      body["temperature"] = temperature;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error("OpenAI API request timed out after 120s");
      }
      throw err;
    }
    clearTimeout(timeout);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `OpenAI API error (${response.status}): ${errorBody}`,
      );
    }

    const data = (await response.json()) as OpenAIResponse;

    if (data.error) {
      throw new Error(
        `OpenAI API error: [${data.error.type}] ${data.error.message}`,
      );
    }

    const firstChoice = data.choices[0];
    if (!firstChoice?.message.content) {
      throw new Error("OpenAI API returned no content in the response.");
    }

    return {
      content: firstChoice.message.content,
      model: data.model,
      usage: data.usage ? {
        inputTokens: data.usage.prompt_tokens ?? 0,
        outputTokens: data.usage.completion_tokens ?? 0,
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
