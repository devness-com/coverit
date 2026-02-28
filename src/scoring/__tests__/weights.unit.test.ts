/**
 * Unit tests for scoring/weights.ts
 * Tests complexity weights, dimension weight resolution, test type weights,
 * security severity points, and helper functions.
 */
import { describe, it, expect } from "vitest";

import {
  getComplexityWeight,
  resolveDimensionWeights,
  normalizeDimensionWeights,
  getTestTypeWeight,
  totalTestTypeWeight,
  findingSeverityPoints,
  isCriticalFinding,
  getAllDimensions,
  TEST_TYPE_WEIGHTS,
  SECURITY_SEVERITY_POINTS,
} from "../weights.js";
import type { DimensionConfig } from "../../schema/coverit-manifest.js";
import { DEFAULT_DIMENSIONS } from "../../schema/defaults.js";

// --- Helpers ---

function makeDimensionConfig(
  overrides: Partial<Record<keyof DimensionConfig, { enabled: boolean; weight: number }>> = {},
): DimensionConfig {
  const base = structuredClone(DEFAULT_DIMENSIONS);
  for (const [key, val] of Object.entries(overrides)) {
    const dim = base[key as keyof DimensionConfig];
    dim.enabled = val.enabled;
    dim.weight = val.weight;
  }
  return base;
}

// --- Tests ---

describe("getComplexityWeight", () => {
  it("returns 1 for low complexity", () => {
    expect(getComplexityWeight("low")).toBe(1);
  });

  it("returns 2 for medium complexity", () => {
    expect(getComplexityWeight("medium")).toBe(2);
  });

  it("returns 3 for high complexity", () => {
    expect(getComplexityWeight("high")).toBe(3);
  });
});

describe("resolveDimensionWeights", () => {
  it("returns configured weights when all dimensions are enabled", () => {
    const config = makeDimensionConfig();
    const resolved = resolveDimensionWeights(config);

    expect(resolved.functionality).toBe(0.35);
    expect(resolved.security).toBe(0.25);
    expect(resolved.stability).toBe(0.15);
    expect(resolved.conformance).toBe(0.15);
    expect(resolved.regression).toBe(0.10);
  });

  it("returns 0 weight for disabled dimensions", () => {
    const config = makeDimensionConfig({
      security: { enabled: false, weight: 0.25 },
      stability: { enabled: false, weight: 0.15 },
    });
    const resolved = resolveDimensionWeights(config);

    expect(resolved.security).toBe(0);
    expect(resolved.stability).toBe(0);
    expect(resolved.functionality).toBe(0.35);
    expect(resolved.conformance).toBe(0.15);
    expect(resolved.regression).toBe(0.10);
  });

  it("returns all zeros when every dimension is disabled", () => {
    const config = makeDimensionConfig({
      functionality: { enabled: false, weight: 0.35 },
      security: { enabled: false, weight: 0.25 },
      stability: { enabled: false, weight: 0.15 },
      conformance: { enabled: false, weight: 0.15 },
      regression: { enabled: false, weight: 0.10 },
    });
    const resolved = resolveDimensionWeights(config);

    expect(resolved.functionality).toBe(0);
    expect(resolved.security).toBe(0);
    expect(resolved.stability).toBe(0);
    expect(resolved.conformance).toBe(0);
    expect(resolved.regression).toBe(0);
  });
});

describe("normalizeDimensionWeights", () => {
  it("normalizes weights to sum to 1.0", () => {
    const weights = {
      functionality: 0.35,
      security: 0.25,
      stability: 0.15,
      conformance: 0.15,
      regression: 0.10,
    };
    const normalized = normalizeDimensionWeights(weights);
    const sum =
      normalized.functionality +
      normalized.security +
      normalized.stability +
      normalized.conformance +
      normalized.regression;

    expect(sum).toBeCloseTo(1.0, 5);
  });

  it("redistributes weight when some dimensions have 0 weight", () => {
    const weights = {
      functionality: 0.5,
      security: 0.5,
      stability: 0,
      conformance: 0,
      regression: 0,
    };
    const normalized = normalizeDimensionWeights(weights);

    expect(normalized.functionality).toBeCloseTo(0.5, 5);
    expect(normalized.security).toBeCloseTo(0.5, 5);
    expect(normalized.stability).toBe(0);
    expect(normalized.conformance).toBe(0);
    expect(normalized.regression).toBe(0);
  });

  it("returns original weights when all are zero (avoids division by zero)", () => {
    const weights = {
      functionality: 0,
      security: 0,
      stability: 0,
      conformance: 0,
      regression: 0,
    };
    const normalized = normalizeDimensionWeights(weights);

    expect(normalized.functionality).toBe(0);
    expect(normalized.security).toBe(0);
  });
});

describe("getTestTypeWeight", () => {
  it("returns 2.0 for integration tests", () => {
    expect(getTestTypeWeight("integration")).toBe(2.0);
  });

  it("returns 2.0 for e2e tests", () => {
    expect(getTestTypeWeight("e2e")).toBe(2.0);
  });

  it("returns 1.5 for api tests", () => {
    expect(getTestTypeWeight("api")).toBe(1.5);
  });

  it("returns 1.0 for unit tests", () => {
    expect(getTestTypeWeight("unit")).toBe(1.0);
  });

  it("returns 1.0 for contract tests", () => {
    expect(getTestTypeWeight("contract")).toBe(1.0);
  });
});

describe("totalTestTypeWeight", () => {
  it("sums weights for given test types", () => {
    const total = totalTestTypeWeight(["unit", "integration"]);
    expect(total).toBe(3.0); // 1.0 + 2.0
  });

  it("returns 0 for empty array", () => {
    expect(totalTestTypeWeight([])).toBe(0);
  });

  it("sums all test types correctly", () => {
    const total = totalTestTypeWeight(["unit", "integration", "api", "e2e", "contract"]);
    // 1.0 + 2.0 + 1.5 + 2.0 + 1.0 = 7.5
    expect(total).toBe(7.5);
  });
});

describe("findingSeverityPoints", () => {
  it("returns 25 points for injection findings (critical)", () => {
    expect(findingSeverityPoints("injection:auth.ts:42")).toBe(25);
  });

  it("returns 25 points for auth-bypass findings (critical)", () => {
    expect(findingSeverityPoints("auth-bypass:login.ts:10")).toBe(25);
  });

  it("returns 15 points for secrets-exposure findings (high)", () => {
    expect(findingSeverityPoints("secrets-exposure:config.ts:5")).toBe(15);
  });

  it("returns 15 points for xss findings (high)", () => {
    expect(findingSeverityPoints("xss:template.ts:20")).toBe(15);
  });

  it("returns 8 points for data-exposure findings (medium)", () => {
    expect(findingSeverityPoints("data-exposure:api.ts:30")).toBe(8);
  });

  it("returns 3 points for dependency-vulns findings (low)", () => {
    expect(findingSeverityPoints("dependency-vulns:package.json:1")).toBe(3);
  });

  it("returns 8 points (medium default) for unknown finding types", () => {
    expect(findingSeverityPoints("unknown-type:file.ts:1")).toBe(8);
  });

  it("handles findings with no colons (just a type string)", () => {
    expect(findingSeverityPoints("injection")).toBe(25);
  });
});

describe("isCriticalFinding", () => {
  it("returns true for injection findings", () => {
    expect(isCriticalFinding("injection:auth.ts:42")).toBe(true);
  });

  it("returns true for auth-bypass findings", () => {
    expect(isCriticalFinding("auth-bypass:login.ts:10")).toBe(true);
  });

  it("returns false for high-severity findings", () => {
    expect(isCriticalFinding("secrets-exposure:config.ts:5")).toBe(false);
  });

  it("returns false for medium-severity findings", () => {
    expect(isCriticalFinding("data-exposure:api.ts:30")).toBe(false);
  });

  it("returns false for unknown finding types", () => {
    expect(isCriticalFinding("unknown:file.ts:1")).toBe(false);
  });
});

describe("getAllDimensions", () => {
  it("returns all five dimensions", () => {
    const dims = getAllDimensions();
    expect(dims).toHaveLength(5);
    expect(dims).toContain("functionality");
    expect(dims).toContain("security");
    expect(dims).toContain("stability");
    expect(dims).toContain("conformance");
    expect(dims).toContain("regression");
  });
});

describe("re-exported constants", () => {
  it("TEST_TYPE_WEIGHTS contains all five test types", () => {
    expect(Object.keys(TEST_TYPE_WEIGHTS)).toHaveLength(5);
    expect(TEST_TYPE_WEIGHTS.integration).toBe(2.0);
    expect(TEST_TYPE_WEIGHTS.unit).toBe(1.0);
  });

  it("SECURITY_SEVERITY_POINTS has correct point values", () => {
    expect(SECURITY_SEVERITY_POINTS["critical"]).toBe(25);
    expect(SECURITY_SEVERITY_POINTS["high"]).toBe(15);
    expect(SECURITY_SEVERITY_POINTS["medium"]).toBe(8);
    expect(SECURITY_SEVERITY_POINTS["low"]).toBe(3);
  });
});
