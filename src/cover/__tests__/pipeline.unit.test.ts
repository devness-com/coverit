/**
 * Unit tests for cover/pipeline.ts
 * Tests the cover() function and internal identifyGaps logic with all
 * external dependencies mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────

vi.mock("../../scale/writer.js", () => ({
  readManifest: vi.fn(),
  writeManifest: vi.fn(),
}));

vi.mock("../../measure/scanner.js", () => ({
  scanTests: vi.fn(),
}));

vi.mock("../../measure/scorer.js", () => ({
  rescoreManifest: vi.fn(),
}));

vi.mock("../../ai/provider-factory.js", () => ({
  createAIProvider: vi.fn(),
}));

vi.mock("../../ai/cover-prompts.js", () => ({
  buildCoverPrompt: vi.fn(),
  parseCoverResponse: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { cover, type CoverOptions, type CoverResult } from "../pipeline.js";
import { readManifest, writeManifest } from "../../scale/writer.js";
import { scanTests } from "../../measure/scanner.js";
import { rescoreManifest } from "../../measure/scorer.js";
import { createAIProvider } from "../../ai/provider-factory.js";
import { buildCoverPrompt, parseCoverResponse } from "../../ai/cover-prompts.js";
import type { AIProvider, AIResponse } from "../../ai/types.js";
import type { CoveritManifest, ModuleEntry } from "../../schema/coverit-manifest.js";

// ─── Fixtures ────────────────────────────────────────────────

function createMockModule(overrides: Partial<ModuleEntry> = {}): ModuleEntry {
  return {
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
    security: { issues: 0, resolved: 0, findings: [] },
    stability: { score: 0, gaps: [] },
    conformance: { score: 0, violations: [] },
    ...overrides,
  };
}

function createMockManifest(overrides: Partial<CoveritManifest> = {}): CoveritManifest {
  return {
    version: 1,
    createdAt: "2024-01-01",
    updatedAt: "2024-01-02",
    project: {
      name: "test-project",
      root: "/tmp/test-project",
      language: "typescript",
      framework: "nestjs",
      testFramework: "vitest",
      sourceFiles: 50,
      sourceLines: 5000,
    },
    dimensions: {
      functionality: { enabled: true, weight: 0.35, targets: { unit: { coverage: "critical-paths" }, integration: { coverage: "all-boundaries" }, api: { coverage: "all-endpoints" }, e2e: { coverage: "critical-journeys" }, contract: { coverage: "all-public-apis" } } },
      security: { enabled: true, weight: 0.25, checks: [] },
      stability: { enabled: true, weight: 0.15, checks: [] },
      conformance: { enabled: true, weight: 0.15, checks: [] },
      regression: { enabled: true, weight: 0.10, strategy: "all-existing-tests-pass" },
    },
    modules: [createMockModule()],
    journeys: [],
    contracts: [],
    score: {
      overall: 45,
      breakdown: { functionality: 45, security: 0, stability: 0, conformance: 0, regression: 0 },
      gaps: { total: 8, critical: 0, byDimension: { functionality: { missing: 8, priority: "high" }, security: { issues: 0, priority: "none" }, stability: { gaps: 0, priority: "none" }, conformance: { violations: 0, priority: "none" } } },
      history: [],
      scanned: { functionality: "2024-01-01" },
    },
    ...overrides,
  };
}

function createMockProvider(response?: AIResponse): AIProvider {
  return {
    name: "mock-provider",
    generate: vi.fn().mockResolvedValue(response ?? { content: '{"testsWritten": 3, "testsPassed": 3, "testsFailed": 0, "files": ["a.test.ts"]}', model: "mock" }),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
}

// ─── Tests ───────────────────────────────────────────────────

describe("cover (unit)", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default happy-path mocks
    vi.mocked(readManifest).mockResolvedValue(createMockManifest());
    vi.mocked(writeManifest).mockResolvedValue(undefined);
    vi.mocked(scanTests).mockResolvedValue({
      totalTestFiles: 2,
      totalTestCount: 10,
      byModule: new Map([["src/services", { tests: { unit: { current: 6, files: ["a.test.ts"] }, integration: { current: 8, files: ["b.test.ts"] } } }]]),
    });
    vi.mocked(rescoreManifest).mockImplementation((m) => ({
      ...m,
      score: { ...m.score, overall: 70 },
    }));
    vi.mocked(buildCoverPrompt).mockReturnValue([
      { role: "system", content: "System" },
      { role: "user", content: "User" },
    ]);
    vi.mocked(parseCoverResponse).mockReturnValue({
      testsWritten: 3,
      testsPassed: 3,
      testsFailed: 0,
      files: ["a.test.ts"],
    });
  });

  it("throws when no coverit.json manifest exists", async () => {
    vi.mocked(readManifest).mockResolvedValue(null);

    await expect(cover({ projectRoot: "/tmp/test" })).rejects.toThrow(
      "No coverit.json found",
    );
  });

  it("returns early with zero-counts when there are no gaps", async () => {
    const noGapModule = createMockModule({
      functionality: {
        tests: {
          unit: { expected: 3, current: 3, files: ["a.test.ts"] },
          integration: { expected: 5, current: 5, files: ["b.test.ts"] },
        },
      },
    });
    vi.mocked(readManifest).mockResolvedValue(
      createMockManifest({ modules: [noGapModule] }),
    );

    const result = await cover({ projectRoot: "/tmp/test" });

    expect(result.modulesProcessed).toBe(0);
    expect(result.testsGenerated).toBe(0);
    expect(result.testsPassed).toBe(0);
    expect(result.testsFailed).toBe(0);
    expect(result.scoreBefore).toBe(45);
    expect(result.scoreAfter).toBe(45);
  });

  it("uses the provided AI provider instead of auto-detecting", async () => {
    const provider = createMockProvider();

    await cover({ projectRoot: "/tmp/test", aiProvider: provider });

    expect(createAIProvider).not.toHaveBeenCalled();
    expect(provider.generate).toHaveBeenCalled();
  });

  it("auto-detects AI provider when none is provided", async () => {
    const autoProvider = createMockProvider();
    vi.mocked(createAIProvider).mockResolvedValue(autoProvider);

    await cover({ projectRoot: "/tmp/test" });

    expect(createAIProvider).toHaveBeenCalled();
    expect(autoProvider.generate).toHaveBeenCalled();
  });

  it("accumulates test results from AI responses across modules", async () => {
    const mod1 = createMockModule({
      path: "src/services",
      complexity: "high",
      functionality: {
        tests: {
          unit: { expected: 12, current: 3, files: [] },
        },
      },
    });
    const mod2 = createMockModule({
      path: "src/utils",
      complexity: "low",
      functionality: {
        tests: {
          unit: { expected: 3, current: 0, files: [] },
        },
      },
    });

    vi.mocked(readManifest).mockResolvedValue(
      createMockManifest({ modules: [mod1, mod2] }),
    );

    // First module: 5 written, 4 passed, 1 failed
    // Second module: 2 written, 2 passed, 0 failed
    vi.mocked(parseCoverResponse)
      .mockReturnValueOnce({ testsWritten: 5, testsPassed: 4, testsFailed: 1, files: ["a.test.ts"] })
      .mockReturnValueOnce({ testsWritten: 2, testsPassed: 2, testsFailed: 0, files: ["b.test.ts"] });

    const provider = createMockProvider();
    const result = await cover({ projectRoot: "/tmp/test", aiProvider: provider });

    expect(result.modulesProcessed).toBe(2);
    expect(result.testsGenerated).toBe(7);
    expect(result.testsPassed).toBe(6);
    expect(result.testsFailed).toBe(1);
  });

  it("handles AI provider errors gracefully per module and continues", async () => {
    const mod1 = createMockModule({
      path: "src/services",
      complexity: "high",
      functionality: { tests: { unit: { expected: 12, current: 3, files: [] } } },
    });
    const mod2 = createMockModule({
      path: "src/utils",
      complexity: "low",
      functionality: { tests: { unit: { expected: 3, current: 0, files: [] } } },
    });

    vi.mocked(readManifest).mockResolvedValue(
      createMockManifest({ modules: [mod1, mod2] }),
    );

    const provider = createMockProvider();
    // First call throws, second succeeds
    vi.mocked(provider.generate)
      .mockRejectedValueOnce(new Error("AI timeout"))
      .mockResolvedValueOnce({ content: '{"testsWritten": 2, "testsPassed": 2, "testsFailed": 0, "files": []}', model: "mock" });

    vi.mocked(parseCoverResponse).mockReturnValue({
      testsWritten: 2, testsPassed: 2, testsFailed: 0, files: [],
    });

    const result = await cover({ projectRoot: "/tmp/test", aiProvider: provider });

    // Both modules are processed (one errored, one succeeded)
    expect(result.modulesProcessed).toBe(2);
    // Only the successful module's tests are counted
    expect(result.testsGenerated).toBe(2);
  });
});
