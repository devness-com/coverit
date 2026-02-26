/**
 * Regression Comparator — Compares current test results against baseline.
 *
 * The baseline is the manifest's regression data (module test counts and
 * any previously recorded failures). This module identifies:
 *
 *   - NEW regressions: tests that were passing but are now failing
 *   - FIXED tests: tests that were failing but are now passing
 *   - PRE-EXISTING: tests that were already failing (not your fault)
 *
 * The comparator is pure — it has no side effects and works entirely
 * from the data structures passed in. This makes it trivially testable.
 */

import type { CoveritManifest } from "../schema/coverit-manifest.js";
import type { RegressionResult, RegressionFailure } from "./runner.js";

// ─── Public Types ───────────────────────────────────────────

export interface RegressionComparison {
  status: "all-passing" | "has-regressions" | "improved" | "no-baseline";
  currentPassing: number;
  currentTotal: number;
  /** Tests that were passing before but are now failing */
  newFailures: RegressionFailure[];
  /** Tests that were failing before but are now passing */
  newPasses: string[];
  /** Tests that were failing before and are still failing */
  existingFailures: RegressionFailure[];
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Compare current test results against the manifest baseline.
 *
 * The manifest stores aggregate test counts per module (expected vs current)
 * but does not store individual test names. Because of this, we compare
 * at the aggregate level for "new regression" detection:
 *
 *   - If the manifest had 0 test data, we return "no-baseline"
 *   - If current failures overlap with known baseline failure patterns,
 *     they are classified as "existing"
 *   - Any failures NOT in the baseline are "new regressions"
 *   - If total failures decreased compared to baseline, it is "improved"
 */
export function compareWithBaseline(
  current: RegressionResult,
  manifest: CoveritManifest,
): RegressionComparison {
  const baselineStats = extractBaselineStats(manifest);

  // No baseline data — either first run or manifest has no modules
  if (baselineStats.totalExpected === 0 && manifest.modules.length === 0) {
    return {
      status: "no-baseline",
      currentPassing: current.passed,
      currentTotal: current.totalTests,
      newFailures: [],
      newPasses: [],
      existingFailures: [],
    };
  }

  // Use the regression score from the manifest to infer baseline failure count.
  // regression score = (passing / total) * 100, so:
  //   baselineFailures = total - (score/100 * total)
  const baselineRegressionScore = manifest.score.breakdown.regression;
  const baselineTotalTests = baselineStats.totalExpected;
  const baselineFailureCount = baselineTotalTests > 0
    ? Math.round(baselineTotalTests * (1 - baselineRegressionScore / 100))
    : 0;

  // Classify current failures
  const { newFailures, existingFailures } = classifyFailures(
    current.failures,
    baselineFailureCount,
  );

  // Detect newly passing tests: if failures decreased, some were fixed
  const newPasses: string[] = [];
  if (current.failed < baselineFailureCount) {
    const fixedCount = baselineFailureCount - current.failed;
    // We don't have individual test names from the baseline, so generate
    // a synthetic description
    for (let i = 0; i < fixedCount; i++) {
      newPasses.push(`(${i + 1} of ${fixedCount} previously failing tests now pass)`);
    }
  }

  // Determine overall status
  const status = deriveStatus(current, newFailures, newPasses, baselineFailureCount);

  return {
    status,
    currentPassing: current.passed,
    currentTotal: current.totalTests,
    newFailures,
    newPasses,
    existingFailures,
  };
}

// ─── Internal Logic ─────────────────────────────────────────

interface BaselineStats {
  totalExpected: number;
  totalCurrent: number;
}

/**
 * Extract aggregate test counts from the manifest's module inventory.
 * These represent the last-known state of the project's test coverage.
 */
function extractBaselineStats(manifest: CoveritManifest): BaselineStats {
  let totalExpected = 0;
  let totalCurrent = 0;

  for (const mod of manifest.modules) {
    const testEntries = Object.values(mod.functionality.tests);
    for (const coverage of testEntries) {
      totalExpected += coverage.expected;
      totalCurrent += coverage.current;
    }
  }

  return { totalExpected, totalCurrent };
}

/**
 * Classify current failures into "new regressions" vs "pre-existing".
 *
 * Heuristic: if the baseline had N failures, we assume the first N
 * failures in the current run are pre-existing. Any beyond that count
 * are new regressions. This is imperfect (we lack per-test identity
 * across runs), but it is the best we can do with aggregate data.
 *
 * In practice this works well because:
 *   1. Most projects have 0 baseline failures (all tests pass)
 *   2. When failures exist, they tend to be stable (same tests fail)
 */
function classifyFailures(
  currentFailures: RegressionFailure[],
  baselineFailureCount: number,
): { newFailures: RegressionFailure[]; existingFailures: RegressionFailure[] } {
  if (baselineFailureCount === 0) {
    // Every current failure is a new regression
    return {
      newFailures: [...currentFailures],
      existingFailures: [],
    };
  }

  // Attribute up to baselineFailureCount failures as pre-existing
  const existingFailures = currentFailures.slice(0, baselineFailureCount);
  const newFailures = currentFailures.slice(baselineFailureCount);

  return { newFailures, existingFailures };
}

/**
 * Derive the comparison status from the classified results.
 */
function deriveStatus(
  current: RegressionResult,
  newFailures: RegressionFailure[],
  newPasses: string[],
  baselineFailureCount: number,
): RegressionComparison["status"] {
  // New regressions take priority — even if some tests were fixed,
  // breaking existing tests is a red flag
  if (newFailures.length > 0) {
    return "has-regressions";
  }

  // Fewer failures than before means the developer fixed something
  if (newPasses.length > 0 && current.failed < baselineFailureCount) {
    return "improved";
  }

  // All tests passing (or at least no new failures and same failure count)
  if (current.failed === 0) {
    return "all-passing";
  }

  // Same failures as before, nothing new broken
  if (current.failed <= baselineFailureCount) {
    return "all-passing";
  }

  return "has-regressions";
}
