/**
 * Unit tests for codex-cli-provider.ts
 * Tests CodexCliProvider with mocked child_process spawn and fs/promises access.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AIMessage } from "../types.js";

// ─── Mocks ────────────────────────────────────────────────

const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => mockSpawn(...args) }));

const mockAccess = vi.fn();
vi.mock("node:fs/promises", () => ({ access: (...args: unknown[]) => mockAccess(...args), constants: { X_OK: 1 } }));

const { CodexCliProvider } = await import("../codex-cli-provider.js");

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

describe("CodexCliProvider", () => {
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
    it("has name 'codex-cli'", () => {
      const provider = new CodexCliProvider();
      expect(provider.name).toBe("codex-cli");
    });

    it("uses config model when provided", () => {
      const provider = new CodexCliProvider({ model: "o3-mini" });
      expect(provider.name).toBe("codex-cli");
    });

    it("uses COVERIT_MODEL env var when no config model", () => {
      process.env["COVERIT_MODEL"] = "gpt-4o";
      const provider = new CodexCliProvider();
      expect(provider.name).toBe("codex-cli");
    });
  });

  describe("isAvailable", () => {
    it("returns true when codex is found via which", async () => {
      const whichProc = createMockProcess({ stdout: "/usr/local/bin/codex\n", exitCode: 0 });
      mockSpawn.mockReturnValueOnce(whichProc);

      const provider = new CodexCliProvider();
      const result = await provider.isAvailable();
      expect(result).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith("which", ["codex"]);
    });

    it("returns true when codex binary found at fallback path", async () => {
      const whichProc = createMockProcess({ exitCode: 1, stdout: "" });
      mockSpawn.mockReturnValueOnce(whichProc);
      mockAccess.mockResolvedValueOnce(undefined);

      const provider = new CodexCliProvider();
      const result = await provider.isAvailable();
      expect(result).toBe(true);
    });

    it("returns false when codex binary is not found anywhere", async () => {
      const whichProc = createMockProcess({ exitCode: 1, stdout: "" });
      mockSpawn.mockReturnValueOnce(whichProc);
      mockAccess.mockRejectedValue(new Error("ENOENT"));

      const provider = new CodexCliProvider();
      const result = await provider.isAvailable();
      expect(result).toBe(false);
    });

    it("returns false when which errors", async () => {
      const whichProc = createMockProcess({ error: new Error("spawn which ENOENT") });
      mockSpawn.mockReturnValueOnce(whichProc);
      mockAccess.mockRejectedValue(new Error("ENOENT"));

      const provider = new CodexCliProvider();
      const result = await provider.isAvailable();
      expect(result).toBe(false);
    });
  });

  describe("generate", () => {
    function setupAvailableProvider(model?: string) {
      const provider = new CodexCliProvider(model ? { model } : undefined);
      const whichProc = createMockProcess({ stdout: "/usr/local/bin/codex\n", exitCode: 0 });
      mockSpawn.mockReturnValueOnce(whichProc);
      return provider;
    }

    it("throws when binary is not found", async () => {
      const whichProc = createMockProcess({ exitCode: 1, stdout: "" });
      mockSpawn.mockReturnValue(whichProc);
      mockAccess.mockRejectedValue(new Error("ENOENT"));

      const provider = new CodexCliProvider();
      await expect(provider.generate(mockMessages)).rejects.toThrow(
        "Codex CLI binary not found",
      );
    });

    it("returns plain text stdout as content", async () => {
      const provider = setupAvailableProvider();
      const codexProc = createMockProcess({ stdout: "Here is the analysis.\n", exitCode: 0 });
      mockSpawn.mockReturnValueOnce(codexProc);

      const result = await provider.generate(mockMessages);
      expect(result.content).toBe("Here is the analysis.");
      expect(result.model).toBe("codex-cli");
    });

    it("returns configured model name in response", async () => {
      const provider = setupAvailableProvider("o3-mini");
      const codexProc = createMockProcess({ stdout: "Response text", exitCode: 0 });
      mockSpawn.mockReturnValueOnce(codexProc);

      const result = await provider.generate(mockMessages);
      expect(result.model).toBe("o3-mini");
    });

    it("passes --system-prompt flag for system messages", async () => {
      const provider = setupAvailableProvider();
      const codexProc = createMockProcess({ stdout: "Response", exitCode: 0 });
      mockSpawn.mockReturnValueOnce(codexProc);

      await provider.generate(mockMessages);

      const codexCallArgs = mockSpawn.mock.calls[1]![1] as string[];
      expect(codexCallArgs).toContain("--system-prompt");
      expect(codexCallArgs).toContain("You are a test assistant.");
    });

    it("passes --model flag when model is configured", async () => {
      const provider = setupAvailableProvider("gpt-4o");
      const codexProc = createMockProcess({ stdout: "Response", exitCode: 0 });
      mockSpawn.mockReturnValueOnce(codexProc);

      await provider.generate(mockMessages);

      const codexCallArgs = mockSpawn.mock.calls[1]![1] as string[];
      expect(codexCallArgs).toContain("--model");
      expect(codexCallArgs).toContain("gpt-4o");
    });

    it("omits --model flag when no model configured", async () => {
      const provider = setupAvailableProvider();
      const codexProc = createMockProcess({ stdout: "Response", exitCode: 0 });
      mockSpawn.mockReturnValueOnce(codexProc);

      await provider.generate(userOnlyMessages);

      const codexCallArgs = mockSpawn.mock.calls[1]![1] as string[];
      expect(codexCallArgs).not.toContain("--model");
    });

    it("omits --system-prompt flag when no system messages", async () => {
      const provider = setupAvailableProvider();
      const codexProc = createMockProcess({ stdout: "Response", exitCode: 0 });
      mockSpawn.mockReturnValueOnce(codexProc);

      await provider.generate(userOnlyMessages);

      const codexCallArgs = mockSpawn.mock.calls[1]![1] as string[];
      expect(codexCallArgs).not.toContain("--system-prompt");
    });

    it("writes prompt via stdin", async () => {
      const provider = setupAvailableProvider();
      const codexProc = createMockProcess({ stdout: "Response", exitCode: 0 });
      mockSpawn.mockReturnValueOnce(codexProc);

      await provider.generate(mockMessages);

      expect(codexProc.stdin.write).toHaveBeenCalledWith("Analyze this code.");
      expect(codexProc.stdin.end).toHaveBeenCalled();
    });

    it("throws on non-zero exit code with no stdout", async () => {
      const provider = setupAvailableProvider();
      const codexProc = createMockProcess({ stdout: "", stderr: "Error occurred", exitCode: 1 });
      mockSpawn.mockReturnValueOnce(codexProc);

      await expect(provider.generate(mockMessages)).rejects.toThrow(
        "Codex CLI exited with code 1: Error occurred",
      );
    });

    it("throws when CLI returns no content", async () => {
      const provider = setupAvailableProvider();
      const codexProc = createMockProcess({ stdout: "   \n  ", exitCode: 0 });
      mockSpawn.mockReturnValueOnce(codexProc);

      await expect(provider.generate(mockMessages)).rejects.toThrow(
        "Codex CLI returned no content",
      );
    });

    it("throws when spawn fails with an error", async () => {
      const provider = setupAvailableProvider();
      const codexProc = createMockProcess({ error: new Error("ENOENT") });
      mockSpawn.mockReturnValueOnce(codexProc);

      await expect(provider.generate(mockMessages)).rejects.toThrow(
        "Failed to spawn Codex CLI",
      );
    });

    it("passes cwd option to spawn", async () => {
      const provider = setupAvailableProvider();
      const codexProc = createMockProcess({ stdout: "Response", exitCode: 0 });
      mockSpawn.mockReturnValueOnce(codexProc);

      await provider.generate(mockMessages, { cwd: "/tmp/test-project" });

      const spawnOpts = mockSpawn.mock.calls[1]![2] as { cwd?: string };
      expect(spawnOpts.cwd).toBe("/tmp/test-project");
    });
  });
});
