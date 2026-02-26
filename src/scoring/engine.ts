/**
 * Scoring Engine — Core quality score calculation
 *
 * Computes a 0-100 overall quality score from a CoveritManifest by
 * evaluating five ISO/IEC 25010:2023 quality dimensions:
 *
 *   overall = SUM(dimension_score * dimension_weight)
 *
 * Each dimension score is itself a 0-100 value computed from module-level
 * data in the manifest. Module contributions are weighted by complexity
 * (high=3, medium=2, low=1) so that critical modules have proportionally
 * more influence on the aggregate score.
 */

import type {
  CoveritManifest,
  Dimension,
  DimensionScores,
  FunctionalityConfig,
  FunctionalTestType,
  GapSummary,
  ModuleEntry,
  ScoreResult,
  TestCoverage,
} from "../schema/coverit-manifest.js";

import {
  getComplexityWeight,
  getTestTypeWeight,
  findingSeverityPoints,
  isCriticalFinding,
  resolveDimensionWeights,
} from "./weights.js";

import { getGapPriority } from "./thresholds.js";

// ─── Public API ─────────────────────────────────────────────

/**
 * Calculate the complete quality score for a manifest.
 * This is the primary entry point for the scoring engine.
 *
 * Only dimensions that have been scanned (tracked in `score.scanned`)
 * contribute to the overall weighted score. Unscanned dimension weights
 * are redistributed proportionally to scanned dimensions.
 */
export function calculateScore(manifest: CoveritManifest): ScoreResult {
  const breakdown = calculateAllDimensions(manifest);
  const rawWeights = resolveDimensionWeights(manifest.dimensions);
  const scanned = manifest.score.scanned ?? {};

  // Only include scanned dimensions in the overall score
  const scannedDims = (Object.keys(rawWeights) as Dimension[]).filter(
    (dim) => scanned[dim] != null,
  );

  let overall: number;
  if (scannedDims.length === 0) {
    // No dimensions scanned yet — use functionality raw score
    overall = breakdown.functionality;
  } else {
    // Redistribute weight from unscanned to scanned dimensions
    const scannedWeightSum = scannedDims.reduce(
      (sum, dim) => sum + rawWeights[dim],
      0,
    );
    const normalizer = scannedWeightSum > 0 ? 1 / scannedWeightSum : 0;

    overall = roundScore(
      scannedDims.reduce(
        (sum, dim) => sum + breakdown[dim] * rawWeights[dim] * normalizer,
        0,
      ),
    );
  }

  const gaps = buildGapSummary(manifest.modules, breakdown);

  return {
    overall,
    breakdown,
    gaps,
    // Preserve existing history; the caller appends a new entry
    history: manifest.score.history,
    scanned,
  };
}

/**
 * Calculate the score for a single dimension.
 * Useful when only one dimension needs re-evaluation (e.g., after
 * running security scans without regenerating all tests).
 */
export function calculateDimensionScore(
  dimension: Dimension,
  manifest: CoveritManifest,
): number {
  switch (dimension) {
    case "functionality":
      return calculateFunctionalityScore(
        manifest.modules,
        manifest.dimensions.functionality,
      );
    case "security":
      return calculateSecurityScore(manifest.modules);
    case "stability":
      return calculateStabilityScore(manifest.modules);
    case "conformance":
      return calculateConformanceScore(manifest.modules);
    case "regression":
      return calculateRegressionScore(manifest.modules);
  }
}

// ─── Functionality Score ────────────────────────────────────
// coverage_per_module = SUM(min(current/expected, 1) * test_type_weight) / SUM(test_type_weight)
// overall = weighted average across modules by complexity

/**
 * Calculate the functionality dimension score.
 *
 * For each module, we compute a weighted coverage ratio across all
 * test types that have expected counts. Test types are weighted by
 * the Diamond strategy (integration > api > unit/contract), so a
 * module with good integration coverage scores higher than one with
 * only unit tests.
 *
 * @param modules - Module entries from the manifest
 * @param _config - Functionality config (reserved for future target-aware scoring)
 */
export function calculateFunctionalityScore(
  modules: ModuleEntry[],
  _config: FunctionalityConfig,
): number {
  if (modules.length === 0) return 0;

  let weightedSum = 0;
  let totalWeight = 0;

  for (const mod of modules) {
    const moduleCoverage = calculateModuleCoverage(mod);
    const cWeight = getComplexityWeight(mod.complexity);

    weightedSum += moduleCoverage * cWeight;
    totalWeight += cWeight;
  }

  if (totalWeight === 0) return 0;
  return roundScore((weightedSum / totalWeight) * 100);
}

/**
 * Calculate weighted test coverage ratio for a single module.
 * Returns a value between 0.0 and 1.0.
 */
function calculateModuleCoverage(mod: ModuleEntry): number {
  const testEntries = Object.entries(mod.functionality.tests) as Array<
    [FunctionalTestType, TestCoverage]
  >;

  if (testEntries.length === 0) return 0;

  let numerator = 0;
  let denominator = 0;

  for (const [testType, coverage] of testEntries) {
    const typeWeight = getTestTypeWeight(testType);

    // Ratio capped at 1.0 — having more tests than expected
    // doesn't inflate the score beyond "fully covered"
    const ratio =
      coverage.expected > 0
        ? Math.min(coverage.current / coverage.expected, 1.0)
        : coverage.current > 0
          ? 1.0
          : 0;

    numerator += ratio * typeWeight;
    denominator += typeWeight;
  }

  if (denominator === 0) return 0;
  return numerator / denominator;
}

// ─── Security Score ─────────────────────────────────────────
// 100 - SUM(severity_points per finding)
// Critical cap: if any critical finding exists and score > 25, cap at 25

/**
 * Calculate the security dimension score.
 *
 * Starts at 100 and deducts points for each finding based on its
 * severity (derived from the check type prefix in the finding string).
 * A hard cap at 25 applies when any critical-severity issue exists,
 * ensuring critical vulnerabilities can never be masked by good
 * scores elsewhere.
 */
export function calculateSecurityScore(modules: ModuleEntry[]): number {
  let totalDeduction = 0;
  let hasCritical = false;

  for (const mod of modules) {
    for (const finding of mod.security.findings) {
      totalDeduction += findingSeverityPoints(finding);
      if (isCriticalFinding(finding)) {
        hasCritical = true;
      }
    }
  }

  let score = Math.max(0, Math.min(100, 100 - totalDeduction));

  // Hard cap: critical issues prevent a score above 25
  if (hasCritical && score > 25) {
    score = 25;
  }

  return roundScore(score);
}

// ─── Stability Score ────────────────────────────────────────
// Complexity-weighted average of per-module stability scores

function calculateStabilityScore(modules: ModuleEntry[]): number {
  return complexityWeightedAverage(modules, (mod) => mod.stability.score);
}

// ─── Conformance Score ──────────────────────────────────────
// Complexity-weighted average of per-module conformance scores

function calculateConformanceScore(modules: ModuleEntry[]): number {
  return complexityWeightedAverage(modules, (mod) => mod.conformance.score);
}

// ─── Regression Score ───────────────────────────────────────
// If no existing tests: 100 (nothing to regress)
// Otherwise: (passing / total) * 100

function calculateRegressionScore(modules: ModuleEntry[]): number {
  let totalTests = 0;
  let passingTests = 0;

  for (const mod of modules) {
    const testEntries = Object.values(mod.functionality.tests);
    for (const coverage of testEntries) {
      totalTests += coverage.expected;
      passingTests += coverage.current;
    }
  }

  // No existing tests means nothing can regress
  if (totalTests === 0) return 100;

  // Cap ratio at 1.0 in case current exceeds expected somewhere
  const ratio = Math.min(passingTests / totalTests, 1.0);
  return roundScore(ratio * 100);
}

// ─── Gap Summary Builder ────────────────────────────────────

function buildGapSummary(
  modules: ModuleEntry[],
  scores: DimensionScores,
): GapSummary {
  let functionalityMissing = 0;
  let securityIssues = 0;
  let stabilityGaps = 0;
  let conformanceViolations = 0;

  for (const mod of modules) {
    // Count missing tests (expected - current, minimum 0)
    const testEntries = Object.values(mod.functionality.tests);
    for (const coverage of testEntries) {
      const deficit = coverage.expected - coverage.current;
      if (deficit > 0) functionalityMissing += deficit;
    }

    securityIssues += mod.security.issues;
    stabilityGaps += mod.stability.gaps.length;
    conformanceViolations += mod.conformance.violations.length;
  }

  const total =
    functionalityMissing +
    securityIssues +
    stabilityGaps +
    conformanceViolations;

  // Critical gaps are those in dimensions scoring below 25
  let critical = 0;
  if (scores.functionality < 25) critical += functionalityMissing;
  if (scores.security < 25) critical += securityIssues;
  if (scores.stability < 25) critical += stabilityGaps;
  if (scores.conformance < 25) critical += conformanceViolations;

  return {
    total,
    critical,
    byDimension: {
      functionality: {
        missing: functionalityMissing,
        priority: getGapPriority(scores.functionality),
      },
      security: {
        issues: securityIssues,
        priority: getGapPriority(scores.security),
      },
      stability: {
        gaps: stabilityGaps,
        priority: getGapPriority(scores.stability),
      },
      conformance: {
        violations: conformanceViolations,
        priority: getGapPriority(scores.conformance),
      },
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Calculate complexity-weighted average across modules.
 * Used by stability and conformance dimensions which store
 * pre-computed per-module scores.
 */
function complexityWeightedAverage(
  modules: ModuleEntry[],
  getScore: (mod: ModuleEntry) => number,
): number {
  if (modules.length === 0) return 0;

  let weightedSum = 0;
  let totalWeight = 0;

  for (const mod of modules) {
    const cWeight = getComplexityWeight(mod.complexity);
    weightedSum += getScore(mod) * cWeight;
    totalWeight += cWeight;
  }

  if (totalWeight === 0) return 0;
  return roundScore(weightedSum / totalWeight);
}

/**
 * Calculate all five dimension scores from a manifest.
 */
function calculateAllDimensions(manifest: CoveritManifest): DimensionScores {
  return {
    functionality: calculateFunctionalityScore(
      manifest.modules,
      manifest.dimensions.functionality,
    ),
    security: calculateSecurityScore(manifest.modules),
    stability: calculateStabilityScore(manifest.modules),
    conformance: calculateConformanceScore(manifest.modules),
    regression: calculateRegressionScore(manifest.modules),
  };
}

/**
 * Round a score to one decimal place to avoid floating-point noise
 * in serialized manifests while preserving meaningful precision.
 */
function roundScore(value: number): number {
  return Math.round(value * 10) / 10;
}
