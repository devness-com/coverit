/**
 * Integration tests for cover/pipeline.ts
 * Tests the cover pipeline with realistic manifests and mock AI provider,
 * verifying gap identification, sorting, module filtering, manifest updates,
 * and score tracking.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────
// We mock filesystem-touching and AI layers, but let internal logic
// (identifyGaps, sorting, accumulation) run for real.

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

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// NOTE: We do NOT mock cover-prompts — we use real buildCoverPrompt/parseCoverResponse
// to test the integration of gap identification → prompt building → response parsing.

import { cover } from "../pipeline.js";
import { readManifest, writeManifest } from "../../scale/writer.js";
import { scanTests } from "../../measure/scanner.js";
import { rescoreManifest } from "../../measure/scorer.js";
import type { AIProvider, AIResponse } from "../../ai/types.js";
import type {
  CoveritManifest,
  ModuleEntry,
} from "../../schema/coverit-manifest.js";

// ─── Helpers ─────────────────────────────────────────────────

function makeModule(overrides: Partial<ModuleEntry>): ModuleEntry {
  return {
    path: "src/default",
    files: 5,
    lines: 500,
    complexity: "medium",
    functionality: {
      tests: {
        unit: { expected: 6, current: 6, files: [] },
      },
    },
    security: { issues: 0, resolved: 0, findings: [] },
    stability: { score: 0, gaps: [] },
    conformance: { score: 0, violations: [] },
    ...overrides,
  };
}

function makeManifest(modules: ModuleEntry[], overrides: Partial<CoveritManifest> = {}): CoveritManifest {
  return {
    version: 1,
    createdAt: "2024-01-01",
    updatedAt: "2024-01-02",
    project: {
      name: "test-project",
      root: "/tmp/project",
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
    modules,
    journeys: [],
    contracts: [],
    score: {
      overall: 40,
      breakdown: { functionality: 40, security: 0, stability: 0, conformance: 0, regression: 0 },
      gaps: { total: 10, critical: 0, byDimension: { functionality: { missing: 10, priority: "high" }, security: { issues: 0, priority: "none" }, stability: { gaps: 0, priority: "none" }, conformance: { violations: 0, priority: "none" } } },
      history: [{ date: "2024-01-01", score: 40, scope: "first-time" }],
      scanned: { functionality: "2024-01-01" },
    },
    ...overrides,
  };
}

function makeProvider(responses: AIResponse[]): AIProvider {
  const gen = vi.fn();
  for (const resp of responses) {
    gen.mockResolvedValueOnce(resp);
  }
  return {
    name: "test-provider",
    generate: gen,
    isAvailable: vi.fn().mockResolvedValue(true),
  };
}

function aiResponse(written: number, passed: number, failed: number, files: string[] = []): AIResponse {
  return {
    content: JSON.stringify({ testsWritten: written, testsPassed: passed, testsFailed: failed, files }),
    model: "test-model",
  };
}

// ─── Setup ───────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(writeManifest).mockResolvedValue(undefined);
  vi.mocked(scanTests).mockResolvedValue({
    totalTestFiles: 0,
    totalTestCount: 0,
    byModule: new Map(),
  });
  vi.mocked(rescoreManifest).mockImplementation((m) => ({
    ...m,
    score: { ...m.score, overall: m.score.overall + 10 },
  }));
});

// ─── Tests ───────────────────────────────────────────────────

describe("cover pipeline integration", () => {
  it("processes a full pipeline: gaps → AI → rescan → rescore → write", async () => {
    const mod = makeModule({
      path: "src/services",
      complexity: "high",
      functionality: {
        tests: {
          unit: { expected: 12, current: 3, files: ["existing.test.ts"] },
          integration: { expected: 20, current: 10, files: [] },
        },
      },
    });
    const manifest = makeManifest([mod]);
    vi.mocked(readManifest).mockResolvedValue(manifest);

    const provider = makeProvider([
      aiResponse(5, 4, 1, ["src/services/__tests__/new.test.ts"]),
    ]);

    const result = await cover({ projectRoot: "/tmp/project", aiProvider: provider });

    expect(result.scoreBefore).toBe(40);
    // rescoreManifest mock adds +10 each call: incremental save (50) + final save (60)
    expect(result.scoreAfter).toBe(60);
    expect(result.modulesProcessed).toBe(1);
    expect(result.testsGenerated).toBe(5);
    expect(result.testsPassed).toBe(4);
    expect(result.testsFailed).toBe(1);

    // Manifest is written incrementally after each module + final consistency save
    expect(writeManifest).toHaveBeenCalledTimes(2);
    expect(rescoreManifest).toHaveBeenCalledTimes(2);
  });

  it("sorts modules by complexity (high first) then by total gap (largest first)", async () => {
    const lowSmallGap = makeModule({
      path: "src/utils",
      complexity: "low",
      functionality: { tests: { unit: { expected: 3, current: 0, files: [] } } },
    });
    const mediumBigGap = makeModule({
      path: "src/controllers",
      complexity: "medium",
      functionality: {
        tests: {
          unit: { expected: 6, current: 0, files: [] },
          integration: { expected: 10, current: 0, files: [] },
        },
      },
    });
    const highBigGap = makeModule({
      path: "src/services",
      complexity: "high",
      functionality: {
        tests: {
          unit: { expected: 12, current: 0, files: [] },
          integration: { expected: 20, current: 0, files: [] },
        },
      },
    });

    const manifest = makeManifest([lowSmallGap, mediumBigGap, highBigGap]);
    vi.mocked(readManifest).mockResolvedValue(manifest);

    const callOrder: string[] = [];
    const provider: AIProvider = {
      name: "order-tracker",
      generate: vi.fn().mockImplementation((_msgs, opts) => {
        // Extract module path from the system prompt content
        const systemContent = _msgs[0]?.content ?? "";
        if (systemContent.includes("src/services/")) callOrder.push("src/services");
        else if (systemContent.includes("src/controllers/")) callOrder.push("src/controllers");
        else if (systemContent.includes("src/utils/")) callOrder.push("src/utils");
        return Promise.resolve(aiResponse(1, 1, 0));
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
    };

    await cover({ projectRoot: "/tmp/project", aiProvider: provider });

    // high complexity first, then medium, then low
    expect(callOrder).toEqual(["src/services", "src/controllers", "src/utils"]);
  });

  it("filters modules when the modules option is provided", async () => {
    const mod1 = makeModule({
      path: "src/services",
      complexity: "high",
      functionality: { tests: { unit: { expected: 12, current: 3, files: [] } } },
    });
    const mod2 = makeModule({
      path: "src/utils",
      complexity: "low",
      functionality: { tests: { unit: { expected: 3, current: 0, files: [] } } },
    });

    const manifest = makeManifest([mod1, mod2]);
    vi.mocked(readManifest).mockResolvedValue(manifest);

    const provider = makeProvider([aiResponse(2, 2, 0)]);

    const result = await cover({
      projectRoot: "/tmp/project",
      aiProvider: provider,
      modules: ["src/utils"],
    });

    // Only src/utils should be processed (mod1 filtered out)
    expect(result.modulesProcessed).toBe(1);
    expect(provider.generate).toHaveBeenCalledOnce();
  });

  it("skips modules that have no gaps (expected == current)", async () => {
    const fullyTested = makeModule({
      path: "src/complete",
      complexity: "medium",
      functionality: {
        tests: {
          unit: { expected: 6, current: 6, files: ["a.test.ts"] },
          integration: { expected: 10, current: 10, files: ["b.test.ts"] },
        },
      },
    });
    const hasGaps = makeModule({
      path: "src/incomplete",
      complexity: "medium",
      functionality: {
        tests: {
          unit: { expected: 6, current: 2, files: [] },
        },
      },
    });

    const manifest = makeManifest([fullyTested, hasGaps]);
    vi.mocked(readManifest).mockResolvedValue(manifest);

    const provider = makeProvider([aiResponse(3, 3, 0)]);
    const result = await cover({ projectRoot: "/tmp/project", aiProvider: provider });

    // Only hasGaps processed
    expect(result.modulesProcessed).toBe(1);
    expect(provider.generate).toHaveBeenCalledOnce();
  });

  it("updates module test counts from scanner results after AI generation", async () => {
    const mod = makeModule({
      path: "src/services",
      complexity: "medium",
      functionality: {
        tests: {
          unit: { expected: 6, current: 2, files: [] },
        },
      },
    });

    const manifest = makeManifest([mod]);
    vi.mocked(readManifest).mockResolvedValue(manifest);

    // Scanner finds updated test counts
    vi.mocked(scanTests).mockResolvedValue({
      totalTestFiles: 3,
      totalTestCount: 15,
      byModule: new Map([
        ["src/services", {
          tests: {
            unit: { current: 6, files: ["unit1.test.ts", "unit2.test.ts"] },
            integration: { current: 4, files: ["int1.test.ts"] },
          },
        }],
      ]),
    });

    const provider = makeProvider([aiResponse(4, 4, 0)]);
    await cover({ projectRoot: "/tmp/project", aiProvider: provider });

    // Verify rescoreManifest was called with updated module data
    const rescoredManifest = vi.mocked(rescoreManifest).mock.calls[0]![0];
    const updatedMod = rescoredManifest.modules[0]!;

    // unit was updated from scanner
    expect(updatedMod.functionality.tests.unit!.current).toBe(6);
    expect(updatedMod.functionality.tests.unit!.files).toEqual(["unit1.test.ts", "unit2.test.ts"]);

    // integration was added from scanner (didn't exist before in this module entry)
    expect(updatedMod.functionality.tests.integration!.current).toBe(4);
  });

  it("tracks scoreBefore and scoreAfter correctly", async () => {
    const mod = makeModule({
      path: "src/services",
      functionality: {
        tests: {
          unit: { expected: 6, current: 1, files: [] },
        },
      },
    });

    const manifest = makeManifest([mod], {
      score: {
        overall: 25,
        breakdown: { functionality: 25, security: 0, stability: 0, conformance: 0, regression: 0 },
        gaps: { total: 5, critical: 0, byDimension: { functionality: { missing: 5, priority: "high" }, security: { issues: 0, priority: "none" }, stability: { gaps: 0, priority: "none" }, conformance: { violations: 0, priority: "none" } } },
        history: [],
        scanned: {},
      },
    });
    vi.mocked(readManifest).mockResolvedValue(manifest);

    // rescoreManifest bumps score to 60
    vi.mocked(rescoreManifest).mockImplementation((m) => ({
      ...m,
      score: { ...m.score, overall: 60 },
    }));

    const provider = makeProvider([aiResponse(5, 5, 0)]);
    const result = await cover({ projectRoot: "/tmp/project", aiProvider: provider });

    expect(result.scoreBefore).toBe(25);
    expect(result.scoreAfter).toBe(60);
  });

  it("continues processing remaining modules when one module's AI call fails", async () => {
    const mod1 = makeModule({
      path: "src/services",
      complexity: "high",
      functionality: { tests: { unit: { expected: 12, current: 3, files: [] } } },
    });
    const mod2 = makeModule({
      path: "src/utils",
      complexity: "low",
      functionality: { tests: { unit: { expected: 3, current: 0, files: [] } } },
    });

    const manifest = makeManifest([mod1, mod2]);
    vi.mocked(readManifest).mockResolvedValue(manifest);

    const provider: AIProvider = {
      name: "flaky-provider",
      generate: vi.fn()
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValueOnce(aiResponse(2, 2, 0)),
      isAvailable: vi.fn().mockResolvedValue(true),
    };

    const result = await cover({ projectRoot: "/tmp/project", aiProvider: provider });

    // Both modules processed (one errored, one succeeded)
    expect(result.modulesProcessed).toBe(2);
    expect(result.testsGenerated).toBe(2);
    expect(result.testsPassed).toBe(2);
    expect(result.testsFailed).toBe(0);
  });

  it("handles modules with gaps in multiple test types", async () => {
    const mod = makeModule({
      path: "src/booking",
      complexity: "high",
      functionality: {
        tests: {
          unit: { expected: 12, current: 5, files: [] },
          integration: { expected: 20, current: 8, files: [] },
          api: { expected: 8, current: 2, files: [] },
          e2e: { expected: 2, current: 0, files: [] },
          contract: { expected: 4, current: 1, files: [] },
        },
      },
    });

    const manifest = makeManifest([mod]);
    vi.mocked(readManifest).mockResolvedValue(manifest);

    const provider = makeProvider([aiResponse(10, 8, 2)]);

    const result = await cover({ projectRoot: "/tmp/project", aiProvider: provider });

    expect(result.modulesProcessed).toBe(1);
    expect(result.testsGenerated).toBe(10);
    expect(result.testsFailed).toBe(2);

    // The total gap for this module should be 7+12+6+2+3 = 30
    // Verify the prompt was built with correct gap data
    expect(provider.generate).toHaveBeenCalledOnce();
  });

  it("handles modules where current exceeds expected (over-tested, no gap)", async () => {
    const overTested = makeModule({
      path: "src/over-tested",
      functionality: {
        tests: {
          unit: { expected: 3, current: 10, files: ["a.test.ts", "b.test.ts"] },
        },
      },
    });
    const underTested = makeModule({
      path: "src/under-tested",
      functionality: {
        tests: {
          unit: { expected: 6, current: 2, files: [] },
        },
      },
    });

    const manifest = makeManifest([overTested, underTested]);
    vi.mocked(readManifest).mockResolvedValue(manifest);

    const provider = makeProvider([aiResponse(3, 3, 0)]);
    const result = await cover({ projectRoot: "/tmp/project", aiProvider: provider });

    // Only under-tested module should be processed
    expect(result.modulesProcessed).toBe(1);
  });

  it("saves progress incrementally after each module completes", async () => {
    const mod1 = makeModule({
      path: "src/services",
      complexity: "high",
      functionality: { tests: { unit: { expected: 12, current: 3, files: [] } } },
    });
    const mod2 = makeModule({
      path: "src/utils",
      complexity: "low",
      functionality: { tests: { unit: { expected: 3, current: 0, files: [] } } },
    });

    const manifest = makeManifest([mod1, mod2]);
    vi.mocked(readManifest).mockResolvedValue(manifest);

    const provider = makeProvider([
      aiResponse(5, 4, 1),
      aiResponse(2, 2, 0),
    ]);

    await cover({ projectRoot: "/tmp/project", aiProvider: provider });

    // readManifest called only once at start (no re-read — uses live manifest)
    expect(readManifest).toHaveBeenCalledOnce();

    // writeManifest called after each module + final consistency save = 3 times
    expect(writeManifest).toHaveBeenCalledTimes(3);
  });

  it("handles the case where scanner returns a new test type not in the original module", async () => {
    const mod = makeModule({
      path: "src/services",
      functionality: {
        tests: {
          unit: { expected: 6, current: 2, files: [] },
        },
      },
    });

    const manifest = makeManifest([mod]);
    vi.mocked(readManifest).mockResolvedValue(manifest);

    // Scanner discovers integration tests that weren't tracked before
    vi.mocked(scanTests).mockResolvedValue({
      totalTestFiles: 2,
      totalTestCount: 8,
      byModule: new Map([
        ["src/services", {
          tests: {
            unit: { current: 5, files: ["u.test.ts"] },
            integration: { current: 3, files: ["i.test.ts"] },
          },
        }],
      ]),
    });

    const provider = makeProvider([aiResponse(3, 3, 0)]);
    await cover({ projectRoot: "/tmp/project", aiProvider: provider });

    const rescoredManifest = vi.mocked(rescoreManifest).mock.calls[0]![0];
    const updatedMod = rescoredManifest.modules[0]!;

    // New integration test type should be added with expected=0 (since it wasn't in original)
    expect(updatedMod.functionality.tests.integration).toBeDefined();
    expect(updatedMod.functionality.tests.integration!.current).toBe(3);
    expect(updatedMod.functionality.tests.integration!.expected).toBe(0);
  });
});
