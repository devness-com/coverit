/**
 * Unit tests for scoring/thresholds.ts
 * Tests score interpretation, dimension health assessment, gap priority,
 * and quality gate evaluation.
 */
import { describe, it, expect } from "vitest";

import {
  interpretScore,
  assessDimensions,
  getGapPriority,
  evaluateGate,
  SCORE_THRESHOLDS,
  getScoreHealth,
} from "../thresholds.js";
import type { DimensionScores } from "../../schema/coverit-manifest.js";

// --- Tests ---

describe("SCORE_THRESHOLDS", () => {
  it("has healthy threshold at 70", () => {
    expect(SCORE_THRESHOLDS.healthy).toBe(70);
  });

  it("has needsAttention threshold at 50", () => {
    expect(SCORE_THRESHOLDS.needsAttention).toBe(50);
  });

  it("has atRisk threshold at 0", () => {
    expect(SCORE_THRESHOLDS.atRisk).toBe(0);
  });
});

describe("getScoreHealth", () => {
  it("returns 'healthy' for scores >= 70", () => {
    expect(getScoreHealth(70)).toBe("healthy");
    expect(getScoreHealth(100)).toBe("healthy");
    expect(getScoreHealth(85)).toBe("healthy");
  });

  it("returns 'needs-attention' for scores >= 50 and < 70", () => {
    expect(getScoreHealth(50)).toBe("needs-attention");
    expect(getScoreHealth(69)).toBe("needs-attention");
    expect(getScoreHealth(55)).toBe("needs-attention");
  });

  it("returns 'at-risk' for scores < 50", () => {
    expect(getScoreHealth(0)).toBe("at-risk");
    expect(getScoreHealth(49)).toBe("at-risk");
    expect(getScoreHealth(25)).toBe("at-risk");
  });
});

describe("interpretScore", () => {
  it("returns healthy interpretation for score >= 70", () => {
    const result = interpretScore(85);

    expect(result.health).toBe("healthy");
    expect(result.label).toBe("Healthy");
    expect(result.color).toBe("green");
    expect(result.summary).toContain("Quality standards are met");
  });

  it("returns needs-attention interpretation for score >= 50 and < 70", () => {
    const result = interpretScore(55);

    expect(result.health).toBe("needs-attention");
    expect(result.label).toBe("Needs Attention");
    expect(result.color).toBe("yellow");
    expect(result.summary).toContain("quality gaps");
  });

  it("returns at-risk interpretation for score < 50", () => {
    const result = interpretScore(20);

    expect(result.health).toBe("at-risk");
    expect(result.label).toBe("At Risk");
    expect(result.color).toBe("red");
    expect(result.summary).toContain("Significant quality gaps");
  });

  it("handles boundary score of exactly 70", () => {
    const result = interpretScore(70);
    expect(result.health).toBe("healthy");
    expect(result.color).toBe("green");
  });

  it("handles boundary score of exactly 50", () => {
    const result = interpretScore(50);
    expect(result.health).toBe("needs-attention");
    expect(result.color).toBe("yellow");
  });

  it("handles score of 0", () => {
    const result = interpretScore(0);
    expect(result.health).toBe("at-risk");
    expect(result.color).toBe("red");
  });
});

describe("assessDimensions", () => {
  it("returns all five dimensions with health assessments", () => {
    const scores: DimensionScores = {
      functionality: 80,
      security: 90,
      stability: 60,
      conformance: 30,
      regression: 100,
    };
    const results = assessDimensions(scores);

    expect(results).toHaveLength(5);
    expect(results.map((r) => r.dimension)).toEqual(
      expect.arrayContaining(["functionality", "security", "stability", "conformance", "regression"]),
    );
  });

  it("sorts results worst-first (lowest score first)", () => {
    const scores: DimensionScores = {
      functionality: 80,
      security: 20,
      stability: 60,
      conformance: 40,
      regression: 100,
    };
    const results = assessDimensions(scores);

    expect(results[0]!.dimension).toBe("security");
    expect(results[0]!.score).toBe(20);
    expect(results[results.length - 1]!.score).toBe(100);
  });

  it("assigns correct health labels based on score thresholds", () => {
    const scores: DimensionScores = {
      functionality: 80,  // healthy
      security: 55,       // needs-attention
      stability: 30,      // at-risk
      conformance: 70,    // healthy (boundary)
      regression: 50,     // needs-attention (boundary)
    };
    const results = assessDimensions(scores);

    const findDim = (name: string) => results.find((r) => r.dimension === name)!;

    expect(findDim("functionality").health).toBe("healthy");
    expect(findDim("functionality").color).toBe("green");
    expect(findDim("security").health).toBe("needs-attention");
    expect(findDim("security").color).toBe("yellow");
    expect(findDim("stability").health).toBe("at-risk");
    expect(findDim("stability").color).toBe("red");
    expect(findDim("conformance").health).toBe("healthy");
    expect(findDim("regression").health).toBe("needs-attention");
  });
});

describe("getGapPriority", () => {
  it("returns 'critical' for scores below 25", () => {
    expect(getGapPriority(0)).toBe("critical");
    expect(getGapPriority(10)).toBe("critical");
    expect(getGapPriority(24)).toBe("critical");
  });

  it("returns 'high' for scores between 25 and 49", () => {
    expect(getGapPriority(25)).toBe("high");
    expect(getGapPriority(35)).toBe("high");
    expect(getGapPriority(49)).toBe("high");
  });

  it("returns 'medium' for scores between 50 and 69", () => {
    expect(getGapPriority(50)).toBe("medium");
    expect(getGapPriority(60)).toBe("medium");
    expect(getGapPriority(69)).toBe("medium");
  });

  it("returns 'low' for scores 70 and above", () => {
    expect(getGapPriority(70)).toBe("low");
    expect(getGapPriority(85)).toBe("low");
    expect(getGapPriority(100)).toBe("low");
  });
});

describe("evaluateGate", () => {
  it("passes when overall score meets threshold and no dimension is at-risk", () => {
    const scores: DimensionScores = {
      functionality: 80,
      security: 70,
      stability: 75,
      conformance: 85,
      regression: 90,
    };
    const result = evaluateGate(80, scores);

    expect(result.passed).toBe(true);
    expect(result.overall.passed).toBe(true);
    expect(result.overall.score).toBe(80);
    expect(result.overall.threshold).toBe(70); // default
    expect(result.failedDimensions).toHaveLength(0);
  });

  it("fails when overall score is below threshold", () => {
    const scores: DimensionScores = {
      functionality: 80,
      security: 70,
      stability: 75,
      conformance: 85,
      regression: 90,
    };
    const result = evaluateGate(60, scores);

    expect(result.passed).toBe(false);
    expect(result.overall.passed).toBe(false);
  });

  it("fails when any dimension is at-risk even if overall passes", () => {
    const scores: DimensionScores = {
      functionality: 90,
      security: 10, // at-risk
      stability: 90,
      conformance: 90,
      regression: 90,
    };
    const result = evaluateGate(85, scores);

    expect(result.passed).toBe(false);
    expect(result.overall.passed).toBe(true); // overall passes...
    expect(result.failedDimensions.length).toBeGreaterThan(0);
    expect(result.failedDimensions[0]!.dimension).toBe("security");
  });

  it("uses custom threshold when provided", () => {
    const scores: DimensionScores = {
      functionality: 80,
      security: 80,
      stability: 80,
      conformance: 80,
      regression: 80,
    };

    const pass = evaluateGate(80, scores, 80);
    expect(pass.passed).toBe(true);

    const fail = evaluateGate(80, scores, 90);
    expect(fail.passed).toBe(false);
    expect(fail.overall.passed).toBe(false);
    expect(fail.overall.threshold).toBe(90);
  });

  it("identifies all at-risk dimensions in failedDimensions", () => {
    const scores: DimensionScores = {
      functionality: 20,
      security: 30,
      stability: 70,
      conformance: 10,
      regression: 80,
    };
    const result = evaluateGate(75, scores);

    // functionality (20) and conformance (10) are at-risk (< 50)
    const failedNames = result.failedDimensions.map((d) => d.dimension);
    expect(failedNames).toContain("functionality");
    expect(failedNames).toContain("conformance");
  });
});
