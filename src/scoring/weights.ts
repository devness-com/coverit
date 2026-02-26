/**
 * Scoring Weights — Dimension and test type weight management
 *
 * Re-exports the canonical defaults from schema/defaults and provides
 * helpers to resolve effective weights from a manifest's DimensionConfig.
 * The manifest may override default weights, so callers should always
 * resolve through these helpers rather than importing defaults directly.
 */

import type {
  DimensionConfig,
  FunctionalTestType,
  Complexity,
  Dimension,
} from "../schema/coverit-manifest.js";

import {
  TEST_TYPE_WEIGHTS,
  SECURITY_SEVERITY_POINTS,
} from "../schema/defaults.js";

// ─── Re-exports ─────────────────────────────────────────────

export { TEST_TYPE_WEIGHTS, SECURITY_SEVERITY_POINTS };

// ─── Complexity Weight ──────────────────────────────────────
// Used to weight module contributions by their complexity tier.
// High-complexity modules matter more in aggregate scoring.

const COMPLEXITY_WEIGHT: Record<Complexity, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

export function getComplexityWeight(complexity: Complexity): number {
  return COMPLEXITY_WEIGHT[complexity];
}

// ─── Dimension Weights ──────────────────────────────────────

export interface ResolvedDimensionWeights {
  functionality: number;
  security: number;
  stability: number;
  conformance: number;
  regression: number;
}

/**
 * Extract the effective weight for each dimension from the manifest config.
 * Disabled dimensions get weight 0; the remaining weights are returned
 * as-is (the manifest author is responsible for them summing to ~1.0).
 */
export function resolveDimensionWeights(
  config: DimensionConfig,
): ResolvedDimensionWeights {
  return {
    functionality: config.functionality.enabled ? config.functionality.weight : 0,
    security: config.security.enabled ? config.security.weight : 0,
    stability: config.stability.enabled ? config.stability.weight : 0,
    conformance: config.conformance.enabled ? config.conformance.weight : 0,
    regression: config.regression.enabled ? config.regression.weight : 0,
  };
}

/**
 * Normalize dimension weights so they sum to 1.0.
 * This ensures disabled dimensions don't create a scoring "hole"
 * where the overall score can never reach 100.
 */
export function normalizeDimensionWeights(
  weights: ResolvedDimensionWeights,
): ResolvedDimensionWeights {
  const total =
    weights.functionality +
    weights.security +
    weights.stability +
    weights.conformance +
    weights.regression;

  // Avoid division by zero when all dimensions are disabled
  if (total === 0) return weights;

  return {
    functionality: weights.functionality / total,
    security: weights.security / total,
    stability: weights.stability / total,
    conformance: weights.conformance / total,
    regression: weights.regression / total,
  };
}

// ─── Test Type Weights ──────────────────────────────────────

/**
 * Get the scoring weight for a functional test type.
 * Falls back to 1.0 for unknown types (defensive, should not happen
 * with current FunctionalTestType union).
 */
export function getTestTypeWeight(testType: FunctionalTestType): number {
  return TEST_TYPE_WEIGHTS[testType];
}

/**
 * Sum of all test type weights present in the given set.
 * Used as the denominator in weighted coverage calculations.
 */
export function totalTestTypeWeight(testTypes: FunctionalTestType[]): number {
  return testTypes.reduce((sum, t) => sum + getTestTypeWeight(t), 0);
}

// ─── Security Severity ──────────────────────────────────────

/**
 * Map each SecurityCheck type to a severity level.
 * This determines how many points each finding deducts from the
 * security score. Injection and auth-bypass are critical because
 * they represent direct exploitation vectors.
 */
const CHECK_TO_SEVERITY: Record<string, string> = {
  injection: "critical",
  "auth-bypass": "critical",
  "secrets-exposure": "high",
  xss: "high",
  ssrf: "high",
  "insecure-deserialization": "high",
  "cryptographic-failures": "high",
  "data-exposure": "medium",
  "insecure-config": "medium",
  "dependency-vulns": "low",
};

/**
 * Resolve the point cost of a single security finding.
 * Findings follow the format "check_type:file:line" (e.g., "injection:auth.ts:42").
 * We parse the check type prefix and map it through severity tiers.
 */
export function findingSeverityPoints(finding: string): number {
  const checkType = finding.split(":")[0] ?? "";
  const severity = CHECK_TO_SEVERITY[checkType] ?? "medium";
  return SECURITY_SEVERITY_POINTS[severity] ?? 8;
}

/**
 * Determine if a finding represents a critical-severity issue.
 */
export function isCriticalFinding(finding: string): boolean {
  const checkType = finding.split(":")[0] ?? "";
  return CHECK_TO_SEVERITY[checkType] === "critical";
}

// ─── Dimension Key Helpers ──────────────────────────────────

const ALL_DIMENSIONS: Dimension[] = [
  "functionality",
  "security",
  "stability",
  "conformance",
  "regression",
];

export function getAllDimensions(): Dimension[] {
  return ALL_DIMENSIONS;
}
