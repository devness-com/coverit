/**
 * Unit tests for scoring/engine.ts
 * Tests calculateScore, calculateDimensionScore, calculateFunctionalityScore,
 * calculateSecurityScore, and gap summary building with mocked weight helpers.
 */
import { describe, it, expect, vi } from "vitest";

// Mock weights module to control weight values in isolation
vi.mock("../weights.js", async () => {
  const actual = await vi.importActual<typeof import("../weights.js")>("../weights.js");
  return {
    ...actual,
    // Keep real implementations — we test engine logic, not weight values
    getComplexityWeight: actual.getComplexityWeight,
    getTestTypeWeight: actual.getTestTypeWeight,
    findingSeverityPoints: actual.findingSeverityPoints,
    isCriticalFinding: actual.isCriticalFinding,
    resolveDimensionWeights: actual.resolveDimensionWeights,
  };
});

import {
  calculateScore,
  calculateDimensionScore,
  calculateFunctionalityScore,
  calculateSecurityScore,
} from "../engine.js";
import type {
  CoveritManifest,
  ModuleEntry,
  FunctionalityConfig,
  DimensionScores,
} from "../../schema/coverit-manifest.js";
import { DEFAULT_DIMENSIONS, DEFAULT_FUNCTIONALITY } from "../../schema/defaults.js";

// --- Fixtures ---

function makeModule(overrides: Partial<ModuleEntry> & { path: string }): ModuleEntry {
  return {
    files: 5,
    lines: 500,
    complexity: "medium",
    functionality: {
      tests: {},
    },
    security: { issues: 0, resolved: 0, findings: [] },
    stability: { score: 100, gaps: [] },
    conformance: { score: 100, violations: [] },
    ...overrides,
  };
}

function createManifest(
  modules: ModuleEntry[],
  scanned?: Partial<Record<string, string>>,
): CoveritManifest {
  return {
    version: 1,
    createdAt: "2024-01-01",
    updatedAt: "2024-01-01",
    project: {
      name: "test-project",
      root: "/tmp/test",
      language: "typescript",
      framework: "nestjs",
      testFramework: "vitest",
      sourceFiles: 10,
      sourceLines: 1000,
    },
    dimensions: DEFAULT_DIMENSIONS,
    modules,
    journeys: [],
    contracts: [],
    score: {
      overall: 0,
      breakdown: {
        functionality: 0,
        security: 0,
        stability: 0,
        conformance: 0,
        regression: 0,
      },
      gaps: {
        total: 0,
        critical: 0,
        byDimension: {
          functionality: { missing: 0, priority: "low" },
          security: { issues: 0, priority: "low" },
          stability: { gaps: 0, priority: "low" },
          conformance: { violations: 0, priority: "low" },
        },
      },
      history: [],
      scanned,
    },
  };
}

// --- calculateFunctionalityScore ---

describe("calculateFunctionalityScore", () => {
  const config = DEFAULT_FUNCTIONALITY;

  it("returns 0 for empty modules array", () => {
    expect(calculateFunctionalityScore([], config)).toBe(0);
  });

  it("returns 100 when all tests meet expected counts", () => {
    const modules = [
      makeModule({
        path: "src/a",
        functionality: {
          tests: {
            unit: { expected: 6, current: 6, files: ["a.test.ts"] },
            integration: { expected: 10, current: 10, files: ["a.int.test.ts"] },
          },
        },
      }),
    ];
    const score = calculateFunctionalityScore(modules, config);
    expect(score).toBe(100);
  });

  it("returns partial score when tests are below expected", () => {
    const modules = [
      makeModule({
        path: "src/a",
        functionality: {
          tests: {
            unit: { expected: 10, current: 5, files: ["a.test.ts"] },
            integration: { expected: 10, current: 5, files: ["a.int.test.ts"] },
          },
        },
      }),
    ];
    const score = calculateFunctionalityScore(modules, config);
    expect(score).toBe(50); // 50% coverage across all types
  });

  it("caps individual test type ratio at 1.0 (excess tests don't inflate score)", () => {
    const modules = [
      makeModule({
        path: "src/a",
        functionality: {
          tests: {
            unit: { expected: 5, current: 20, files: ["a.test.ts"] },
            integration: { expected: 5, current: 20, files: ["a.int.test.ts"] },
          },
        },
      }),
    ];
    const score = calculateFunctionalityScore(modules, config);
    expect(score).toBe(100); // Capped at 100, not inflated
  });

  it("gives current > 0 with expected = 0 a ratio of 1.0", () => {
    const modules = [
      makeModule({
        path: "src/a",
        functionality: {
          tests: {
            unit: { expected: 0, current: 3, files: ["a.test.ts"] },
          },
        },
      }),
    ];
    const score = calculateFunctionalityScore(modules, config);
    expect(score).toBe(100); // 1.0 ratio for unexpected tests
  });

  it("weights high-complexity modules more heavily", () => {
    const moduleLow = makeModule({
      path: "src/low",
      complexity: "low",
      functionality: {
        tests: {
          unit: { expected: 10, current: 10, files: ["low.test.ts"] },
        },
      },
    });
    const moduleHigh = makeModule({
      path: "src/high",
      complexity: "high",
      functionality: {
        tests: {
          unit: { expected: 10, current: 0, files: [] },
        },
      },
    });

    const score = calculateFunctionalityScore([moduleLow, moduleHigh], config);
    // low (weight 1): 100% * 1 = 1
    // high (weight 3): 0% * 3 = 0
    // average: 1/4 * 100 = 25
    expect(score).toBe(25);
  });

  it("returns 0 when module has empty tests object", () => {
    const modules = [makeModule({ path: "src/a", functionality: { tests: {} } })];
    const score = calculateFunctionalityScore(modules, config);
    expect(score).toBe(0);
  });
});

// --- calculateSecurityScore ---

describe("calculateSecurityScore", () => {
  it("returns 100 when no findings exist", () => {
    const modules = [makeModule({ path: "src/a" })];
    expect(calculateSecurityScore(modules)).toBe(100);
  });

  it("deducts points based on finding severity", () => {
    const modules = [
      makeModule({
        path: "src/a",
        security: {
          issues: 1,
          resolved: 0,
          findings: ["data-exposure:api.ts:30"], // medium = 8 points
        },
      }),
    ];
    expect(calculateSecurityScore(modules)).toBe(92);
  });

  it("caps at 25 when critical findings exist", () => {
    const modules = [
      makeModule({
        path: "src/a",
        security: {
          issues: 1,
          resolved: 0,
          findings: ["injection:auth.ts:42"], // critical = 25 points
        },
      }),
    ];
    // 100 - 25 = 75, but capped at 25 because of critical finding
    expect(calculateSecurityScore(modules)).toBe(25);
  });

  it("never goes below 0", () => {
    const modules = [
      makeModule({
        path: "src/a",
        security: {
          issues: 10,
          resolved: 0,
          findings: [
            "injection:a.ts:1",
            "auth-bypass:b.ts:2",
            "injection:c.ts:3",
            "auth-bypass:d.ts:4",
            "injection:e.ts:5",
          ],
        },
      }),
    ];
    const score = calculateSecurityScore(modules);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("accumulates findings across multiple modules", () => {
    const modules = [
      makeModule({
        path: "src/a",
        security: {
          issues: 1,
          resolved: 0,
          findings: ["data-exposure:a.ts:1"], // 8 points
        },
      }),
      makeModule({
        path: "src/b",
        security: {
          issues: 1,
          resolved: 0,
          findings: ["insecure-config:b.ts:1"], // 8 points
        },
      }),
    ];
    expect(calculateSecurityScore(modules)).toBe(84); // 100 - 8 - 8
  });
});

// --- calculateDimensionScore ---

describe("calculateDimensionScore", () => {
  it("calculates functionality dimension correctly", () => {
    const manifest = createManifest([
      makeModule({
        path: "src/a",
        functionality: {
          tests: {
            unit: { expected: 10, current: 10, files: ["a.test.ts"] },
          },
        },
      }),
    ]);
    const score = calculateDimensionScore("functionality", manifest);
    expect(score).toBe(100);
  });

  it("calculates security dimension correctly", () => {
    const manifest = createManifest([
      makeModule({
        path: "src/a",
        security: { issues: 0, resolved: 0, findings: [] },
      }),
    ]);
    expect(calculateDimensionScore("security", manifest)).toBe(100);
  });

  it("calculates stability dimension from module scores", () => {
    const manifest = createManifest([
      makeModule({ path: "src/a", stability: { score: 80, gaps: [] } }),
    ]);
    expect(calculateDimensionScore("stability", manifest)).toBe(80);
  });

  it("calculates conformance dimension from module scores", () => {
    const manifest = createManifest([
      makeModule({ path: "src/a", conformance: { score: 75, violations: [] } }),
    ]);
    expect(calculateDimensionScore("conformance", manifest)).toBe(75);
  });

  it("calculates regression as 100 when no tests exist", () => {
    const manifest = createManifest([
      makeModule({
        path: "src/a",
        functionality: { tests: {} },
      }),
    ]);
    expect(calculateDimensionScore("regression", manifest)).toBe(100);
  });

  it("calculates regression based on passing/total test ratio", () => {
    const manifest = createManifest([
      makeModule({
        path: "src/a",
        functionality: {
          tests: {
            unit: { expected: 10, current: 7, files: ["a.test.ts"] },
          },
        },
      }),
    ]);
    expect(calculateDimensionScore("regression", manifest)).toBe(70);
  });
});

// --- calculateScore (full pipeline) ---

describe("calculateScore", () => {
  it("returns functionality raw score when no dimensions are scanned", () => {
    const manifest = createManifest(
      [
        makeModule({
          path: "src/a",
          functionality: {
            tests: {
              unit: { expected: 10, current: 5, files: ["a.test.ts"] },
            },
          },
        }),
      ],
      // No scanned dimensions
    );
    const result = calculateScore(manifest);
    expect(result.overall).toBe(50);
  });

  it("uses weighted average of scanned dimensions only", () => {
    const manifest = createManifest(
      [
        makeModule({
          path: "src/a",
          functionality: {
            tests: {
              unit: { expected: 10, current: 10, files: ["a.test.ts"] },
            },
          },
          security: { issues: 0, resolved: 0, findings: [] },
          stability: { score: 100, gaps: [] },
        }),
      ],
      // Only functionality and security scanned
      { functionality: "2024-01-01", security: "2024-01-01" },
    );
    const result = calculateScore(manifest);

    // Only functionality (weight 0.35) and security (weight 0.25) are active
    // Both score 100, so weighted avg = 100
    expect(result.overall).toBe(100);
  });

  it("returns breakdown with all five dimension scores", () => {
    const manifest = createManifest([
      makeModule({
        path: "src/a",
        functionality: {
          tests: { unit: { expected: 10, current: 5, files: ["a.test.ts"] } },
        },
      }),
    ]);
    const result = calculateScore(manifest);

    expect(result.breakdown).toHaveProperty("functionality");
    expect(result.breakdown).toHaveProperty("security");
    expect(result.breakdown).toHaveProperty("stability");
    expect(result.breakdown).toHaveProperty("conformance");
    expect(result.breakdown).toHaveProperty("regression");
  });

  it("builds gap summary with correct missing test counts", () => {
    const manifest = createManifest([
      makeModule({
        path: "src/a",
        functionality: {
          tests: {
            unit: { expected: 10, current: 6, files: ["a.test.ts"] },
            integration: { expected: 5, current: 3, files: ["a.int.test.ts"] },
          },
        },
        security: {
          issues: 2,
          resolved: 0,
          findings: ["xss:a.ts:1", "data-exposure:b.ts:2"],
        },
        stability: { score: 80, gaps: ["no error handling in processRefund"] },
        conformance: { score: 70, violations: ["layer-violation: imports from controller"] },
      }),
    ]);
    const result = calculateScore(manifest);

    expect(result.gaps.byDimension.functionality.missing).toBe(6); // (10-6) + (5-3)
    expect(result.gaps.byDimension.security.issues).toBe(2);
    expect(result.gaps.byDimension.stability.gaps).toBe(1);
    expect(result.gaps.byDimension.conformance.violations).toBe(1);
    expect(result.gaps.total).toBe(10); // 6 + 2 + 1 + 1
  });

  it("preserves existing score history", () => {
    const manifest = createManifest([makeModule({ path: "src/a" })]);
    manifest.score.history = [
      { date: "2024-01-01", score: 50, scope: "full" },
    ];
    const result = calculateScore(manifest);
    expect(result.history).toHaveLength(1);
    expect(result.history[0]!.scope).toBe("full");
  });

  it("preserves scanned map in result", () => {
    const manifest = createManifest(
      [makeModule({ path: "src/a" })],
      { functionality: "2024-01-01" },
    );
    const result = calculateScore(manifest);
    expect(result.scanned).toEqual({ functionality: "2024-01-01" });
  });

  it("counts critical gaps for dimensions scoring below 25", () => {
    const manifest = createManifest([
      makeModule({
        path: "src/a",
        complexity: "medium",
        functionality: {
          tests: {
            unit: { expected: 10, current: 0, files: [] },
          },
        },
        security: {
          issues: 3,
          resolved: 0,
          findings: [
            "injection:a.ts:1",
            "auth-bypass:b.ts:2",
            "xss:c.ts:3",
          ],
        },
      }),
    ]);
    const result = calculateScore(manifest);

    // Functionality score is 0 (< 25) → 10 critical gaps
    // Security score is capped at 25 due to critical finding, but might still be low
    expect(result.gaps.critical).toBeGreaterThan(0);
  });
});
