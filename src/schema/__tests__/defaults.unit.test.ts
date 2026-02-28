/**
 * Unit tests for schema/defaults.ts
 * Tests default dimension configs, expected test counts, scope depths,
 * scoring constants, and the getScoreHealth function.
 */
import { describe, it, expect } from "vitest";

import {
  DEFAULT_FUNCTIONALITY,
  DEFAULT_SECURITY,
  DEFAULT_STABILITY,
  DEFAULT_CONFORMANCE,
  DEFAULT_REGRESSION,
  DEFAULT_DIMENSIONS,
  EXPECTED_TESTS_BY_COMPLEXITY,
  SCOPE_DEPTHS,
  TEST_TYPE_WEIGHTS,
  SECURITY_SEVERITY_POINTS,
  SCORE_THRESHOLDS,
  MAX_SCORE_HISTORY,
  getScoreHealth,
} from "../defaults.js";

// ─── Default Dimension Configs ───────────────────────────────

describe("DEFAULT_FUNCTIONALITY", () => {
  it("is enabled with weight 0.35 and has all five target types", () => {
    expect(DEFAULT_FUNCTIONALITY.enabled).toBe(true);
    expect(DEFAULT_FUNCTIONALITY.weight).toBe(0.35);

    const targetKeys = Object.keys(DEFAULT_FUNCTIONALITY.targets);
    expect(targetKeys).toHaveLength(5);
    expect(targetKeys).toEqual(
      expect.arrayContaining(["unit", "integration", "api", "e2e", "contract"]),
    );
  });

  it("uses diamond strategy defaults for each target", () => {
    expect(DEFAULT_FUNCTIONALITY.targets.unit.coverage).toBe("critical-paths");
    expect(DEFAULT_FUNCTIONALITY.targets.integration.coverage).toBe("all-boundaries");
    expect(DEFAULT_FUNCTIONALITY.targets.api.coverage).toBe("all-endpoints");
    expect(DEFAULT_FUNCTIONALITY.targets.e2e.coverage).toBe("critical-journeys");
    expect(DEFAULT_FUNCTIONALITY.targets.contract.coverage).toBe("all-public-apis");
  });
});

describe("DEFAULT_SECURITY", () => {
  it("is enabled with weight 0.25 and includes core OWASP checks", () => {
    expect(DEFAULT_SECURITY.enabled).toBe(true);
    expect(DEFAULT_SECURITY.weight).toBe(0.25);
    expect(DEFAULT_SECURITY.checks).toContain("injection");
    expect(DEFAULT_SECURITY.checks).toContain("auth-bypass");
    expect(DEFAULT_SECURITY.checks).toContain("secrets-exposure");
    expect(DEFAULT_SECURITY.checks).toContain("xss");
    expect(DEFAULT_SECURITY.checks.length).toBeGreaterThanOrEqual(6);
  });
});

describe("DEFAULT_STABILITY", () => {
  it("is enabled with weight 0.15 and includes core stability checks", () => {
    expect(DEFAULT_STABILITY.enabled).toBe(true);
    expect(DEFAULT_STABILITY.weight).toBe(0.15);
    expect(DEFAULT_STABILITY.checks).toContain("error-handling");
    expect(DEFAULT_STABILITY.checks).toContain("edge-cases");
    expect(DEFAULT_STABILITY.checks).toContain("resource-cleanup");
    expect(DEFAULT_STABILITY.checks).toContain("graceful-degradation");
  });
});

describe("DEFAULT_CONFORMANCE", () => {
  it("is enabled with weight 0.15 and includes pattern checks", () => {
    expect(DEFAULT_CONFORMANCE.enabled).toBe(true);
    expect(DEFAULT_CONFORMANCE.weight).toBe(0.15);
    expect(DEFAULT_CONFORMANCE.checks).toContain("pattern-compliance");
    expect(DEFAULT_CONFORMANCE.checks).toContain("layer-violations");
    expect(DEFAULT_CONFORMANCE.checks).toContain("naming-conventions");
    expect(DEFAULT_CONFORMANCE.checks).toContain("dead-code");
  });
});

describe("DEFAULT_REGRESSION", () => {
  it("is enabled with weight 0.10 and uses all-existing-tests-pass strategy", () => {
    expect(DEFAULT_REGRESSION.enabled).toBe(true);
    expect(DEFAULT_REGRESSION.weight).toBe(0.1);
    expect(DEFAULT_REGRESSION.strategy).toBe("all-existing-tests-pass");
  });
});

describe("DEFAULT_DIMENSIONS", () => {
  it("assembles all five dimension configs", () => {
    expect(DEFAULT_DIMENSIONS.functionality).toBe(DEFAULT_FUNCTIONALITY);
    expect(DEFAULT_DIMENSIONS.security).toBe(DEFAULT_SECURITY);
    expect(DEFAULT_DIMENSIONS.stability).toBe(DEFAULT_STABILITY);
    expect(DEFAULT_DIMENSIONS.conformance).toBe(DEFAULT_CONFORMANCE);
    expect(DEFAULT_DIMENSIONS.regression).toBe(DEFAULT_REGRESSION);
  });

  it("dimension weights sum to 1.0", () => {
    const totalWeight =
      DEFAULT_DIMENSIONS.functionality.weight +
      DEFAULT_DIMENSIONS.security.weight +
      DEFAULT_DIMENSIONS.stability.weight +
      DEFAULT_DIMENSIONS.conformance.weight +
      DEFAULT_DIMENSIONS.regression.weight;
    expect(totalWeight).toBeCloseTo(1.0, 5);
  });
});

// ─── Expected Tests by Complexity ────────────────────────────

describe("EXPECTED_TESTS_BY_COMPLEXITY", () => {
  it("defines counts for all three complexity levels", () => {
    expect(EXPECTED_TESTS_BY_COMPLEXITY).toHaveProperty("low");
    expect(EXPECTED_TESTS_BY_COMPLEXITY).toHaveProperty("medium");
    expect(EXPECTED_TESTS_BY_COMPLEXITY).toHaveProperty("high");
  });

  it("low complexity has modest test counts with no api/e2e/contract", () => {
    const low = EXPECTED_TESTS_BY_COMPLEXITY.low;
    expect(low.unit).toBe(3);
    expect(low.integration).toBe(5);
    expect(low.api).toBe(0);
    expect(low.e2e).toBe(0);
    expect(low.contract).toBe(0);
  });

  it("medium complexity has more tests including api and contract", () => {
    const med = EXPECTED_TESTS_BY_COMPLEXITY.medium;
    expect(med.unit).toBe(6);
    expect(med.integration).toBe(10);
    expect(med.api).toBe(4);
    expect(med.e2e).toBe(0);
    expect(med.contract).toBe(2);
  });

  it("high complexity has the most tests including e2e", () => {
    const high = EXPECTED_TESTS_BY_COMPLEXITY.high;
    expect(high.unit).toBe(12);
    expect(high.integration).toBe(20);
    expect(high.api).toBe(8);
    expect(high.e2e).toBe(2);
    expect(high.contract).toBe(4);
  });

  it("test counts increase monotonically with complexity", () => {
    const complexities = ["low", "medium", "high"] as const;
    for (const type of ["unit", "integration", "api", "e2e", "contract"] as const) {
      for (let i = 1; i < complexities.length; i++) {
        expect(EXPECTED_TESTS_BY_COMPLEXITY[complexities[i]][type]).toBeGreaterThanOrEqual(
          EXPECTED_TESTS_BY_COMPLEXITY[complexities[i - 1]][type],
        );
      }
    }
  });
});

// ─── Scope Depths ────────────────────────────────────────────

describe("SCOPE_DEPTHS", () => {
  it("defines depths for all ten scopes", () => {
    const scopes = [
      "first-time",
      "unstaged",
      "staged",
      "branch",
      "pr",
      "full",
      "rescale",
      "files",
      "ci",
      "measure-only",
    ] as const;
    for (const scope of scopes) {
      expect(SCOPE_DEPTHS[scope]).toBeDefined();
      expect(SCOPE_DEPTHS[scope]).toHaveProperty("functionality");
      expect(SCOPE_DEPTHS[scope]).toHaveProperty("security");
      expect(SCOPE_DEPTHS[scope]).toHaveProperty("stability");
      expect(SCOPE_DEPTHS[scope]).toHaveProperty("conformance");
      expect(SCOPE_DEPTHS[scope]).toHaveProperty("regression");
      expect(SCOPE_DEPTHS[scope]).toHaveProperty("updateManifest");
    }
  });

  it("first-time scope has maximum depth and updates manifest", () => {
    const ft = SCOPE_DEPTHS["first-time"];
    expect(ft.functionality).toBe("generate-and-run");
    expect(ft.security).toBe("scan-all");
    expect(ft.stability).toBe("full");
    expect(ft.conformance).toBe("full");
    expect(ft.regression).toBe("run-all");
    expect(ft.updateManifest).toBe(true);
  });

  it("unstaged scope is lightweight and does not update manifest", () => {
    const us = SCOPE_DEPTHS.unstaged;
    expect(us.functionality).toBe("show-gaps");
    expect(us.security).toBe("scan-changed");
    expect(us.stability).toBe("skip");
    expect(us.conformance).toBe("skip");
    expect(us.regression).toBe("skip");
    expect(us.updateManifest).toBe(false);
  });

  it("measure-only scope only shows gaps and updates manifest", () => {
    const mo = SCOPE_DEPTHS["measure-only"];
    expect(mo.functionality).toBe("show-gaps");
    expect(mo.security).toBe("skip");
    expect(mo.stability).toBe("skip");
    expect(mo.conformance).toBe("skip");
    expect(mo.regression).toBe("skip");
    expect(mo.updateManifest).toBe(true);
  });
});

// ─── Scoring Constants ───────────────────────────────────────

describe("TEST_TYPE_WEIGHTS", () => {
  it("gives integration and e2e highest weight (2.0)", () => {
    expect(TEST_TYPE_WEIGHTS.integration).toBe(2.0);
    expect(TEST_TYPE_WEIGHTS.e2e).toBe(2.0);
  });

  it("gives api medium weight (1.5)", () => {
    expect(TEST_TYPE_WEIGHTS.api).toBe(1.5);
  });

  it("gives unit and contract base weight (1.0)", () => {
    expect(TEST_TYPE_WEIGHTS.unit).toBe(1.0);
    expect(TEST_TYPE_WEIGHTS.contract).toBe(1.0);
  });
});

describe("SECURITY_SEVERITY_POINTS", () => {
  it("assigns decreasing points from critical to low", () => {
    expect(SECURITY_SEVERITY_POINTS.critical).toBe(25);
    expect(SECURITY_SEVERITY_POINTS.high).toBe(15);
    expect(SECURITY_SEVERITY_POINTS.medium).toBe(8);
    expect(SECURITY_SEVERITY_POINTS.low).toBe(3);
  });

  it("all values are positive", () => {
    for (const val of Object.values(SECURITY_SEVERITY_POINTS)) {
      expect(val).toBeGreaterThan(0);
    }
  });
});

describe("SCORE_THRESHOLDS", () => {
  it("healthy threshold is 70", () => {
    expect(SCORE_THRESHOLDS.healthy).toBe(70);
  });

  it("needsAttention threshold is 50", () => {
    expect(SCORE_THRESHOLDS.needsAttention).toBe(50);
  });

  it("atRisk threshold is 0", () => {
    expect(SCORE_THRESHOLDS.atRisk).toBe(0);
  });
});

describe("MAX_SCORE_HISTORY", () => {
  it("is 30", () => {
    expect(MAX_SCORE_HISTORY).toBe(30);
  });
});

// ─── getScoreHealth ──────────────────────────────────────────

describe("getScoreHealth", () => {
  it("returns 'healthy' for scores >= 70", () => {
    expect(getScoreHealth(70)).toBe("healthy");
    expect(getScoreHealth(85)).toBe("healthy");
    expect(getScoreHealth(100)).toBe("healthy");
  });

  it("returns 'needs-attention' for scores >= 50 and < 70", () => {
    expect(getScoreHealth(50)).toBe("needs-attention");
    expect(getScoreHealth(60)).toBe("needs-attention");
    expect(getScoreHealth(69)).toBe("needs-attention");
  });

  it("returns 'at-risk' for scores < 50", () => {
    expect(getScoreHealth(0)).toBe("at-risk");
    expect(getScoreHealth(25)).toBe("at-risk");
    expect(getScoreHealth(49)).toBe("at-risk");
  });

  it("handles boundary values precisely", () => {
    expect(getScoreHealth(70)).toBe("healthy");
    expect(getScoreHealth(69.9)).toBe("needs-attention");
    expect(getScoreHealth(50)).toBe("needs-attention");
    expect(getScoreHealth(49.9)).toBe("at-risk");
  });
});
