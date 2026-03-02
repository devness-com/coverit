/**
 * Anthropic API Provider
 *
 * Calls the Anthropic Messages API directly via fetch — no SDK dependency.
 * Requires an API key, either passed in config or via the ANTHROPIC_API_KEY
 * environment variable.
 */

import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIGenerateOptions,
  AIProviderConfig,
} from "./types.js";

const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 8192;

/** Anthropic's Messages API response shape (subset we care about) */
interface AnthropicResponse {
  id: string;
  model: string;
  content: Array<{ type: string; text?: string }>;
  stop_reason: string | null;
  usage?: { input_tokens: number; output_tokens: number };
  error?: { type: string; message: string };
}

export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly maxTokens: number;
  private readonly temperature: number | undefined;

  constructor(config?: Partial<AIProviderConfig>) {
    this.model = config?.model ?? DEFAULT_MODEL;
    this.apiKey = config?.apiKey ?? process.env["ANTHROPIC_API_KEY"];
    this.maxTokens = config?.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.temperature = config?.temperature;
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
        "Anthropic API key not configured. Set ANTHROPIC_API_KEY or pass apiKey in config.",
      );
    }

    // Anthropic's Messages API uses a separate `system` parameter
    // rather than a system role in the messages array.
    const systemMessages = messages.filter((m) => m.role === "system");
    const conversationMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: options?.maxTokens ?? this.maxTokens,
      messages: conversationMessages,
    };

    if (systemMessages.length > 0) {
      body["system"] = systemMessages.map((m) => m.content).join("\n\n");
    }

    const temperature = options?.temperature ?? this.temperature;
    if (temperature !== undefined) {
      body["temperature"] = temperature;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    let response: Response;
    try {
      response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": API_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error("Anthropic API request timed out after 120s");
      }
      throw err;
    }
    clearTimeout(timeout);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Anthropic API error (${response.status}): ${errorBody}`,
      );
    }

    const data = (await response.json()) as AnthropicResponse;

    if (data.error) {
      throw new Error(
        `Anthropic API error: [${data.error.type}] ${data.error.message}`,
      );
    }

    const textBlocks = data.content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text!);

    if (textBlocks.length === 0) {
      throw new Error("Anthropic API returned no text content blocks.");
    }

    return {
      content: textBlocks.join(""),
      model: data.model,
      usage: data.usage ? {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
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
