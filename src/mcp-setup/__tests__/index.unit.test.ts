/**
 * Unit tests for src/mcp-setup/index.ts
 *
 * Verifies that the MCP setup module correctly wires up:
 *  1. createToolRegistry with coverit-specific config
 *  2. createSetupRunner with the registry output + product name
 *  3. The exported runSetup is the function returned by createSetupRunner
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock return values ──────────────────────────────────────
const mockRunSetup = vi.fn();
const mockShowStatus = vi.fn();
const mockTools = [{ id: "mock-tool" }];
const mockResolveTools = vi.fn();

const mockCreateToolRegistry = vi.fn().mockReturnValue({
  tools: mockTools,
  resolveTools: mockResolveTools,
});

const mockCreateSetupRunner = vi.fn().mockReturnValue({
  runSetup: mockRunSetup,
  showStatus: mockShowStatus,
  installFlow: vi.fn(),
  removeFlow: vi.fn(),
  parseArgs: vi.fn(),
  showHelp: vi.fn(),
});

vi.mock("@devness/mcp-setup", () => ({
  createToolRegistry: (...args: unknown[]) =>
    mockCreateToolRegistry(...args),
  createSetupRunner: (...args: unknown[]) =>
    mockCreateSetupRunner(...args),
}));

// ─── Expected constants ──────────────────────────────────────
const EXPECTED_INSTRUCTIONS_TEXT = [
  "## Coverit — AI Test Generation",
  "",
  "Coverit generates and runs tests. Available via MCP tools or slash commands:",
  "- `/coverit:scan` — AI scans and analyzes codebase, creates coverit.json",
  "- `/coverit:cover` — AI generates tests from gaps and updates your score",
  "- `/coverit:run` — Run existing tests, fix failures, update your score",
  "- `/coverit:status` — Show quality dashboard from coverit.json",
].join("\n");

// ─── Tests ───────────────────────────────────────────────────

describe("mcp-setup/index — createToolRegistry call", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls createToolRegistry with correct coverit config", async () => {
    // Re-import to trigger module execution with fresh mocks
    vi.resetModules();
    await import("../index.js");

    expect(mockCreateToolRegistry).toHaveBeenCalledTimes(1);

    const registryConfig = mockCreateToolRegistry.mock.calls[0]![0];
    expect(registryConfig).toEqual({
      serverName: "Coverit",
      legacyName: "coverit",
      mcpEntry: { command: "npx", args: ["-y", "@devness/coverit@latest"] },
      instructions: {
        text: EXPECTED_INSTRUCTIONS_TEXT,
        startMarker: "<!-- coverit:start -->",
        endMarker: "<!-- coverit:end -->",
      },
      instructionFileName: "coverit",
    });
  });

  it("calls createSetupRunner with registry output and product name", async () => {
    vi.resetModules();
    await import("../index.js");

    expect(mockCreateSetupRunner).toHaveBeenCalledTimes(1);

    const setupConfig = mockCreateSetupRunner.mock.calls[0]![0];
    expect(setupConfig.productName).toBe("Coverit");
    expect(setupConfig.tools).toBe(mockTools);
    expect(setupConfig.resolveTools).toBe(mockResolveTools);
    expect(setupConfig.instructionsText).toBe(EXPECTED_INSTRUCTIONS_TEXT);
  });

  it("exports runSetup from the createSetupRunner result", async () => {
    vi.resetModules();
    const mod = await import("../index.js");

    expect(mod.runSetup).toBe(mockRunSetup);
  });
});
