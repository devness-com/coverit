/**
 * Coverit Scale — Expected Test Counts
 *
 * Calculates the expected number of tests per module per test type
 * using the Diamond testing strategy defaults from schema/defaults.ts.
 *
 * The Diamond strategy inverts the traditional test pyramid:
 *   Integration (~50%) > Unit (~20%) > API (~15%) > E2E (~10%) > Contract (~5%)
 *
 * This is the baseline calculation using complexity-indexed lookup tables.
 * AI-based refinement (adjusting counts based on actual public API surface,
 * endpoint count, etc.) happens later in the pipeline.
 */

import type { Complexity, FunctionalTestType } from "../schema/coverit-manifest.js";
import { EXPECTED_TESTS_BY_COMPLEXITY } from "../schema/defaults.js";
import type { RawModule } from "./module-detector.js";

// ─── Core Logic ──────────────────────────────────────────────

/**
 * Returns the expected test count for each functional test type
 * based on the module's complexity classification.
 *
 * The counts come directly from EXPECTED_TESTS_BY_COMPLEXITY defaults.
 * Returns a new object (not a reference to the shared constant).
 */
export function calculateExpectedTests(
  _module: RawModule,
  complexity: Complexity,
): Record<FunctionalTestType, number> {
  const defaults = EXPECTED_TESTS_BY_COMPLEXITY[complexity];

  // Return a shallow copy to prevent mutation of the shared constant
  return { ...defaults };
}
