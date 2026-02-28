/**
 * Unit tests for analyzer.ts
 * Tests scanCodebase and the internal aiModuleToEntry helper with all
 * external dependencies mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────

vi.mock("../../utils/framework-detector.js", () => ({
  detectProjectInfo: vi.fn(),
}));

vi.mock("../../ai/provider-factory.js", () => ({
  createAIProvider: vi.fn(),
}));

vi.mock("../../ai/scale-prompts.js", () => ({
  buildScalePrompt: vi.fn(),
  parseScaleResponse: vi.fn(),
}));

vi.mock("../../scoring/engine.js", () => ({
  calculateScore: vi.fn(),
}));

vi.mock("../writer.js", () => ({
  readManifest: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { scanCodebase } from "../analyzer.js";
import { detectProjectInfo } from "../../utils/framework-detector.js";
import { createAIProvider } from "../../ai/provider-factory.js";
import { buildScalePrompt, parseScaleResponse } from "../../ai/scale-prompts.js";
import { calculateScore } from "../../scoring/engine.js";
import { readManifest } from "../writer.js";
import type { AIProvider, AIResponse } from "../../ai/types.js";
import type { ProjectInfo } from "../../types/index.js";
import type { ScaleAIResponse } from "../../ai/scale-prompts.js";

// ─── Fixtures ────────────────────────────────────────────────

const mockProjectInfo: ProjectInfo = {
  name: "test-app",
  root: "/tmp/test-app",
  language: "typescript",
  framework: "nestjs",
  testFramework: "vitest",
  packageManager: "bun",
  hasExistingTests: true,
  existingTestPatterns: ["*.test.ts"],
};

const mockAIResponse: AIResponse = {
  content: "mock-json-response",
  model: "claude-opus-4-6",
};

const mockParsedResult: ScaleAIResponse = {
  sourceFiles: 20,
  sourceLines: 2000,
  modules: [
    {
      path: "src/services",
      files: 8,
      lines: 1200,
      complexity: "medium",
      functionality: {
        tests: {
          unit: { expected: 6, current: 3, files: ["test1.ts"] },
          integration: { expected: 10, current: 5, files: ["test2.ts"] },
        },
      },
    },
    {
      path: "src/utils",
      files: 3,
      lines: 200,
      complexity: "low",
      functionality: {
        tests: {
          unit: { expected: 3, current: 3, files: ["test3.ts"] },
        },
      },
    },
  ],
  journeys: [
    {
      id: "j1",
      name: "Login flow",
      steps: ["Enter creds", "Submit"],
      covered: false,
      testFile: null,
    },
  ],
  contracts: [
    {
      endpoint: "POST /api/users",
      method: "POST",
      requestSchema: "CreateUserDto",
      responseSchema: "UserResponse",
      covered: true,
      testFile: "contract.test.ts",
    },
  ],
};

const mockScoreResult = {
  overall: 55,
  breakdown: {
    functionality: 50,
    security: 100,
    stability: 0,
    conformance: 0,
    regression: 100,
  },
  gaps: {
    total: 8,
    critical: 0,
    byDimension: {
      functionality: { missing: 8, priority: "high" },
      security: { issues: 0, priority: "none" },
      stability: { gaps: 0, priority: "none" },
      conformance: { violations: 0, priority: "none" },
    },
  },
  history: [],
  scanned: {},
};

function createMockProvider(response: AIResponse = mockAIResponse): AIProvider {
  return {
    name: "mock-provider",
    generate: vi.fn().mockResolvedValue(response),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
}

// ─── Tests ───────────────────────────────────────────────────

describe("scanCodebase", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(detectProjectInfo).mockResolvedValue(mockProjectInfo);
    vi.mocked(readManifest).mockResolvedValue(null);
    vi.mocked(buildScalePrompt).mockReturnValue([
      { role: "system", content: "System prompt" },
      { role: "user", content: "User prompt" },
    ]);
    vi.mocked(parseScaleResponse).mockReturnValue(mockParsedResult);
    vi.mocked(calculateScore).mockReturnValue(mockScoreResult);
  });

  it("detects project info from the project root", async () => {
    const provider = createMockProvider();

    await scanCodebase("/tmp/test-app", provider);

    expect(detectProjectInfo).toHaveBeenCalledWith("/tmp/test-app");
  });

  it("reads existing manifest for incremental analysis", async () => {
    const provider = createMockProvider();

    await scanCodebase("/tmp/test-app", provider);

    expect(readManifest).toHaveBeenCalledWith("/tmp/test-app");
  });

  it("uses the provided AI provider instead of auto-detecting", async () => {
    const provider = createMockProvider();

    await scanCodebase("/tmp/test-app", provider);

    expect(createAIProvider).not.toHaveBeenCalled();
    expect(provider.generate).toHaveBeenCalled();
  });

  it("auto-detects AI provider when none provided", async () => {
    const autoProvider = createMockProvider();
    vi.mocked(createAIProvider).mockResolvedValue(autoProvider);

    await scanCodebase("/tmp/test-app");

    expect(createAIProvider).toHaveBeenCalled();
    expect(autoProvider.generate).toHaveBeenCalled();
  });

  it("builds prompt from project info and calls AI", async () => {
    const provider = createMockProvider();

    await scanCodebase("/tmp/test-app", provider);

    expect(buildScalePrompt).toHaveBeenCalledWith(mockProjectInfo, undefined);
    expect(provider.generate).toHaveBeenCalledWith(
      [
        { role: "system", content: "System prompt" },
        { role: "user", content: "User prompt" },
      ],
      expect.objectContaining({
        allowedTools: ["Read", "Glob", "Grep", "Bash"],
        cwd: "/tmp/test-app",
        timeoutMs: 600_000,
      }),
    );
  });

  it("parses AI response and assembles manifest with correct structure", async () => {
    const provider = createMockProvider();

    const result = await scanCodebase("/tmp/test-app", provider);

    expect(parseScaleResponse).toHaveBeenCalledWith("mock-json-response");
    expect(result.version).toBe(1);
    expect(result.project.name).toBe("test-app");
    expect(result.project.root).toBe("/tmp/test-app");
    expect(result.project.language).toBe("typescript");
    expect(result.project.framework).toBe("nestjs");
    expect(result.project.testFramework).toBe("vitest");
    expect(result.project.sourceFiles).toBe(20);
    expect(result.project.sourceLines).toBe(2000);
  });

  it("converts AI modules to ModuleEntry with security/stability/conformance placeholders", async () => {
    const provider = createMockProvider();

    const result = await scanCodebase("/tmp/test-app", provider);

    expect(result.modules).toHaveLength(2);

    const mod = result.modules[0]!;
    expect(mod.path).toBe("src/services");
    expect(mod.files).toBe(8);
    expect(mod.lines).toBe(1200);
    expect(mod.complexity).toBe("medium");

    // Functionality tests properly mapped
    expect(mod.functionality.tests.unit).toEqual({
      expected: 6,
      current: 3,
      files: ["test1.ts"],
    });
    expect(mod.functionality.tests.integration).toEqual({
      expected: 10,
      current: 5,
      files: ["test2.ts"],
    });

    // Security/stability/conformance initialized with neutral placeholders
    expect(mod.security).toEqual({ issues: 0, resolved: 0, findings: [] });
    expect(mod.stability).toEqual({ score: 0, gaps: [] });
    expect(mod.conformance).toEqual({ score: 0, violations: [] });
  });

  it("maps journeys from AI response to manifest format", async () => {
    const provider = createMockProvider();

    const result = await scanCodebase("/tmp/test-app", provider);

    expect(result.journeys).toHaveLength(1);
    expect(result.journeys[0]).toEqual({
      id: "j1",
      name: "Login flow",
      steps: ["Enter creds", "Submit"],
      covered: false,
      testFile: null,
    });
  });

  it("maps contracts from AI response to manifest format", async () => {
    const provider = createMockProvider();

    const result = await scanCodebase("/tmp/test-app", provider);

    expect(result.contracts).toHaveLength(1);
    expect(result.contracts[0]).toEqual({
      endpoint: "POST /api/users",
      method: "POST",
      requestSchema: "CreateUserDto",
      responseSchema: "UserResponse",
      covered: true,
      testFile: "contract.test.ts",
    });
  });

  it("uses calculated score from scoring engine", async () => {
    const provider = createMockProvider();

    const result = await scanCodebase("/tmp/test-app", provider);

    expect(calculateScore).toHaveBeenCalled();
    expect(result.score.overall).toBe(55);
    expect(result.score.breakdown.functionality).toBe(50);
  });

  it("adds first-time scope to history when no existing manifest", async () => {
    const provider = createMockProvider();

    const result = await scanCodebase("/tmp/test-app", provider);

    expect(result.score.history).toHaveLength(1);
    expect(result.score.history[0]!.scope).toBe("first-time");
    expect(result.score.history[0]!.score).toBe(55);
  });

  it("adds re-analysis scope to history when existing manifest present", async () => {
    const existingManifest = {
      version: 1 as const,
      createdAt: "2024-01-01",
      updatedAt: "2024-01-02",
      project: {
        name: "test-app",
        root: "/tmp/test-app",
        language: "typescript" as const,
        framework: "nestjs" as const,
        testFramework: "vitest" as const,
        sourceFiles: 15,
        sourceLines: 1500,
      },
      dimensions: {} as any,
      modules: [],
      journeys: [],
      contracts: [],
      score: {
        overall: 40,
        breakdown: { functionality: 40, security: 0, stability: 0, conformance: 0, regression: 0 },
        gaps: { total: 10, critical: 2, byDimension: { functionality: { missing: 10, priority: "high" }, security: { issues: 0, priority: "none" }, stability: { gaps: 0, priority: "none" }, conformance: { violations: 0, priority: "none" } } },
        history: [{ date: "2024-01-01", score: 40, scope: "first-time" }],
        scanned: { functionality: "2024-01-01" },
      },
    };
    vi.mocked(readManifest).mockResolvedValue(existingManifest as any);
    const provider = createMockProvider();

    const result = await scanCodebase("/tmp/test-app", provider);

    // Preserves old history + appends re-analysis entry
    expect(result.score.history).toHaveLength(2);
    expect(result.score.history[0]!.scope).toBe("first-time");
    expect(result.score.history[1]!.scope).toBe("re-analysis");
  });

  it("falls back to aggregated source counts when AI reports 0", async () => {
    vi.mocked(parseScaleResponse).mockReturnValue({
      ...mockParsedResult,
      sourceFiles: 0,
      sourceLines: 0,
    });
    const provider = createMockProvider();

    const result = await scanCodebase("/tmp/test-app", provider);

    // Should aggregate from modules: 8 + 3 = 11 files, 1200 + 200 = 1400 lines
    expect(result.project.sourceFiles).toBe(11);
    expect(result.project.sourceLines).toBe(1400);
  });

  it("filters out invalid test types from AI module data", async () => {
    vi.mocked(parseScaleResponse).mockReturnValue({
      ...mockParsedResult,
      modules: [
        {
          path: "src/services",
          files: 5,
          lines: 500,
          complexity: "medium",
          functionality: {
            tests: {
              unit: { expected: 6, current: 3, files: [] },
              unknown_type: { expected: 2, current: 1, files: [] },
              integration: { expected: 10, current: 5, files: [] },
            },
          },
        },
      ],
    });
    const provider = createMockProvider();

    const result = await scanCodebase("/tmp/test-app", provider);

    const tests = result.modules[0]!.functionality.tests;
    expect(tests.unit).toBeDefined();
    expect(tests.integration).toBeDefined();
    // invalid type should be filtered out
    expect("unknown_type" in tests).toBe(false);
  });

  it("preserves existing createdAt and dimensions from existing manifest", async () => {
    const existingManifest = {
      version: 1 as const,
      createdAt: "2023-06-15T00:00:00.000Z",
      updatedAt: "2023-06-20T00:00:00.000Z",
      project: {
        name: "test-app",
        root: "/tmp/test-app",
        language: "typescript" as const,
        framework: "nestjs" as const,
        testFramework: "vitest" as const,
        sourceFiles: 10,
        sourceLines: 1000,
      },
      dimensions: {
        functionality: { enabled: true, weight: 0.40, targets: { unit: { coverage: "all" as const }, integration: { coverage: "all-boundaries" as const }, api: { coverage: "all-endpoints" as const }, e2e: { coverage: "critical-journeys" as const }, contract: { coverage: "all-public-apis" as const } } },
        security: { enabled: false, weight: 0, checks: [] },
        stability: { enabled: false, weight: 0, checks: [] },
        conformance: { enabled: false, weight: 0, checks: [] },
        regression: { enabled: false, weight: 0, strategy: "all-existing-tests-pass" as const },
      },
      modules: [],
      journeys: [],
      contracts: [],
      score: {
        overall: 30,
        breakdown: { functionality: 30, security: 0, stability: 0, conformance: 0, regression: 0 },
        gaps: { total: 5, critical: 0, byDimension: { functionality: { missing: 5, priority: "high" }, security: { issues: 0, priority: "none" }, stability: { gaps: 0, priority: "none" }, conformance: { violations: 0, priority: "none" } } },
        history: [],
        scanned: { functionality: "2023-06-15" },
      },
    };
    vi.mocked(readManifest).mockResolvedValue(existingManifest as any);
    const provider = createMockProvider();

    const result = await scanCodebase("/tmp/test-app", provider);

    // createdAt preserved from existing
    expect(result.createdAt).toBe("2023-06-15T00:00:00.000Z");
    // dimensions preserved from existing (custom weight 0.40)
    expect(result.dimensions.functionality.weight).toBe(0.40);
  });
});
