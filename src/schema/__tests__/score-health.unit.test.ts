/**
 * Unit tests for getScoreHealth and scoring constant interactions
 * Tests edge cases, boundary conditions, and consistency between
 * SCORE_THRESHOLDS, getScoreHealth, and scoring weights.
 */
import { describe, it, expect } from "vitest";

import {
  getScoreHealth,
  SCORE_THRESHOLDS,
  EXPECTED_TESTS_BY_COMPLEXITY,
  TEST_TYPE_WEIGHTS,
  SECURITY_SEVERITY_POINTS,
  SCOPE_DEPTHS,
  DEFAULT_DIMENSIONS,
  MAX_SCORE_HISTORY,
  type ScoreHealth,
} from "../defaults.js";

// ─── getScoreHealth edge cases ───────────────────────────────

describe("getScoreHealth edge cases", () => {
  it("returns 'healthy' for exactly the threshold (70)", () => {
    expect(getScoreHealth(SCORE_THRESHOLDS.healthy)).toBe("healthy");
  });

  it("returns 'needs-attention' for 1 below healthy (69)", () => {
    expect(getScoreHealth(SCORE_THRESHOLDS.healthy - 1)).toBe("needs-attention");
  });

  it("returns 'needs-attention' for exactly the threshold (50)", () => {
    expect(getScoreHealth(SCORE_THRESHOLDS.needsAttention)).toBe("needs-attention");
  });

  it("returns 'at-risk' for 1 below needsAttention (49)", () => {
    expect(getScoreHealth(SCORE_THRESHOLDS.needsAttention - 1)).toBe("at-risk");
  });

  it("returns 'at-risk' for 0", () => {
    expect(getScoreHealth(0)).toBe("at-risk");
  });

  it("returns 'healthy' for 100", () => {
    expect(getScoreHealth(100)).toBe("healthy");
  });

  it("handles fractional scores at boundaries", () => {
    expect(getScoreHealth(69.999)).toBe("needs-attention");
    expect(getScoreHealth(70.0)).toBe("healthy");
    expect(getScoreHealth(49.999)).toBe("at-risk");
    expect(getScoreHealth(50.0)).toBe("needs-attention");
  });

  it("handles negative scores gracefully (returns at-risk)", () => {
    expect(getScoreHealth(-1)).toBe("at-risk");
    expect(getScoreHealth(-100)).toBe("at-risk");
  });

  it("handles scores above 100 (returns healthy)", () => {
    expect(getScoreHealth(101)).toBe("healthy");
    expect(getScoreHealth(999)).toBe("healthy");
  });
});

// ─── SCORE_THRESHOLDS consistency ────────────────────────────

describe("SCORE_THRESHOLDS consistency", () => {
  it("thresholds are in descending order", () => {
    expect(SCORE_THRESHOLDS.healthy).toBeGreaterThan(SCORE_THRESHOLDS.needsAttention);
    expect(SCORE_THRESHOLDS.needsAttention).toBeGreaterThanOrEqual(SCORE_THRESHOLDS.atRisk);
  });

  it("getScoreHealth covers the full 0-100 range without gaps", () => {
    // Test every integer from 0 to 100 is classified
    const results = new Set<ScoreHealth>();
    for (let score = 0; score <= 100; score++) {
      const health = getScoreHealth(score);
      results.add(health);
      expect(["healthy", "needs-attention", "at-risk"]).toContain(health);
    }
    // All three health states should appear in the range
    expect(results.size).toBe(3);
  });
});

// ─── Diamond Strategy Consistency ────────────────────────────

describe("diamond strategy consistency", () => {
  it("integration tests have higher expected counts than unit in medium+ complexity", () => {
    expect(EXPECTED_TESTS_BY_COMPLEXITY.medium.integration).toBeGreaterThan(
      EXPECTED_TESTS_BY_COMPLEXITY.medium.unit,
    );
    expect(EXPECTED_TESTS_BY_COMPLEXITY.high.integration).toBeGreaterThan(
      EXPECTED_TESTS_BY_COMPLEXITY.high.unit,
    );
  });

  it("integration and e2e have the highest test type weights", () => {
    const maxWeight = Math.max(...Object.values(TEST_TYPE_WEIGHTS));
    expect(TEST_TYPE_WEIGHTS.integration).toBe(maxWeight);
    expect(TEST_TYPE_WEIGHTS.e2e).toBe(maxWeight);
  });

  it("unit tests have the lowest weight among all types", () => {
    const minWeight = Math.min(...Object.values(TEST_TYPE_WEIGHTS));
    expect(TEST_TYPE_WEIGHTS.unit).toBe(minWeight);
  });
});

// ─── Security Severity Ordering ──────────────────────────────

describe("security severity ordering", () => {
  it("severity points decrease from critical to low", () => {
    expect(SECURITY_SEVERITY_POINTS.critical).toBeGreaterThan(
      SECURITY_SEVERITY_POINTS.high,
    );
    expect(SECURITY_SEVERITY_POINTS.high).toBeGreaterThan(
      SECURITY_SEVERITY_POINTS.medium,
    );
    expect(SECURITY_SEVERITY_POINTS.medium).toBeGreaterThan(
      SECURITY_SEVERITY_POINTS.low,
    );
  });

  it("critical is at least 5x more severe than low", () => {
    expect(SECURITY_SEVERITY_POINTS.critical / SECURITY_SEVERITY_POINTS.low).toBeGreaterThanOrEqual(5);
  });
});

// ─── Scope Depth Relationships ───────────────────────────────

describe("scope depth relationships", () => {
  it("full and first-time scopes are equivalent in depth", () => {
    expect(SCOPE_DEPTHS.full).toEqual(SCOPE_DEPTHS["first-time"]);
  });

  it("pr and branch scopes are equivalent in depth", () => {
    expect(SCOPE_DEPTHS.pr).toEqual(SCOPE_DEPTHS.branch);
  });

  it("only unstaged and staged scopes skip manifest updates", () => {
    const noUpdate = Object.entries(SCOPE_DEPTHS).filter(
      ([, depth]) => !depth.updateManifest,
    );
    const noUpdateScopes = noUpdate.map(([scope]) => scope);
    expect(noUpdateScopes).toEqual(expect.arrayContaining(["unstaged", "staged"]));
    expect(noUpdateScopes).toHaveLength(2);
  });

  it("all scopes that update manifest also have functionality depth beyond show-gaps or generate", () => {
    for (const [scope, depth] of Object.entries(SCOPE_DEPTHS)) {
      if (depth.updateManifest && scope !== "measure-only") {
        // Scopes that update manifest should generally do more work
        expect(["generate", "generate-and-run"]).toContain(depth.functionality);
      }
    }
  });
});

// ─── Dimension Weight Integrity ──────────────────────────────

describe("dimension weight integrity", () => {
  it("all dimension weights are between 0 and 1", () => {
    const dims = DEFAULT_DIMENSIONS;
    expect(dims.functionality.weight).toBeGreaterThan(0);
    expect(dims.functionality.weight).toBeLessThanOrEqual(1);
    expect(dims.security.weight).toBeGreaterThan(0);
    expect(dims.security.weight).toBeLessThanOrEqual(1);
    expect(dims.stability.weight).toBeGreaterThan(0);
    expect(dims.stability.weight).toBeLessThanOrEqual(1);
    expect(dims.conformance.weight).toBeGreaterThan(0);
    expect(dims.conformance.weight).toBeLessThanOrEqual(1);
    expect(dims.regression.weight).toBeGreaterThan(0);
    expect(dims.regression.weight).toBeLessThanOrEqual(1);
  });

  it("functionality has the highest weight (painkiller priority)", () => {
    const dims = DEFAULT_DIMENSIONS;
    expect(dims.functionality.weight).toBeGreaterThan(dims.security.weight);
    expect(dims.functionality.weight).toBeGreaterThan(dims.stability.weight);
    expect(dims.functionality.weight).toBeGreaterThan(dims.conformance.weight);
    expect(dims.functionality.weight).toBeGreaterThan(dims.regression.weight);
  });

  it("security has the second highest weight", () => {
    const dims = DEFAULT_DIMENSIONS;
    expect(dims.security.weight).toBeGreaterThan(dims.stability.weight);
    expect(dims.security.weight).toBeGreaterThan(dims.conformance.weight);
    expect(dims.security.weight).toBeGreaterThan(dims.regression.weight);
  });

  it("regression has the lowest weight", () => {
    const dims = DEFAULT_DIMENSIONS;
    expect(dims.regression.weight).toBeLessThanOrEqual(dims.stability.weight);
    expect(dims.regression.weight).toBeLessThanOrEqual(dims.conformance.weight);
  });
});

// ─── MAX_SCORE_HISTORY ───────────────────────────────────────

describe("MAX_SCORE_HISTORY", () => {
  it("is a reasonable positive number for git-tracked history", () => {
    expect(MAX_SCORE_HISTORY).toBeGreaterThan(0);
    expect(MAX_SCORE_HISTORY).toBeLessThanOrEqual(100);
  });
});
