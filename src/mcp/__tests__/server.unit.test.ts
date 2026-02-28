/**
 * Unit tests for src/mcp/server.ts
 *
 * Tests each MCP tool handler in isolation by:
 *  1. Mocking McpServer to capture tool registrations
 *  2. Mocking all external dependencies (analyzer, writer, pipeline, logger)
 *  3. Calling captured handlers directly with test inputs
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ─── Type for captured tool handler ──────────────────────────
type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

// ─── Capture tool registrations ──────────────────────────────
const toolHandlers = new Map<string, ToolHandler>();
const toolMock = vi.fn(
  (
    name: string,
    _description: string,
    _schema: unknown,
    handler: ToolHandler,
  ) => {
    toolHandlers.set(name, handler);
  },
);

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    tool: toolMock,
    connect: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));

// ─── Mock external dependencies ──────────────────────────────
const mockScanCodebase = vi.fn();
const mockReadManifest = vi.fn();
const mockWriteManifest = vi.fn();
const mockCover = vi.fn();
const mockRunTests = vi.fn();

vi.mock("../../scale/analyzer.js", () => ({
  scanCodebase: (...args: unknown[]) => mockScanCodebase(...args),
}));

vi.mock("../../scale/writer.js", () => ({
  readManifest: (...args: unknown[]) => mockReadManifest(...args),
  writeManifest: (...args: unknown[]) => mockWriteManifest(...args),
}));

vi.mock("../../cover/pipeline.js", () => ({
  cover: (...args: unknown[]) => mockCover(...args),
}));

vi.mock("../../run/pipeline.js", () => ({
  runTests: (...args: unknown[]) => mockRunTests(...args),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// ─── Import the module (triggers registration) ──────────────
// Must come AFTER all mocks are set up.
beforeEach(async () => {
  toolHandlers.clear();
  vi.resetModules();
  // Re-import to re-register tools with fresh mocks
  await import("../server.js");
});

// ─── Fixtures ────────────────────────────────────────────────
const sampleManifest = {
  version: 1,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
  project: {
    name: "test-project",
    root: "/tmp/test",
    language: "typescript",
    framework: "none",
    testFramework: "vitest",
    sourceFiles: 10,
    sourceLines: 500,
  },
  modules: [
    {
      path: "src/services",
      files: 5,
      lines: 300,
      complexity: "medium",
      functionality: {
        tests: {
          unit: { expected: 10, current: 5, files: ["test.ts"] },
        },
      },
    },
  ],
  journeys: [
    {
      id: "j1",
      name: "User login",
      steps: ["open app", "enter credentials", "click login"],
      covered: false,
      testFile: null,
    },
  ],
  contracts: [
    {
      endpoint: "POST /api/login",
      method: "POST",
      requestSchema: "LoginDto",
      responseSchema: "AuthResponse",
      covered: true,
      testFile: "auth.contract.test.ts",
    },
  ],
  score: {
    overall: 42,
    breakdown: {
      functionality: 50,
      security: 0,
      stability: 0,
      conformance: 0,
      regression: 0,
    },
    gaps: {
      total: 5,
      critical: 2,
      byDimension: {
        functionality: { missing: 5, priority: "high" },
        security: { issues: 0, priority: "none" },
        stability: { gaps: 0, priority: "none" },
        conformance: { violations: 0, priority: "none" },
      },
    },
    history: [],
  },
};

// ─── Tests ───────────────────────────────────────────────────

describe("MCP Server — Tool Registration", () => {
  it("registers all 7 tools", () => {
    expect(toolHandlers.size).toBe(7);
    expect(toolHandlers.has("coverit_scan")).toBe(true);
    expect(toolHandlers.has("coverit_cover")).toBe(true);
    expect(toolHandlers.has("coverit_run")).toBe(true);
    expect(toolHandlers.has("coverit_status")).toBe(true);
    expect(toolHandlers.has("coverit_clear")).toBe(true);
    expect(toolHandlers.has("coverit_backup")).toBe(true);
    expect(toolHandlers.has("coverit_restore")).toBe(true);
  });
});

describe("coverit_scan handler", () => {
  it("returns formatted manifest on success", async () => {
    mockScanCodebase.mockResolvedValue(sampleManifest);
    mockWriteManifest.mockResolvedValue(undefined);

    const handler = toolHandlers.get("coverit_scan")!;
    const result = await handler({ projectRoot: "/tmp/test" });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.project.name).toBe("test-project");
    expect(parsed.moduleCount).toBe(1);
    expect(parsed.journeyCount).toBe(1);
    expect(parsed.contractCount).toBe(1);
    expect(parsed.score.overall).toBe(42);
    expect(parsed.modules[0].path).toBe("src/services");
  });

  it("returns error response when scanCodebase throws", async () => {
    mockScanCodebase.mockRejectedValue(new Error("AI provider failed"));

    const handler = toolHandlers.get("coverit_scan")!;
    const result = await handler({ projectRoot: "/tmp/test" });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("AI provider failed");
  });
});

describe("coverit_cover handler", () => {
  it("returns cover result on success", async () => {
    const coverResult = {
      scoreBefore: 40,
      scoreAfter: 65,
      modulesProcessed: 3,
      testsGenerated: 12,
      testsPassed: 10,
      testsFailed: 2,
    };
    mockCover.mockResolvedValue(coverResult);

    const handler = toolHandlers.get("coverit_cover")!;
    const result = await handler({ projectRoot: "/tmp/test", modules: ["src/services"] });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.scoreBefore).toBe(40);
    expect(parsed.scoreAfter).toBe(65);
    expect(parsed.testsGenerated).toBe(12);
  });

  it("returns error response when cover throws", async () => {
    mockCover.mockRejectedValue(new Error("No coverit.json found"));

    const handler = toolHandlers.get("coverit_cover")!;
    const result = await handler({ projectRoot: "/tmp/test" });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("No coverit.json found");
  });
});

describe("coverit_run handler", () => {
  it("returns run result on success", async () => {
    const runResult = {
      scoreBefore: 40,
      scoreAfter: 45,
      totalTests: 20,
      passed: 18,
      failed: 2,
      fixed: 3,
    };
    mockRunTests.mockResolvedValue(runResult);

    const handler = toolHandlers.get("coverit_run")!;
    const result = await handler({ projectRoot: "/tmp/test" });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.scoreBefore).toBe(40);
    expect(parsed.scoreAfter).toBe(45);
    expect(parsed.totalTests).toBe(20);
    expect(parsed.fixed).toBe(3);
  });

  it("passes modules option correctly", async () => {
    mockRunTests.mockResolvedValue({
      scoreBefore: 40,
      scoreAfter: 42,
      totalTests: 10,
      passed: 10,
      failed: 0,
      fixed: 0,
    });

    const handler = toolHandlers.get("coverit_run")!;
    await handler({ projectRoot: "/tmp/test", modules: ["src/services"] });

    expect(mockRunTests).toHaveBeenCalledWith({
      projectRoot: "/tmp/test",
      modules: ["src/services"],
    });
  });

  it("returns error response when runTests throws", async () => {
    mockRunTests.mockRejectedValue(new Error("No coverit.json found"));

    const handler = toolHandlers.get("coverit_run")!;
    const result = await handler({ projectRoot: "/tmp/test" });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("No coverit.json found");
  });
});

describe("coverit_status handler", () => {
  it("returns manifest summary when manifest exists", async () => {
    mockReadManifest.mockResolvedValue(sampleManifest);

    const handler = toolHandlers.get("coverit_status")!;
    const result = await handler({ projectRoot: "/tmp/test" });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.project.name).toBe("test-project");
    expect(parsed.score.overall).toBe(42);
    expect(parsed.moduleCount).toBe(1);
    expect(parsed.modules[0].path).toBe("src/services");
  });

  it("returns guidance message when no manifest exists", async () => {
    mockReadManifest.mockResolvedValue(null);

    const handler = toolHandlers.get("coverit_status")!;
    const result = await handler({ projectRoot: "/tmp/test" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("No coverit.json found");
    expect(result.content[0]!.text).toContain("coverit_scan");
  });
});

describe("coverit_backup handler", () => {
  it("exports manifest as backup JSON with version and timestamp", async () => {
    mockReadManifest.mockResolvedValue(sampleManifest);

    const handler = toolHandlers.get("coverit_backup")!;
    const result = await handler({ projectRoot: "/tmp/test" });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.version).toBe(1);
    expect(parsed.exported_at).toBeDefined();
    expect(parsed.manifest.project.name).toBe("test-project");
  });

  it("returns error when no manifest exists for backup", async () => {
    mockReadManifest.mockResolvedValue(null);

    const handler = toolHandlers.get("coverit_backup")!;
    const result = await handler({ projectRoot: "/tmp/test" });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Nothing to backup");
  });
});
