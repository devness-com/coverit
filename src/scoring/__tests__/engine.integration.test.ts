/**
 * Integration tests for scoring/engine.ts
 * Tests the full scoring pipeline with real weights, thresholds, and
 * multi-module manifests — no mocks.
 */
import { describe, it, expect } from "vitest";

import { calculateScore, calculateDimensionScore, calculateFunctionalityScore, calculateSecurityScore } from "../engine.js";
import { getGapPriority, evaluateGate, assessDimensions, interpretScore } from "../thresholds.js";
import { getComplexityWeight, resolveDimensionWeights, normalizeDimensionWeights } from "../weights.js";
import type { CoveritManifest, ModuleEntry, DimensionScores } from "../../schema/coverit-manifest.js";
import { DEFAULT_DIMENSIONS, DEFAULT_FUNCTIONALITY } from "../../schema/defaults.js";

// --- Helpers ---

function makeModule(overrides: Partial<ModuleEntry> & { path: string }): ModuleEntry {
  return {
    files: 5,
    lines: 500,
    complexity: "medium",
    functionality: { tests: {} },
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
      sourceFiles: 20,
      sourceLines: 3000,
    },
    dimensions: DEFAULT_DIMENSIONS,
    modules,
    journeys: [],
    contracts: [],
    score: {
      overall: 0,
      breakdown: { functionality: 0, security: 0, stability: 0, conformance: 0, regression: 0 },
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

// --- End-to-End Scoring Pipeline ---

describe("scoring pipeline end-to-end", () => {
  it("scores a perfect project at 100 across all dimensions", () => {
    const manifest = createManifest(
      [
        makeModule({
          path: "src/services",
          complexity: "high",
          functionality: {
            tests: {
              unit: { expected: 12, current: 12, files: ["svc.test.ts"] },
              integration: { expected: 20, current: 20, files: ["svc.int.test.ts"] },
              api: { expected: 8, current: 8, files: ["svc.api.test.ts"] },
            },
          },
          security: { issues: 0, resolved: 0, findings: [] },
          stability: { score: 100, gaps: [] },
          conformance: { score: 100, violations: [] },
        }),
        makeModule({
          path: "src/utils",
          complexity: "low",
          functionality: {
            tests: {
              unit: { expected: 3, current: 3, files: ["util.test.ts"] },
            },
          },
        }),
      ],
      {
        functionality: "2024-01-01",
        security: "2024-01-01",
        stability: "2024-01-01",
        conformance: "2024-01-01",
        regression: "2024-01-01",
      },
    );

    const result = calculateScore(manifest);

    expect(result.overall).toBe(100);
    expect(result.breakdown.functionality).toBe(100);
    expect(result.breakdown.security).toBe(100);
    expect(result.breakdown.stability).toBe(100);
    expect(result.breakdown.conformance).toBe(100);
    expect(result.breakdown.regression).toBe(100);
    expect(result.gaps.total).toBe(0);
    expect(result.gaps.critical).toBe(0);
  });

  it("scores a project with mixed quality across modules and dimensions", () => {
    const manifest = createManifest(
      [
        makeModule({
          path: "src/services",
          complexity: "high",
          functionality: {
            tests: {
              unit: { expected: 12, current: 6, files: ["svc.test.ts"] },
              integration: { expected: 20, current: 10, files: ["svc.int.test.ts"] },
            },
          },
          security: {
            issues: 2,
            resolved: 0,
            findings: ["xss:handler.ts:10", "data-exposure:api.ts:20"],
          },
          stability: { score: 60, gaps: ["no error handling in processPayment"] },
          conformance: { score: 50, violations: ["layer-violation: direct DB access"] },
        }),
        makeModule({
          path: "src/utils",
          complexity: "low",
          functionality: {
            tests: {
              unit: { expected: 3, current: 3, files: ["util.test.ts"] },
            },
          },
          stability: { score: 90, gaps: [] },
          conformance: { score: 95, violations: [] },
        }),
      ],
      {
        functionality: "2024-01-01",
        security: "2024-01-01",
        stability: "2024-01-01",
        conformance: "2024-01-01",
        regression: "2024-01-01",
      },
    );

    const result = calculateScore(manifest);

    // Overall should be between 0 and 100
    expect(result.overall).toBeGreaterThan(0);
    expect(result.overall).toBeLessThan(100);

    // Functionality should be partial (some tests missing)
    expect(result.breakdown.functionality).toBeGreaterThan(0);
    expect(result.breakdown.functionality).toBeLessThan(100);

    // Security should be penalized but not capped (no critical findings)
    expect(result.breakdown.security).toBeLessThan(100);
    expect(result.breakdown.security).toBeGreaterThan(25);

    // Stability weighted by complexity: high(60)*3 + low(90)*1 = 270/4 = 67.5
    expect(result.breakdown.stability).toBeCloseTo(67.5, 0);

    // Gaps should have missing tests
    expect(result.gaps.byDimension.functionality.missing).toBe(16); // (12-6) + (20-10)
    expect(result.gaps.byDimension.security.issues).toBe(2);
    expect(result.gaps.byDimension.stability.gaps).toBe(1);
    expect(result.gaps.byDimension.conformance.violations).toBe(1);
  });

  it("handles critical security findings capping score at 25", () => {
    const manifest = createManifest(
      [
        makeModule({
          path: "src/auth",
          complexity: "high",
          security: {
            issues: 1,
            resolved: 0,
            findings: ["injection:login.ts:42"],
          },
        }),
      ],
      { security: "2024-01-01" },
    );

    const result = calculateScore(manifest);
    expect(result.breakdown.security).toBeLessThanOrEqual(25);
  });
});

// --- Multi-module Complexity Weighting ---

describe("complexity weighting across modules", () => {
  it("high-complexity modules dominate the aggregate score", () => {
    const config = DEFAULT_FUNCTIONALITY;

    // High-complexity module at 0%, low-complexity at 100%
    const scoreA = calculateFunctionalityScore(
      [
        makeModule({
          path: "src/critical",
          complexity: "high",
          functionality: { tests: { unit: { expected: 10, current: 0, files: [] } } },
        }),
        makeModule({
          path: "src/simple",
          complexity: "low",
          functionality: { tests: { unit: { expected: 5, current: 5, files: ["s.test.ts"] } } },
        }),
      ],
      config,
    );

    // High-complexity at 100%, low-complexity at 0%
    const scoreB = calculateFunctionalityScore(
      [
        makeModule({
          path: "src/critical",
          complexity: "high",
          functionality: { tests: { unit: { expected: 10, current: 10, files: ["c.test.ts"] } } },
        }),
        makeModule({
          path: "src/simple",
          complexity: "low",
          functionality: { tests: { unit: { expected: 5, current: 0, files: [] } } },
        }),
      ],
      config,
    );

    // Score B should be higher because the high-complexity module is covered
    expect(scoreB).toBeGreaterThan(scoreA);
  });

  it("equal complexity modules contribute equally", () => {
    const config = DEFAULT_FUNCTIONALITY;

    const score = calculateFunctionalityScore(
      [
        makeModule({
          path: "src/a",
          complexity: "medium",
          functionality: { tests: { unit: { expected: 10, current: 10, files: ["a.test.ts"] } } },
        }),
        makeModule({
          path: "src/b",
          complexity: "medium",
          functionality: { tests: { unit: { expected: 10, current: 0, files: [] } } },
        }),
      ],
      config,
    );

    // Each module has weight 2, so average = (100 + 0) / 2 = 50
    expect(score).toBe(50);
  });
});

// --- Security Scoring Integration ---

describe("security scoring with real severity mapping", () => {
  it("deducts correct points for mixed severity findings", () => {
    const modules = [
      makeModule({
        path: "src/a",
        security: {
          issues: 4,
          resolved: 0,
          findings: [
            "injection:auth.ts:10",        // critical: 25
            "secrets-exposure:config.ts:5", // high: 15
            "data-exposure:api.ts:20",      // medium: 8
            "dependency-vulns:pkg.json:1",  // low: 3
          ],
        },
      }),
    ];

    const score = calculateSecurityScore(modules);
    // 100 - 25 - 15 - 8 - 3 = 49, but capped at 25 due to critical
    expect(score).toBe(25);
  });

  it("handles multiple modules with findings summed together", () => {
    const modules = [
      makeModule({
        path: "src/a",
        security: {
          issues: 1,
          resolved: 0,
          findings: ["dependency-vulns:a.json:1"], // 3 points
        },
      }),
      makeModule({
        path: "src/b",
        security: {
          issues: 1,
          resolved: 0,
          findings: ["dependency-vulns:b.json:1"], // 3 points
        },
      }),
    ];

    const score = calculateSecurityScore(modules);
    expect(score).toBe(94); // 100 - 3 - 3
  });
});

// --- Dimension Weight Resolution Integration ---

describe("dimension weight resolution with real defaults", () => {
  it("default weights sum to approximately 1.0", () => {
    const weights = resolveDimensionWeights(DEFAULT_DIMENSIONS);
    const sum =
      weights.functionality + weights.security + weights.stability +
      weights.conformance + weights.regression;
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it("normalization preserves ratio between non-zero weights", () => {
    const weights = resolveDimensionWeights(DEFAULT_DIMENSIONS);
    const normalized = normalizeDimensionWeights(weights);

    // Ratio functionality/security should be preserved
    const origRatio = weights.functionality / weights.security;
    const normRatio = normalized.functionality / normalized.security;
    expect(normRatio).toBeCloseTo(origRatio, 5);
  });
});

// --- Gap Priority Integration ---

describe("gap priority classification in scored results", () => {
  it("assigns correct priorities to dimension gaps based on scores", () => {
    const manifest = createManifest(
      [
        makeModule({
          path: "src/a",
          functionality: {
            tests: { unit: { expected: 10, current: 1, files: ["a.test.ts"] } },
          },
          security: {
            issues: 5,
            resolved: 0,
            findings: [
              "injection:a.ts:1",
              "injection:b.ts:2",
              "injection:c.ts:3",
              "injection:d.ts:4",
              "injection:e.ts:5",
            ],
          },
          stability: { score: 55, gaps: ["gap1"] },
          conformance: { score: 35, violations: ["v1"] },
        }),
      ],
      {
        functionality: "2024-01-01",
        security: "2024-01-01",
        stability: "2024-01-01",
        conformance: "2024-01-01",
        regression: "2024-01-01",
      },
    );

    const result = calculateScore(manifest);

    // Functionality score: ~10% → critical priority
    expect(result.gaps.byDimension.functionality.priority).toBe("critical");

    // Security score: capped at 25 or 0 due to many critical findings → critical/high
    const secPriority = result.gaps.byDimension.security.priority;
    expect(["critical", "high"]).toContain(secPriority);

    // Stability: 55 → medium priority
    expect(result.gaps.byDimension.stability.priority).toBe("medium");

    // Conformance: 35 → high priority
    expect(result.gaps.byDimension.conformance.priority).toBe("high");
  });
});

// --- Quality Gate Integration ---

describe("quality gate evaluation with real scoring", () => {
  it("a perfect project passes the default gate", () => {
    const scores: DimensionScores = {
      functionality: 100,
      security: 100,
      stability: 100,
      conformance: 100,
      regression: 100,
    };
    const gate = evaluateGate(100, scores);
    expect(gate.passed).toBe(true);
    expect(gate.failedDimensions).toHaveLength(0);
  });

  it("a project with one at-risk dimension fails the gate", () => {
    const scores: DimensionScores = {
      functionality: 90,
      security: 25, // at-risk (< 50)
      stability: 80,
      conformance: 70,
      regression: 100,
    };
    const gate = evaluateGate(80, scores);
    expect(gate.passed).toBe(false);
    expect(gate.failedDimensions.some((d) => d.dimension === "security")).toBe(true);
  });

  it("dimension health assessment integrates with scoring interpretation", () => {
    const scores: DimensionScores = {
      functionality: 85,
      security: 45,
      stability: 65,
      conformance: 20,
      regression: 100,
    };
    const health = assessDimensions(scores);

    // Should be sorted worst-first
    expect(health[0]!.dimension).toBe("conformance");
    expect(health[0]!.health).toBe("at-risk");

    // Interpret the worst score
    const interp = interpretScore(health[0]!.score);
    expect(interp.color).toBe("red");
    expect(interp.label).toBe("At Risk");

    // Interpret the best score
    const bestInterp = interpretScore(health[health.length - 1]!.score);
    expect(bestInterp.color).toBe("green");
    expect(bestInterp.health).toBe("healthy");
  });
});

// --- Scanned Dimension Redistribution ---

describe("scanned dimension weight redistribution", () => {
  it("only scanned dimensions contribute to overall score", () => {
    const manifest = createManifest(
      [
        makeModule({
          path: "src/a",
          functionality: {
            tests: { unit: { expected: 10, current: 10, files: ["a.test.ts"] } },
          },
          security: {
            issues: 5,
            resolved: 0,
            findings: [
              "injection:a.ts:1",
              "injection:b.ts:2",
              "injection:c.ts:3",
              "injection:d.ts:4",
              "injection:e.ts:5",
            ],
          },
        }),
      ],
      // Only functionality scanned — terrible security won't matter
      { functionality: "2024-01-01" },
    );

    const result = calculateScore(manifest);
    // Only functionality is scanned (score 100), so overall = 100
    expect(result.overall).toBe(100);
  });

  it("adding more scanned dimensions changes the overall score", () => {
    const modules = [
      makeModule({
        path: "src/a",
        functionality: {
          tests: { unit: { expected: 10, current: 10, files: ["a.test.ts"] } },
        },
        stability: { score: 50, gaps: ["gap1"] },
      }),
    ];

    const manifestFuncOnly = createManifest(modules, { functionality: "2024-01-01" });
    const resultFuncOnly = calculateScore(manifestFuncOnly);

    const manifestBoth = createManifest(modules, {
      functionality: "2024-01-01",
      stability: "2024-01-01",
    });
    const resultBoth = calculateScore(manifestBoth);

    // With only functionality (100), overall = 100
    // With functionality (100) + stability (50), overall < 100
    expect(resultFuncOnly.overall).toBe(100);
    expect(resultBoth.overall).toBeLessThan(100);
  });
});

// --- Regression Score Integration ---

describe("regression scoring with real module data", () => {
  it("returns 100 when all tests pass (current meets expected)", () => {
    const manifest = createManifest([
      makeModule({
        path: "src/a",
        functionality: {
          tests: {
            unit: { expected: 10, current: 10, files: ["a.test.ts"] },
            integration: { expected: 5, current: 5, files: ["a.int.test.ts"] },
          },
        },
      }),
    ]);
    expect(calculateDimensionScore("regression", manifest)).toBe(100);
  });

  it("returns proportional score when some tests are missing", () => {
    const manifest = createManifest([
      makeModule({
        path: "src/a",
        functionality: {
          tests: {
            unit: { expected: 20, current: 10, files: ["a.test.ts"] },
          },
        },
      }),
    ]);
    expect(calculateDimensionScore("regression", manifest)).toBe(50);
  });

  it("caps regression at 100 even if current exceeds expected", () => {
    const manifest = createManifest([
      makeModule({
        path: "src/a",
        functionality: {
          tests: {
            unit: { expected: 5, current: 15, files: ["a.test.ts"] },
          },
        },
      }),
    ]);
    expect(calculateDimensionScore("regression", manifest)).toBe(100);
  });
});
