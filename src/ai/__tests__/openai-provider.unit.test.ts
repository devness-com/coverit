/**
 * Unit tests for openai-provider.ts
 * Tests OpenAIProvider with mocked fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAIProvider } from "../openai-provider.js";
import type { AIMessage } from "../types.js";

// ─── Fixtures ────────────────────────────────────────────────

const mockMessages: AIMessage[] = [
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "Hello!" },
];

const mockOpenAIResponse = {
  id: "chatcmpl-123",
  model: "gpt-4o",
  choices: [
    {
      message: { role: "assistant", content: "Hello! How can I help?" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
};

describe("OpenAIProvider", () => {
  const originalEnv = process.env;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env["OPENAI_API_KEY"];
    originalFetch = global.fetch;
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  describe("constructor", () => {
    it("has name 'openai' by default", () => {
      const provider = new OpenAIProvider();
      expect(provider.name).toBe("openai");
    });

    it("uses 'openai-compatible' name when configured", () => {
      const provider = new OpenAIProvider({
        provider: "openai-compatible",
        baseUrl: "https://my-custom-api.com",
      });
      expect(provider.name).toContain("openai-compatible");
      expect(provider.name).toContain("my-custom-api.com");
    });

    it("strips trailing slashes from baseUrl", () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOpenAIResponse),
      });
      global.fetch = mockFetch;

      const provider = new OpenAIProvider({
        apiKey: "sk-test",
        baseUrl: "https://api.example.com///",
      });
      // Verify via generate call
      provider.generate(mockMessages).then(() => {
        const url = mockFetch.mock.calls[0]![0];
        expect(url).toBe("https://api.example.com/chat/completions");
      });
    });
  });

  describe("isAvailable", () => {
    it("returns true when API key is set via config", async () => {
      const provider = new OpenAIProvider({ apiKey: "sk-test-123" });
      expect(await provider.isAvailable()).toBe(true);
    });

    it("returns true when API key is set via environment", async () => {
      process.env["OPENAI_API_KEY"] = "sk-env-123";
      const provider = new OpenAIProvider();
      expect(await provider.isAvailable()).toBe(true);
    });

    it("returns false when no API key", async () => {
      const provider = new OpenAIProvider();
      expect(await provider.isAvailable()).toBe(false);
    });

    it("returns false for empty string API key", async () => {
      const provider = new OpenAIProvider({ apiKey: "" });
      expect(await provider.isAvailable()).toBe(false);
    });
  });

  describe("generate", () => {
    it("throws when no API key is configured", async () => {
      const provider = new OpenAIProvider();
      await expect(provider.generate(mockMessages)).rejects.toThrow(
        "OpenAI API key not configured",
      );
    });

    it("makes a fetch request with correct headers", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOpenAIResponse),
      });
      global.fetch = mockFetch;

      const provider = new OpenAIProvider({ apiKey: "sk-test" });
      await provider.generate(mockMessages);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0]!;
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
      expect(opts.headers.Authorization).toBe("Bearer sk-test");
      expect(opts.headers["Content-Type"]).toBe("application/json");
    });

    it("includes all messages in the request body (including system)", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOpenAIResponse),
      });
      global.fetch = mockFetch;

      const provider = new OpenAIProvider({ apiKey: "sk-test" });
      await provider.generate(mockMessages);

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe("system");
      expect(body.messages[1].role).toBe("user");
    });

    it("returns parsed response with content and model", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOpenAIResponse),
      });

      const provider = new OpenAIProvider({ apiKey: "sk-test" });
      const result = await provider.generate(mockMessages);

      expect(result.content).toBe("Hello! How can I help?");
      expect(result.model).toBe("gpt-4o");
      expect(result.usage?.inputTokens).toBe(10);
      expect(result.usage?.outputTokens).toBe(20);
    });

    it("throws on non-ok HTTP response", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      });

      const provider = new OpenAIProvider({ apiKey: "sk-test" });
      await expect(provider.generate(mockMessages)).rejects.toThrow(
        "OpenAI API error (401): Unauthorized",
      );
    });

    it("throws when response has error field", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            ...mockOpenAIResponse,
            error: {
              type: "invalid_request_error",
              message: "Invalid model",
              code: "model_not_found",
            },
          }),
      });

      const provider = new OpenAIProvider({ apiKey: "sk-test" });
      await expect(provider.generate(mockMessages)).rejects.toThrow(
        "OpenAI API error: [invalid_request_error] Invalid model",
      );
    });

    it("throws when response has no content", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            ...mockOpenAIResponse,
            choices: [
              {
                message: { role: "assistant", content: null },
                finish_reason: "stop",
              },
            ],
          }),
      });

      const provider = new OpenAIProvider({ apiKey: "sk-test" });
      await expect(provider.generate(mockMessages)).rejects.toThrow(
        "returned no content",
      );
    });

    it("passes maxTokens and temperature options", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOpenAIResponse),
      });
      global.fetch = mockFetch;

      const provider = new OpenAIProvider({ apiKey: "sk-test" });
      await provider.generate(mockMessages, {
        maxTokens: 2048,
        temperature: 0.7,
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.max_tokens).toBe(2048);
      expect(body.temperature).toBe(0.7);
    });

    it("uses custom model when configured", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOpenAIResponse),
      });
      global.fetch = mockFetch;

      const provider = new OpenAIProvider({
        apiKey: "sk-test",
        model: "gpt-3.5-turbo",
      });
      await provider.generate(mockMessages);

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.model).toBe("gpt-3.5-turbo");
    });

    it("uses default max_tokens when not specified", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOpenAIResponse),
      });
      global.fetch = mockFetch;

      const provider = new OpenAIProvider({ apiKey: "sk-test" });
      await provider.generate(mockMessages);

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.max_tokens).toBe(8192);
    });

    it("handles missing usage data gracefully", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            ...mockOpenAIResponse,
            usage: undefined,
          }),
      });

      const provider = new OpenAIProvider({ apiKey: "sk-test" });
      const result = await provider.generate(mockMessages);
      expect(result.usage).toBeUndefined();
    });
  });
});
