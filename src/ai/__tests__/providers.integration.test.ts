/**
 * Integration tests for all AI providers
 * Tests provider behavior under various conditions with mocked external dependencies.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AnthropicProvider } from "../anthropic-provider.js";
import { OpenAIProvider } from "../openai-provider.js";
import { OllamaProvider } from "../ollama-provider.js";
import type { AIMessage } from "../types.js";

// ─── Shared Fixtures ─────────────────────────────────────────

const simpleMessages: AIMessage[] = [
  { role: "user", content: "What is 2+2?" },
];

const multiRoleMessages: AIMessage[] = [
  { role: "system", content: "You are a math tutor." },
  { role: "user", content: "What is 2+2?" },
  { role: "assistant", content: "2+2 equals 4." },
  { role: "user", content: "And 3+3?" },
];

// ─── Anthropic Provider Integration ──────────────────────────

describe("AnthropicProvider integration", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("handles multi-turn conversation with system message separation", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "msg_123",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "3+3 equals 6." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 20, output_tokens: 10 },
        }),
    });
    global.fetch = mockFetch;

    const provider = new AnthropicProvider({ apiKey: "sk-test" });
    const result = await provider.generate(multiRoleMessages);

    // Verify system message was separated
    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.system).toBe("You are a math tutor.");
    expect(body.messages).toHaveLength(3); // user + assistant + user (no system)
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[1].role).toBe("assistant");
    expect(body.messages[2].role).toBe("user");

    expect(result.content).toBe("3+3 equals 6.");
  });

  it("handles response with multiple content blocks of mixed types", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "msg_456",
          model: "claude-sonnet-4-5-20250929",
          content: [
            { type: "text", text: "Let me think..." },
            { type: "tool_use", id: "tool_1", name: "calculator", input: { expression: "6" } },
            { type: "text", text: " The answer is 6." },
          ],
          stop_reason: "end_turn",
        }),
    });

    const provider = new AnthropicProvider({ apiKey: "sk-test" });
    const result = await provider.generate(simpleMessages);

    // Only text blocks should be included
    expect(result.content).toBe("Let me think... The answer is 6.");
  });

  it("uses constructor temperature when options don't specify one", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "msg_789",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "Response" }],
          stop_reason: "end_turn",
        }),
    });
    global.fetch = mockFetch;

    const provider = new AnthropicProvider({
      apiKey: "sk-test",
      temperature: 0.2,
    });
    await provider.generate(simpleMessages);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.temperature).toBe(0.2);
  });

  it("options temperature overrides constructor temperature", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "msg_789",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "Response" }],
          stop_reason: "end_turn",
        }),
    });
    global.fetch = mockFetch;

    const provider = new AnthropicProvider({
      apiKey: "sk-test",
      temperature: 0.2,
    });
    await provider.generate(simpleMessages, { temperature: 0.9 });

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.temperature).toBe(0.9);
  });

  it("omits temperature when neither constructor nor options specify it", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "msg_789",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "Response" }],
          stop_reason: "end_turn",
        }),
    });
    global.fetch = mockFetch;

    const provider = new AnthropicProvider({ apiKey: "sk-test" });
    await provider.generate(simpleMessages);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.temperature).toBeUndefined();
  });
});

// ─── OpenAI Provider Integration ─────────────────────────────

describe("OpenAIProvider integration", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("handles multi-turn conversation preserving all roles", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "chatcmpl-123",
          model: "gpt-4o",
          choices: [
            {
              message: { role: "assistant", content: "6" },
              finish_reason: "stop",
            },
          ],
        }),
    });
    global.fetch = mockFetch;

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    await provider.generate(multiRoleMessages);

    // OpenAI keeps system messages in the messages array
    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.messages).toHaveLength(4);
    expect(body.messages[0].role).toBe("system");
  });

  it("works with a custom base URL for compatible endpoints", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "chatcmpl-abc",
          model: "mixtral-8x7b",
          choices: [
            {
              message: { role: "assistant", content: "Hello from Groq!" },
              finish_reason: "stop",
            },
          ],
        }),
    });
    global.fetch = mockFetch;

    const provider = new OpenAIProvider({
      provider: "openai-compatible",
      apiKey: "gsk-test",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "mixtral-8x7b",
    });
    const result = await provider.generate(simpleMessages);

    expect(mockFetch.mock.calls[0]![0]).toBe(
      "https://api.groq.com/openai/v1/chat/completions",
    );
    expect(result.content).toBe("Hello from Groq!");
    expect(result.model).toBe("mixtral-8x7b");
  });

  it("handles missing usage in response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "chatcmpl-xyz",
          model: "gpt-4o",
          choices: [
            {
              message: { role: "assistant", content: "No usage tracking" },
              finish_reason: "stop",
            },
          ],
        }),
    });

    const provider = new OpenAIProvider({ apiKey: "sk-test" });
    const result = await provider.generate(simpleMessages);
    expect(result.usage).toBeUndefined();
  });

  it("uses constructor temperature when options don't override", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "chatcmpl-xyz",
          model: "gpt-4o",
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        }),
    });
    global.fetch = mockFetch;

    const provider = new OpenAIProvider({ apiKey: "sk-test", temperature: 0.5 });
    await provider.generate(simpleMessages);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.temperature).toBe(0.5);
  });
});

// ─── Ollama Provider Integration ─────────────────────────────

describe("OllamaProvider integration", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("handles multi-turn conversation preserving all roles", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          model: "llama3.1",
          message: { role: "assistant", content: "6" },
          done: true,
        }),
    });
    global.fetch = mockFetch;

    const provider = new OllamaProvider();
    await provider.generate(multiRoleMessages);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.messages).toHaveLength(4);
    expect(body.stream).toBe(false);
  });

  it("passes both maxTokens and temperature as options", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          model: "llama3.1",
          message: { role: "assistant", content: "ok" },
          done: true,
        }),
    });
    global.fetch = mockFetch;

    const provider = new OllamaProvider();
    await provider.generate(simpleMessages, { maxTokens: 1024, temperature: 0.1 });

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.options.num_predict).toBe(1024);
    expect(body.options.temperature).toBe(0.1);
  });

  it("returns eval_count as usage.outputTokens", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          model: "llama3.1",
          message: { role: "assistant", content: "Response" },
          done: true,
          eval_count: 150,
        }),
    });

    const provider = new OllamaProvider();
    const result = await provider.generate(simpleMessages);
    expect(result.usage?.outputTokens).toBe(150);
  });

  it("handles missing eval_count gracefully", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          model: "llama3.1",
          message: { role: "assistant", content: "Response" },
          done: true,
        }),
    });

    const provider = new OllamaProvider();
    const result = await provider.generate(simpleMessages);
    expect(result.usage).toBeUndefined();
  });

  it("isAvailable returns true for empty models array (Ollama running, no models)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [] }),
    });

    const provider = new OllamaProvider();
    // Empty array is still a valid Array, so Ollama is running
    expect(await provider.isAvailable()).toBe(true);
  });
});
