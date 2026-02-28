/**
 * Unit tests for provider-factory.ts
 * Tests createAIProvider and detectBestProvider with mocked providers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Track mock availability per provider
let mockAvailability: Record<string, boolean> = {};

// Mock all provider modules with controllable availability
vi.mock("../claude-cli-provider.js", () => ({
  ClaudeCliProvider: vi.fn().mockImplementation(() => ({
    name: "claude-cli",
    isAvailable: vi.fn().mockImplementation(() => Promise.resolve(mockAvailability["claude-cli"] ?? false)),
    generate: vi.fn(),
  })),
}));

vi.mock("../gemini-cli-provider.js", () => ({
  GeminiCliProvider: vi.fn().mockImplementation(() => ({
    name: "gemini-cli",
    isAvailable: vi.fn().mockImplementation(() => Promise.resolve(mockAvailability["gemini-cli"] ?? false)),
    generate: vi.fn(),
  })),
}));

vi.mock("../codex-cli-provider.js", () => ({
  CodexCliProvider: vi.fn().mockImplementation(() => ({
    name: "codex-cli",
    isAvailable: vi.fn().mockImplementation(() => Promise.resolve(mockAvailability["codex-cli"] ?? false)),
    generate: vi.fn(),
  })),
}));

vi.mock("../anthropic-provider.js", () => ({
  AnthropicProvider: vi.fn().mockImplementation(() => ({
    name: "anthropic",
    isAvailable: vi.fn().mockImplementation(() => Promise.resolve(mockAvailability["anthropic"] ?? false)),
    generate: vi.fn(),
  })),
}));

vi.mock("../openai-provider.js", () => ({
  OpenAIProvider: vi.fn().mockImplementation(() => ({
    name: "openai",
    isAvailable: vi.fn().mockImplementation(() => Promise.resolve(mockAvailability["openai"] ?? false)),
    generate: vi.fn(),
  })),
}));

vi.mock("../ollama-provider.js", () => ({
  OllamaProvider: vi.fn().mockImplementation(() => ({
    name: "ollama",
    isAvailable: vi.fn().mockImplementation(() => Promise.resolve(mockAvailability["ollama"] ?? false)),
    generate: vi.fn(),
  })),
}));

// Import AFTER mocking
import { createAIProvider, detectBestProvider } from "../provider-factory.js";
import type { AIProviderConfig } from "../types.js";

describe("createAIProvider", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    mockAvailability = {};
    process.env = { ...originalEnv };
    delete process.env["COVERIT_AI_PROVIDER"];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("falls through to detectBestProvider when no config is given", async () => {
    // All providers unavailable → should throw "No AI provider available"
    await expect(createAIProvider()).rejects.toThrow("No AI provider available");
  });

  it("throws when specified provider is not available", async () => {
    const config: AIProviderConfig = {
      provider: "anthropic",
      apiKey: "test-key",
    };
    await expect(createAIProvider(config)).rejects.toThrow(
      'AI provider "anthropic" is not available',
    );
  });

  it("returns provider when specified and available", async () => {
    mockAvailability["anthropic"] = true;

    const config: AIProviderConfig = {
      provider: "anthropic",
      apiKey: "test-key",
    };
    const provider = await createAIProvider(config);
    expect(provider.name).toBe("anthropic");
  });

  it("includes setup hint in error when provider unavailable", async () => {
    const config: AIProviderConfig = {
      provider: "ollama",
    };
    await expect(createAIProvider(config)).rejects.toThrow("ollama serve");
  });

  it("returns claude-cli provider when available", async () => {
    mockAvailability["claude-cli"] = true;

    const config: AIProviderConfig = {
      provider: "claude-cli",
    };
    const provider = await createAIProvider(config);
    expect(provider.name).toBe("claude-cli");
  });

  it("returns openai provider when available", async () => {
    mockAvailability["openai"] = true;

    const config: AIProviderConfig = {
      provider: "openai",
      apiKey: "sk-test",
    };
    const provider = await createAIProvider(config);
    expect(provider.name).toBe("openai");
  });
});

describe("detectBestProvider", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    mockAvailability = {};
    process.env = { ...originalEnv };
    delete process.env["COVERIT_AI_PROVIDER"];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws helpful error when no providers are available", async () => {
    await expect(detectBestProvider()).rejects.toThrow(
      "No AI provider available",
    );
  });

  it("throws when COVERIT_AI_PROVIDER is set but unavailable", async () => {
    process.env["COVERIT_AI_PROVIDER"] = "anthropic";
    await expect(detectBestProvider()).rejects.toThrow(
      'COVERIT_AI_PROVIDER is set to "anthropic" but it is not available',
    );
  });

  it("returns the first available provider in priority order", async () => {
    // Make only ollama available (lowest priority)
    mockAvailability["ollama"] = true;

    const provider = await detectBestProvider();
    expect(provider.name).toBe("ollama");
  });

  it("prefers claude-cli over later providers", async () => {
    mockAvailability["claude-cli"] = true;
    mockAvailability["ollama"] = true;

    const provider = await detectBestProvider();
    expect(provider.name).toBe("claude-cli");
  });

  it("returns anthropic when only API key providers available", async () => {
    mockAvailability["anthropic"] = true;
    mockAvailability["openai"] = true;

    const provider = await detectBestProvider();
    expect(provider.name).toBe("anthropic");
  });

  it("includes all provider options in error message", async () => {
    try {
      await detectBestProvider();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("Claude Code CLI");
      expect(msg).toContain("Gemini CLI");
      expect(msg).toContain("Codex CLI");
      expect(msg).toContain("ANTHROPIC_API_KEY");
      expect(msg).toContain("OPENAI_API_KEY");
      expect(msg).toContain("Ollama");
    }
  });

  it("respects COVERIT_AI_PROVIDER env var when provider is available", async () => {
    process.env["COVERIT_AI_PROVIDER"] = "openai";
    mockAvailability["openai"] = true;
    mockAvailability["claude-cli"] = true; // Higher priority, but env overrides

    const provider = await detectBestProvider();
    expect(provider.name).toBe("openai");
  });
});
