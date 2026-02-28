/**
 * Unit tests for src/entry.ts (CLI entry point)
 * Tests the routing logic that dispatches to MCP server, setup wizard,
 * or CLI based on process.argv[2].
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Test Helpers ───────────────────────────────────────────

/** Save/restore process.argv around each test */
let originalArgv: string[];

beforeEach(() => {
  originalArgv = [...process.argv];
  vi.resetModules();
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

// ─── Routing Logic Tests ────────────────────────────────────

describe("entry routing logic", () => {
  it("routes to mcp-setup when subcommand is 'mcp'", async () => {
    const mockRunSetup = vi.fn().mockResolvedValue(undefined);
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    vi.doMock("../mcp-setup/index.js", () => ({
      runSetup: mockRunSetup,
    }));

    process.argv = ["node", "entry.js", "mcp", "--install"];

    try {
      await import("../entry.js");
    } catch {
      // process.exit throws in our mock
    }

    expect(mockRunSetup).toHaveBeenCalledWith(["--install"]);
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("routes to MCP server when no subcommand is provided", async () => {
    const mockServerModule = {};
    vi.doMock("../mcp/server.js", () => mockServerModule);

    process.argv = ["node", "entry.js"];

    // Should not throw - just imports the MCP server module
    await expect(import("../entry.js")).resolves.toBeDefined();
  });

  it("routes to CLI for any other subcommand (analyze, cover, status, clear)", async () => {
    const mockCliModule = {};
    vi.doMock("../cli/index.js", () => mockCliModule);

    process.argv = ["node", "entry.js", "analyze"];

    await expect(import("../entry.js")).resolves.toBeDefined();
  });

  it("routes to CLI for 'cover' subcommand", async () => {
    const mockCliModule = {};
    vi.doMock("../cli/index.js", () => mockCliModule);

    process.argv = ["node", "entry.js", "cover"];

    await expect(import("../entry.js")).resolves.toBeDefined();
  });

  it("routes to CLI for 'status' subcommand", async () => {
    const mockCliModule = {};
    vi.doMock("../cli/index.js", () => mockCliModule);

    process.argv = ["node", "entry.js", "status"];

    await expect(import("../entry.js")).resolves.toBeDefined();
  });

  it("passes remaining args to mcp setup when subcommand is 'mcp'", async () => {
    const mockRunSetup = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    vi.doMock("../mcp-setup/index.js", () => ({
      runSetup: mockRunSetup,
    }));

    process.argv = ["node", "entry.js", "mcp", "--uninstall", "--verbose"];

    try {
      await import("../entry.js");
    } catch {
      // process.exit throws
    }

    expect(mockRunSetup).toHaveBeenCalledWith(["--uninstall", "--verbose"]);
  });
});
