/**
 * Score Thresholds — Interpretation and health status
 *
 * Converts raw 0-100 scores into human-readable health assessments.
 * Re-exports the canonical thresholds from defaults and adds richer
 * interpretation (labels, colors, recommendations).
 */

import type { Dimension, DimensionScores } from "../schema/coverit-manifest.js";
import { SCORE_THRESHOLDS, getScoreHealth } from "../schema/defaults.js";
import type { ScoreHealth } from "../schema/defaults.js";

// ─── Re-exports ─────────────────────────────────────────────

export { SCORE_THRESHOLDS, getScoreHealth };
export type { ScoreHealth };

// ─── Score Interpretation ───────────────────────────────────

export interface ScoreInterpretation {
  health: ScoreHealth;
  label: string;
  /** Terminal-safe color identifier for rendering */
  color: "green" | "yellow" | "red";
  /** Short description of what this health level means */
  summary: string;
}

/**
 * Produce a full interpretation of a numeric score.
 */
export function interpretScore(score: number): ScoreInterpretation {
  const health = getScoreHealth(score);

  switch (health) {
    case "healthy":
      return {
        health,
        label: "Healthy",
        color: "green",
        summary: "Quality standards are met. Maintain current coverage.",
      };
    case "needs-attention":
      return {
        health,
        label: "Needs Attention",
        color: "yellow",
        summary: "Some quality gaps exist. Address highest-priority items.",
      };
    case "at-risk":
      return {
        health,
        label: "At Risk",
        color: "red",
        summary: "Significant quality gaps. Immediate action recommended.",
      };
  }
}

// ─── Dimension Health ───────────────────────────────────────

export interface DimensionHealth {
  dimension: Dimension;
  score: number;
  health: ScoreHealth;
  label: string;
  color: "green" | "yellow" | "red";
}

/**
 * Assess health for every dimension in a breakdown.
 * Returns results sorted worst-first so callers can prioritize.
 */
export function assessDimensions(
  scores: DimensionScores,
): DimensionHealth[] {
  const dimensions: Dimension[] = [
    "functionality",
    "security",
    "stability",
    "conformance",
    "regression",
  ];

  return dimensions
    .map((dimension) => {
      const score = scores[dimension];
      const interp = interpretScore(score);
      return {
        dimension,
        score,
        health: interp.health,
        label: interp.label,
        color: interp.color,
      };
    })
    .sort((a, b) => a.score - b.score);
}

// ─── Gap Priority Classification ────────────────────────────

export type GapPriority = "critical" | "high" | "medium" | "low";

/**
 * Determine the priority label for a dimension's gap based on its score.
 * Used when building the GapSummary in ScoreResult.
 */
export function getGapPriority(dimensionScore: number): GapPriority {
  if (dimensionScore < 25) return "critical";
  if (dimensionScore < 50) return "high";
  if (dimensionScore < 70) return "medium";
  return "low";
}

// ─── Pass/Fail Gate ─────────────────────────────────────────

export interface GateResult {
  passed: boolean;
  /** Score vs threshold */
  overall: { score: number; threshold: number; passed: boolean };
  /** Dimensions that individually failed the threshold */
  failedDimensions: DimensionHealth[];
}

/**
 * Evaluate whether a score passes a quality gate.
 *
 * A gate passes when:
 *   1. The overall score meets the threshold, AND
 *   2. No individual dimension is "at-risk" (below needsAttention threshold)
 *
 * The per-dimension check prevents a high-scoring project from masking
 * a single catastrophically low dimension (e.g., 0 security).
 */
export function evaluateGate(
  overallScore: number,
  dimensionScores: DimensionScores,
  threshold: number = SCORE_THRESHOLDS.healthy,
): GateResult {
  const overallPassed = overallScore >= threshold;
  const dimensionHealth = assessDimensions(dimensionScores);
  const failedDimensions = dimensionHealth.filter(
    (d) => d.health === "at-risk",
  );

  return {
    passed: overallPassed && failedDimensions.length === 0,
    overall: {
      score: overallScore,
      threshold,
      passed: overallPassed,
    },
    failedDimensions,
  };
}
