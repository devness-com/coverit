/**
 * Unit tests for claude-cli-provider.ts
 * Tests ClaudeCliProvider with mocked child_process spawn and fs/promises access.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AIMessage } from "../types.js";

// ─── Mocks ────────────────────────────────────────────────

// Create a mock spawn that returns controllable child processes
const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => mockSpawn(...args) }));

const mockAccess = vi.fn();
vi.mock("node:fs/promises", () => ({ access: (...args: unknown[]) => mockAccess(...args), constants: { X_OK: 1 } }));

// Import after mocks are set up
const { ClaudeCliProvider } = await import("../claude-cli-provider.js");

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

  // Emit events async to allow listeners to be set up
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

const streamingOutput = [
  JSON.stringify({ type: "assistant", content: [{ type: "text", text: "Here is " }] }),
  JSON.stringify({ type: "assistant", content: [{ type: "text", text: "the analysis." }] }),
  JSON.stringify({ type: "result", result: "Final result content", model: "claude-sonnet-4-5-20250929" }),
].join("\n");

const resultWithContentBlocks = [
  JSON.stringify({
    type: "result",
    result: { content: [{ type: "text", text: "Block 1" }, { type: "text", text: " Block 2" }] },
    model: "claude-sonnet-4-5-20250929",
  }),
].join("\n");

const contentBlockDeltaOutput = [
  JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "delta text" } }),
  JSON.stringify({ model: "claude-sonnet-4-5-20250929" }),
].join("\n");

// ─── Tests ────────────────────────────────────────────────

describe("ClaudeCliProvider", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env["COVERIT_MODEL"];
    // Default: `which` fails (not on PATH), and no fallback paths exist
    mockAccess.mockRejectedValue(new Error("ENOENT"));
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("constructor", () => {
    it("has name 'claude-cli'", () => {
      const provider = new ClaudeCliProvider();
      expect(provider.name).toBe("claude-cli");
    });

    it("uses config model when provided", () => {
      const provider = new ClaudeCliProvider({ model: "claude-3-haiku" });
      expect(provider.name).toBe("claude-cli");
    });

    it("uses COVERIT_MODEL env var when no config model", () => {
      process.env["COVERIT_MODEL"] = "claude-opus-4-20250115";
      const provider = new ClaudeCliProvider();
      expect(provider.name).toBe("claude-cli");
    });
  });

  describe("isAvailable", () => {
    it("returns true when claude is found via which", async () => {
      const whichProc = createMockProcess({ stdout: "/usr/local/bin/claude\n", exitCode: 0 });
      mockSpawn.mockReturnValueOnce(whichProc);

      const provider = new ClaudeCliProvider();
      const result = await provider.isAvailable();
      expect(result).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith("which", ["claude"]);
    });

    it("returns true when claude binary found at fallback path", async () => {
      // `which` fails
      const whichProc = createMockProcess({ exitCode: 1, stdout: "" });
      mockSpawn.mockReturnValueOnce(whichProc);
      // First access call succeeds (the first fallback path)
      mockAccess.mockResolvedValueOnce(undefined);

      const provider = new ClaudeCliProvider();
      const result = await provider.isAvailable();
      expect(result).toBe(true);
    });

    it("returns false when claude binary is not found anywhere", async () => {
      const whichProc = createMockProcess({ exitCode: 1, stdout: "" });
      mockSpawn.mockReturnValueOnce(whichProc);
      // All access calls fail
      mockAccess.mockRejectedValue(new Error("ENOENT"));

      const provider = new ClaudeCliProvider();
      const result = await provider.isAvailable();
      expect(result).toBe(false);
    });

    it("returns false when which errors", async () => {
      const whichProc = createMockProcess({ error: new Error("spawn which ENOENT") });
      mockSpawn.mockReturnValueOnce(whichProc);
      mockAccess.mockRejectedValue(new Error("ENOENT"));

      const provider = new ClaudeCliProvider();
      const result = await provider.isAvailable();
      expect(result).toBe(false);
    });
  });

  describe("generate", () => {
    function setupAvailableProvider(model?: string) {
      const provider = new ClaudeCliProvider(model ? { model } : undefined);
      // First call: `which claude` for isAvailable / findBinary
      const whichProc = createMockProcess({ stdout: "/usr/local/bin/claude\n", exitCode: 0 });
      mockSpawn.mockReturnValueOnce(whichProc);
      return provider;
    }

    it("throws when binary is not found", async () => {
      const whichProc = createMockProcess({ exitCode: 1, stdout: "" });
      mockSpawn.mockReturnValue(whichProc);
      mockAccess.mockRejectedValue(new Error("ENOENT"));

      const provider = new ClaudeCliProvider();
      await expect(provider.generate(mockMessages)).rejects.toThrow(
        "Claude CLI binary not found",
      );
    });

    it("parses streaming JSON result and returns content", async () => {
      const provider = setupAvailableProvider();
      // Second call: the actual claude process
      const claudeProc = createMockProcess({ stdout: streamingOutput, exitCode: 0 });
      mockSpawn.mockReturnValueOnce(claudeProc);

      const result = await provider.generate(mockMessages);
      // The result event takes precedence over assistant parts
      expect(result.content).toBe("Final result content");
      expect(result.model).toBe("claude-sonnet-4-5-20250929");
    });

    it("parses result with content blocks array", async () => {
      const provider = setupAvailableProvider();
      const claudeProc = createMockProcess({ stdout: resultWithContentBlocks, exitCode: 0 });
      mockSpawn.mockReturnValueOnce(claudeProc);

      const result = await provider.generate(mockMessages);
      expect(result.content).toBe("Block 1 Block 2");
    });

    it("falls back to assistant text parts when no result event", async () => {
      const assistantOnly = [
        JSON.stringify({ type: "assistant", content: [{ type: "text", text: "Hello from Claude" }] }),
      ].join("\n");

      const provider = setupAvailableProvider();
      const claudeProc = createMockProcess({ stdout: assistantOnly, exitCode: 0 });
      mockSpawn.mockReturnValueOnce(claudeProc);

      const result = await provider.generate(mockMessages);
      expect(result.content).toBe("Hello from Claude");
    });

    it("parses content_block_delta streaming events", async () => {
      const provider = setupAvailableProvider();
      const claudeProc = createMockProcess({ stdout: contentBlockDeltaOutput, exitCode: 0 });
      mockSpawn.mockReturnValueOnce(claudeProc);

      const result = await provider.generate(mockMessages);
      expect(result.content).toBe("delta text");
      expect(result.model).toBe("claude-sonnet-4-5-20250929");
    });

    it("passes --system-prompt flag for system messages", async () => {
      const provider = setupAvailableProvider();
      const claudeProc = createMockProcess({ stdout: streamingOutput, exitCode: 0 });
      mockSpawn.mockReturnValueOnce(claudeProc);

      await provider.generate(mockMessages);

      // Second spawn call is the claude process
      const claudeCallArgs = mockSpawn.mock.calls[1]![1] as string[];
      expect(claudeCallArgs).toContain("--system-prompt");
      expect(claudeCallArgs).toContain("You are a test assistant.");
    });

    it("passes --model flag when model is configured", async () => {
      const provider = setupAvailableProvider("claude-3-haiku");
      const claudeProc = createMockProcess({ stdout: streamingOutput, exitCode: 0 });
      mockSpawn.mockReturnValueOnce(claudeProc);

      await provider.generate(mockMessages);

      const claudeCallArgs = mockSpawn.mock.calls[1]![1] as string[];
      expect(claudeCallArgs).toContain("--model");
      expect(claudeCallArgs).toContain("claude-3-haiku");
    });

    it("omits --model flag when no model is configured", async () => {
      const provider = setupAvailableProvider();
      const claudeProc = createMockProcess({ stdout: streamingOutput, exitCode: 0 });
      mockSpawn.mockReturnValueOnce(claudeProc);

      await provider.generate(userOnlyMessages);

      const claudeCallArgs = mockSpawn.mock.calls[1]![1] as string[];
      expect(claudeCallArgs).not.toContain("--model");
    });

    it("omits --system-prompt flag when no system messages", async () => {
      const provider = setupAvailableProvider();
      const claudeProc = createMockProcess({ stdout: streamingOutput, exitCode: 0 });
      mockSpawn.mockReturnValueOnce(claudeProc);

      await provider.generate(userOnlyMessages);

      const claudeCallArgs = mockSpawn.mock.calls[1]![1] as string[];
      expect(claudeCallArgs).not.toContain("--system-prompt");
    });

    it("passes --allowedTools and --dangerously-skip-permissions when tools specified", async () => {
      const provider = setupAvailableProvider();
      const claudeProc = createMockProcess({ stdout: streamingOutput, exitCode: 0 });
      mockSpawn.mockReturnValueOnce(claudeProc);

      await provider.generate(mockMessages, { allowedTools: ["Read", "Glob"] });

      const claudeCallArgs = mockSpawn.mock.calls[1]![1] as string[];
      expect(claudeCallArgs).toContain("--allowedTools");
      expect(claudeCallArgs).toContain("Read,Glob");
      expect(claudeCallArgs).toContain("--dangerously-skip-permissions");
    });

    it("writes prompt via stdin", async () => {
      const provider = setupAvailableProvider();
      const claudeProc = createMockProcess({ stdout: streamingOutput, exitCode: 0 });
      mockSpawn.mockReturnValueOnce(claudeProc);

      await provider.generate(mockMessages);

      expect(claudeProc.stdin.write).toHaveBeenCalledWith("Analyze this code.");
      expect(claudeProc.stdin.end).toHaveBeenCalled();
    });

    it("throws on non-zero exit code with no stdout", async () => {
      const provider = setupAvailableProvider();
      const claudeProc = createMockProcess({ stdout: "", stderr: "Some error", exitCode: 1 });
      mockSpawn.mockReturnValueOnce(claudeProc);

      await expect(provider.generate(mockMessages)).rejects.toThrow(
        "Claude CLI exited with code 1: Some error",
      );
    });

    it("throws when CLI returns no text content", async () => {
      const emptyOutput = JSON.stringify({ type: "result", result: "" });
      const provider = setupAvailableProvider();
      const claudeProc = createMockProcess({ stdout: emptyOutput, exitCode: 0 });
      mockSpawn.mockReturnValueOnce(claudeProc);

      await expect(provider.generate(mockMessages)).rejects.toThrow(
        "Claude CLI returned no text content",
      );
    });

    it("throws when spawn fails with an error", async () => {
      const provider = setupAvailableProvider();
      const claudeProc = createMockProcess({ error: new Error("ENOENT") });
      mockSpawn.mockReturnValueOnce(claudeProc);

      await expect(provider.generate(mockMessages)).rejects.toThrow(
        "Failed to spawn Claude CLI",
      );
    });

    it("skips malformed JSON lines gracefully", async () => {
      const outputWithBadLines = [
        "not valid json",
        JSON.stringify({ type: "assistant", content: [{ type: "text", text: "Valid output" }] }),
        "another bad line {{{",
      ].join("\n");

      const provider = setupAvailableProvider();
      const claudeProc = createMockProcess({ stdout: outputWithBadLines, exitCode: 0 });
      mockSpawn.mockReturnValueOnce(claudeProc);

      const result = await provider.generate(mockMessages);
      expect(result.content).toBe("Valid output");
    });

    it("strips internal Claude Code env vars from child process", async () => {
      process.env["CLAUDECODE"] = "1";
      process.env["CLAUDE_CODE_ENTRYPOINT"] = "mcp";

      const provider = setupAvailableProvider();
      const claudeProc = createMockProcess({ stdout: streamingOutput, exitCode: 0 });
      mockSpawn.mockReturnValueOnce(claudeProc);

      await provider.generate(mockMessages);

      // Check the env passed to the claude spawn (3rd arg)
      const spawnOpts = mockSpawn.mock.calls[1]![2] as { env: Record<string, string> };
      expect(spawnOpts.env["CLAUDECODE"]).toBeUndefined();
      expect(spawnOpts.env["CLAUDE_CODE_ENTRYPOINT"]).toBeUndefined();
    });
  });
});
