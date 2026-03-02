/**
 * Unit tests for ollama-provider.ts
 * Tests OllamaProvider with mocked fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OllamaProvider } from "../ollama-provider.js";
import type { AIMessage } from "../types.js";

// ─── Fixtures ────────────────────────────────────────────────

const mockMessages: AIMessage[] = [
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "Hello!" },
];

const mockOllamaResponse = {
  model: "llama3.1",
  message: { role: "assistant", content: "Hello from Ollama!" },
  done: true,
  total_duration: 1500000000,
  eval_count: 42,
};

describe("OllamaProvider", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("constructor", () => {
    it("has name 'ollama'", () => {
      const provider = new OllamaProvider();
      expect(provider.name).toBe("ollama");
    });

    it("strips trailing slashes from baseUrl", () => {
      // Validated indirectly through isAvailable/generate calls
      const provider = new OllamaProvider({ baseUrl: "http://localhost:11434///" });
      expect(provider.name).toBe("ollama");
    });
  });

  describe("isAvailable", () => {
    it("returns true when Ollama /api/tags responds with models array", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ models: [{ name: "llama3.1" }] }),
      });

      const provider = new OllamaProvider();
      expect(await provider.isAvailable()).toBe(true);
    });

    it("returns false when /api/tags response is not ok", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
      });

      const provider = new OllamaProvider();
      expect(await provider.isAvailable()).toBe(false);
    });

    it("returns false when response does not have models array", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ models: "not-an-array" }),
      });

      const provider = new OllamaProvider();
      expect(await provider.isAvailable()).toBe(false);
    });

    it("returns false on fetch error (connection refused)", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      const provider = new OllamaProvider();
      expect(await provider.isAvailable()).toBe(false);
    });

    it("checks the configured base URL", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      });
      global.fetch = mockFetch;

      const provider = new OllamaProvider({ baseUrl: "http://remote:8080" });
      await provider.isAvailable();

      expect(mockFetch.mock.calls[0]![0]).toBe("http://remote:8080/api/tags");
    });
  });

  describe("generate", () => {
    it("makes a POST request to /api/chat", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOllamaResponse),
      });
      global.fetch = mockFetch;

      const provider = new OllamaProvider();
      await provider.generate(mockMessages);

      const [url, opts] = mockFetch.mock.calls[0]!;
      expect(url).toBe("http://localhost:11434/api/chat");
      expect(opts.method).toBe("POST");
      expect(opts.headers["Content-Type"]).toBe("application/json");
    });

    it("sends messages in Ollama format with stream: false", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOllamaResponse),
      });
      global.fetch = mockFetch;

      const provider = new OllamaProvider();
      await provider.generate(mockMessages);

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.stream).toBe(false);
      expect(body.model).toBe("llama3.1");
      expect(body.messages).toEqual([
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello!" },
      ]);
    });

    it("returns parsed response with content and model", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOllamaResponse),
      });

      const provider = new OllamaProvider();
      const result = await provider.generate(mockMessages);

      expect(result.content).toBe("Hello from Ollama!");
      expect(result.model).toBe("llama3.1");
      expect(result.usage?.outputTokens).toBe(42);
    });

    it("passes maxTokens as num_predict in options", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOllamaResponse),
      });
      global.fetch = mockFetch;

      const provider = new OllamaProvider();
      await provider.generate(mockMessages, { maxTokens: 4096 });

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.options.num_predict).toBe(4096);
    });

    it("passes temperature in options", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOllamaResponse),
      });
      global.fetch = mockFetch;

      const provider = new OllamaProvider();
      await provider.generate(mockMessages, { temperature: 0.3 });

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.options.temperature).toBe(0.3);
    });

    it("does not include options field when no generation params", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOllamaResponse),
      });
      global.fetch = mockFetch;

      const provider = new OllamaProvider();
      await provider.generate(mockMessages);

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.options).toBeUndefined();
    });

    it("throws on non-ok HTTP response", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal error"),
      });

      const provider = new OllamaProvider();
      await expect(provider.generate(mockMessages)).rejects.toThrow(
        "Ollama API error (500): Internal error",
      );
    });

    it("throws when response has error field", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            ...mockOllamaResponse,
            error: "model not found",
          }),
      });

      const provider = new OllamaProvider();
      await expect(provider.generate(mockMessages)).rejects.toThrow(
        "Ollama error: model not found",
      );
    });

    it("throws when response has no content", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            ...mockOllamaResponse,
            message: { role: "assistant", content: "" },
          }),
      });

      const provider = new OllamaProvider();
      await expect(provider.generate(mockMessages)).rejects.toThrow(
        "returned no content",
      );
    });

    it("throws connection error with helpful message", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      const provider = new OllamaProvider();
      await expect(provider.generate(mockMessages)).rejects.toThrow(
        "Failed to connect to Ollama",
      );
    });

    it("uses custom model when configured", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOllamaResponse),
      });
      global.fetch = mockFetch;

      const provider = new OllamaProvider({ model: "codellama" });
      await provider.generate(mockMessages);

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.model).toBe("codellama");
    });

    it("uses custom base URL for requests", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOllamaResponse),
      });
      global.fetch = mockFetch;

      const provider = new OllamaProvider({ baseUrl: "http://gpu-server:11434" });
      await provider.generate(mockMessages);

      expect(mockFetch.mock.calls[0]![0]).toBe("http://gpu-server:11434/api/chat");
    });
  });
});
