/**
 * Unit tests for gemini-cli-provider.ts
 * Tests GeminiCliProvider with mocked child_process spawn and fs/promises access.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AIMessage } from "../types.js";

// ─── Mocks ────────────────────────────────────────────────

const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => mockSpawn(...args) }));

const mockAccess = vi.fn();
vi.mock("node:fs/promises", () => ({ access: (...args: unknown[]) => mockAccess(...args), constants: { X_OK: 1 } }));

const { GeminiCliProvider } = await import("../gemini-cli-provider.js");

// ─── Helpers ──────────────────────────────────────────────

function createMockProcess(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: Error;
}) {
  const stdoutListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const stderrListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const procListeners: Record<string, ((...args: unknown[]) => void)[]> = {};

  const proc = {
    stdout: {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (!stdoutListeners[event]) stdoutListeners[event] = [];
        stdoutListeners[event]!.push(cb);
      }),
    },
    stderr: {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (!stderrListeners[event]) stderrListeners[event] = [];
        stderrListeners[event]!.push(cb);
      }),
    },
    stdin: {
      write: vi.fn(),
      end: vi.fn(),
    },
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (!procListeners[event]) procListeners[event] = [];
      procListeners[event]!.push(cb);
    }),
    kill: vi.fn(),
  };

  setTimeout(() => {
    if (opts.error) {
      procListeners["error"]?.forEach((cb) => cb(opts.error));
      return;
    }
    if (opts.stdout) {
      stdoutListeners["data"]?.forEach((cb) => cb(Buffer.from(opts.stdout!)));
    }
    if (opts.stderr) {
      stderrListeners["data"]?.forEach((cb) => cb(Buffer.from(opts.stderr!)));
    }
    procListeners["close"]?.forEach((cb) => cb(opts.exitCode ?? 0));
  }, 5);

  return proc;
}

// ─── Fixtures ─────────────────────────────────────────────

const mockMessages: AIMessage[] = [
  { role: "system", content: "You are a test assistant." },
  { role: "user", content: "Analyze this code." },
];

const userOnlyMessages: AIMessage[] = [
  { role: "user", content: "Hello" },
];

// ─── Tests ────────────────────────────────────────────────

describe("GeminiCliProvider", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env["COVERIT_MODEL"];
    mockAccess.mockRejectedValue(new Error("ENOENT"));
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("constructor", () => {
    it("has name 'gemini-cli'", () => {
      const provider = new GeminiCliProvider();
      expect(provider.name).toBe("gemini-cli");
    });

    it("uses config model when provided", () => {
      const provider = new GeminiCliProvider({ model: "gemini-2.0-flash" });
      expect(provider.name).toBe("gemini-cli");
    });

    it("uses COVERIT_MODEL env var when no config model", () => {
      process.env["COVERIT_MODEL"] = "gemini-pro";
      const provider = new GeminiCliProvider();
      expect(provider.name).toBe("gemini-cli");
    });
  });

  describe("isAvailable", () => {
    it("returns true when gemini is found via which", async () => {
      const whichProc = createMockProcess({ stdout: "/usr/local/bin/gemini\n", exitCode: 0 });
      mockSpawn.mockReturnValueOnce(whichProc);

      const provider = new GeminiCliProvider();
      const result = await provider.isAvailable();
      expect(result).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith("which", ["gemini"]);
    });

    it("returns true when gemini binary found at fallback path", async () => {
      const whichProc = createMockProcess({ exitCode: 1, stdout: "" });
      mockSpawn.mockReturnValueOnce(whichProc);
      mockAccess.mockResolvedValueOnce(undefined);

      const provider = new GeminiCliProvider();
      const result = await provider.isAvailable();
      expect(result).toBe(true);
    });

    it("returns false when gemini binary is not found anywhere", async () => {
      const whichProc = createMockProcess({ exitCode: 1, stdout: "" });
      mockSpawn.mockReturnValueOnce(whichProc);
      mockAccess.mockRejectedValue(new Error("ENOENT"));

      const provider = new GeminiCliProvider();
      const result = await provider.isAvailable();
      expect(result).toBe(false);
    });

    it("returns false when which errors", async () => {
      const whichProc = createMockProcess({ error: new Error("spawn which ENOENT") });
      mockSpawn.mockReturnValueOnce(whichProc);
      mockAccess.mockRejectedValue(new Error("ENOENT"));

      const provider = new GeminiCliProvider();
      const result = await provider.isAvailable();
      expect(result).toBe(false);
    });
  });

  describe("generate", () => {
    function setupAvailableProvider(model?: string) {
      const provider = new GeminiCliProvider(model ? { model } : undefined);
      const whichProc = createMockProcess({ stdout: "/usr/local/bin/gemini\n", exitCode: 0 });
      mockSpawn.mockReturnValueOnce(whichProc);
      return provider;
    }

    it("throws when binary is not found", async () => {
      const whichProc = createMockProcess({ exitCode: 1, stdout: "" });
      mockSpawn.mockReturnValue(whichProc);
      mockAccess.mockRejectedValue(new Error("ENOENT"));

      const provider = new GeminiCliProvider();
      await expect(provider.generate(mockMessages)).rejects.toThrow(
        "Gemini CLI binary not found",
      );
    });

    it("returns plain text stdout as content", async () => {
      const provider = setupAvailableProvider();
      const geminiProc = createMockProcess({ stdout: "Here is the analysis.\n", exitCode: 0 });
      mockSpawn.mockReturnValueOnce(geminiProc);

      const result = await provider.generate(mockMessages);
      expect(result.content).toBe("Here is the analysis.");
      expect(result.model).toBe("gemini-cli");
    });

    it("returns configured model name in response", async () => {
      const provider = setupAvailableProvider("gemini-2.0-flash");
      const geminiProc = createMockProcess({ stdout: "Response text", exitCode: 0 });
      mockSpawn.mockReturnValueOnce(geminiProc);

      const result = await provider.generate(mockMessages);
      expect(result.model).toBe("gemini-2.0-flash");
    });

    it("passes --system-prompt flag for system messages", async () => {
      const provider = setupAvailableProvider();
      const geminiProc = createMockProcess({ stdout: "Response", exitCode: 0 });
      mockSpawn.mockReturnValueOnce(geminiProc);

      await provider.generate(mockMessages);

      const geminiCallArgs = mockSpawn.mock.calls[1]![1] as string[];
      expect(geminiCallArgs).toContain("--system-prompt");
      expect(geminiCallArgs).toContain("You are a test assistant.");
    });

    it("passes --model flag when model is configured", async () => {
      const provider = setupAvailableProvider("gemini-pro");
      const geminiProc = createMockProcess({ stdout: "Response", exitCode: 0 });
      mockSpawn.mockReturnValueOnce(geminiProc);

      await provider.generate(mockMessages);

      const geminiCallArgs = mockSpawn.mock.calls[1]![1] as string[];
      expect(geminiCallArgs).toContain("--model");
      expect(geminiCallArgs).toContain("gemini-pro");
    });

    it("omits --model flag when no model configured", async () => {
      const provider = setupAvailableProvider();
      const geminiProc = createMockProcess({ stdout: "Response", exitCode: 0 });
      mockSpawn.mockReturnValueOnce(geminiProc);

      await provider.generate(userOnlyMessages);

      const geminiCallArgs = mockSpawn.mock.calls[1]![1] as string[];
      expect(geminiCallArgs).not.toContain("--model");
    });

    it("omits --system-prompt flag when no system messages", async () => {
      const provider = setupAvailableProvider();
      const geminiProc = createMockProcess({ stdout: "Response", exitCode: 0 });
      mockSpawn.mockReturnValueOnce(geminiProc);

      await provider.generate(userOnlyMessages);

      const geminiCallArgs = mockSpawn.mock.calls[1]![1] as string[];
      expect(geminiCallArgs).not.toContain("--system-prompt");
    });

    it("writes prompt via stdin", async () => {
      const provider = setupAvailableProvider();
      const geminiProc = createMockProcess({ stdout: "Response", exitCode: 0 });
      mockSpawn.mockReturnValueOnce(geminiProc);

      await provider.generate(mockMessages);

      expect(geminiProc.stdin.write).toHaveBeenCalledWith("Analyze this code.");
      expect(geminiProc.stdin.end).toHaveBeenCalled();
    });

    it("throws on non-zero exit code with no stdout", async () => {
      const provider = setupAvailableProvider();
      const geminiProc = createMockProcess({ stdout: "", stderr: "Error occurred", exitCode: 1 });
      mockSpawn.mockReturnValueOnce(geminiProc);

      await expect(provider.generate(mockMessages)).rejects.toThrow(
        "Gemini CLI exited with code 1: Error occurred",
      );
    });

    it("throws when CLI returns no content", async () => {
      const provider = setupAvailableProvider();
      const geminiProc = createMockProcess({ stdout: "   \n  ", exitCode: 0 });
      mockSpawn.mockReturnValueOnce(geminiProc);

      await expect(provider.generate(mockMessages)).rejects.toThrow(
        "Gemini CLI returned no content",
      );
    });

    it("throws when spawn fails with an error", async () => {
      const provider = setupAvailableProvider();
      const geminiProc = createMockProcess({ error: new Error("ENOENT") });
      mockSpawn.mockReturnValueOnce(geminiProc);

      await expect(provider.generate(mockMessages)).rejects.toThrow(
        "Failed to spawn Gemini CLI",
      );
    });

    it("passes cwd option to spawn", async () => {
      const provider = setupAvailableProvider();
      const geminiProc = createMockProcess({ stdout: "Response", exitCode: 0 });
      mockSpawn.mockReturnValueOnce(geminiProc);

      await provider.generate(mockMessages, { cwd: "/tmp/test-project" });

      const spawnOpts = mockSpawn.mock.calls[1]![2] as { cwd?: string };
      expect(spawnOpts.cwd).toBe("/tmp/test-project");
    });
  });
});
