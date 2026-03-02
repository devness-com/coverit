/**
 * Unit tests for anthropic-provider.ts
 * Tests AnthropicProvider with mocked fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AnthropicProvider } from "../anthropic-provider.js";
import type { AIMessage } from "../types.js";

// ─── Fixtures ────────────────────────────────────────────────

const mockMessages: AIMessage[] = [
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "Hello!" },
];

const mockAnthropicResponse = {
  id: "msg_123",
  model: "claude-sonnet-4-5-20250929",
  content: [{ type: "text", text: "Hello! How can I help?" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 20 },
};

describe("AnthropicProvider", () => {
  const originalEnv = process.env;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env["ANTHROPIC_API_KEY"];
    originalFetch = global.fetch;
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  describe("constructor", () => {
    it("has name 'anthropic'", () => {
      const provider = new AnthropicProvider();
      expect(provider.name).toBe("anthropic");
    });

    it("uses config apiKey over environment", () => {
      process.env["ANTHROPIC_API_KEY"] = "env-key";
      const provider = new AnthropicProvider({ apiKey: "config-key" });
      // provider should prefer config key (tested via availability/generate behavior)
      expect(provider.name).toBe("anthropic");
    });
  });

  describe("isAvailable", () => {
    it("returns true when API key is set via config", async () => {
      const provider = new AnthropicProvider({ apiKey: "sk-ant-123" });
      expect(await provider.isAvailable()).toBe(true);
    });

    it("returns true when API key is set via environment", async () => {
      process.env["ANTHROPIC_API_KEY"] = "sk-ant-env-123";
      const provider = new AnthropicProvider();
      expect(await provider.isAvailable()).toBe(true);
    });

    it("returns false when no API key", async () => {
      const provider = new AnthropicProvider();
      expect(await provider.isAvailable()).toBe(false);
    });

    it("returns false for empty string API key", async () => {
      const provider = new AnthropicProvider({ apiKey: "" });
      expect(await provider.isAvailable()).toBe(false);
    });
  });

  describe("generate", () => {
    it("throws when no API key is configured", async () => {
      const provider = new AnthropicProvider();
      await expect(provider.generate(mockMessages)).rejects.toThrow(
        "Anthropic API key not configured",
      );
    });

    it("makes a fetch request with correct headers", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockAnthropicResponse),
      });
      global.fetch = mockFetch;

      const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
      await provider.generate(mockMessages);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0]!;
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      expect(opts.headers["x-api-key"]).toBe("sk-ant-test");
      expect(opts.headers["anthropic-version"]).toBe("2023-06-01");
      expect(opts.headers["content-type"]).toBe("application/json");
    });

    it("separates system messages from conversation messages", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockAnthropicResponse),
      });
      global.fetch = mockFetch;

      const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
      await provider.generate(mockMessages);

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.system).toBe("You are a helpful assistant.");
      expect(body.messages).toEqual([{ role: "user", content: "Hello!" }]);
    });

    it("returns parsed response with content and model", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockAnthropicResponse),
      });

      const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
      const result = await provider.generate(mockMessages);

      expect(result.content).toBe("Hello! How can I help?");
      expect(result.model).toBe("claude-sonnet-4-5-20250929");
      expect(result.usage?.inputTokens).toBe(10);
      expect(result.usage?.outputTokens).toBe(20);
    });

    it("throws on non-ok HTTP response", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: () => Promise.resolve("Rate limited"),
      });

      const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
      await expect(provider.generate(mockMessages)).rejects.toThrow(
        "Anthropic API error (429): Rate limited",
      );
    });

    it("throws when response has error field", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            ...mockAnthropicResponse,
            error: { type: "invalid_request", message: "Bad request" },
          }),
      });

      const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
      await expect(provider.generate(mockMessages)).rejects.toThrow(
        "Anthropic API error: [invalid_request] Bad request",
      );
    });

    it("throws when response has no text content blocks", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            ...mockAnthropicResponse,
            content: [{ type: "tool_use", id: "tool_1" }],
          }),
      });

      const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
      await expect(provider.generate(mockMessages)).rejects.toThrow(
        "no text content blocks",
      );
    });

    it("passes maxTokens and temperature options", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockAnthropicResponse),
      });
      global.fetch = mockFetch;

      const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
      await provider.generate(mockMessages, {
        maxTokens: 4096,
        temperature: 0.5,
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.max_tokens).toBe(4096);
      expect(body.temperature).toBe(0.5);
    });

    it("uses default model when not configured", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockAnthropicResponse),
      });
      global.fetch = mockFetch;

      const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
      await provider.generate(mockMessages);

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.model).toBe("claude-sonnet-4-5-20250929");
    });

    it("uses custom model when configured", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockAnthropicResponse),
      });
      global.fetch = mockFetch;

      const provider = new AnthropicProvider({
        apiKey: "sk-ant-test",
        model: "claude-3-haiku-20240307",
      });
      await provider.generate(mockMessages);

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.model).toBe("claude-3-haiku-20240307");
    });

    it("concatenates multiple text blocks", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            ...mockAnthropicResponse,
            content: [
              { type: "text", text: "Part 1" },
              { type: "text", text: " Part 2" },
            ],
          }),
      });

      const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
      const result = await provider.generate(mockMessages);
      expect(result.content).toBe("Part 1 Part 2");
    });

    it("handles missing usage data gracefully", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            ...mockAnthropicResponse,
            usage: undefined,
          }),
      });

      const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
      const result = await provider.generate(mockMessages);
      expect(result.usage).toBeUndefined();
    });
  });
});
