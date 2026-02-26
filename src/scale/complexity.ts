/**
 * Coverit Scale — Complexity Classifier
 *
 * Classifies module complexity based on file count and line count.
 * Uses simple, deterministic thresholds — no AI required.
 *
 * Complexity tiers:
 *   low    — <500 lines AND <5 files
 *   medium — 500-2000 lines AND 5-15 files
 *   high   — >2000 lines OR >15 files
 *
 * The OR in "high" is intentional: a module with 50 tiny files is still
 * complex to reason about, and a single 3000-line file needs extensive testing.
 */

import type { Complexity } from "../schema/coverit-manifest.js";
import type { RawModule } from "./module-detector.js";

// ─── Thresholds ──────────────────────────────────────────────

const THRESHOLDS = {
  high: { lines: 2000, files: 15 },
  medium: { lines: 500, files: 5 },
} as const;

// ─── Core Logic ──────────────────────────────────────────────

/**
 * Classifies a module's complexity based on file count and line count.
 *
 * The classification is deliberately conservative — it biases toward
 * higher complexity to ensure adequate test coverage expectations.
 * Either metric exceeding the threshold triggers the higher tier.
 */
export function classifyComplexity(module: RawModule): Complexity {
  const { lines, files } = module;
  const fileCount = files.length;

  // High: either metric exceeds the high threshold
  if (lines > THRESHOLDS.high.lines || fileCount > THRESHOLDS.high.files) {
    return "high";
  }

  // Medium: either metric exceeds the medium threshold
  if (lines >= THRESHOLDS.medium.lines || fileCount >= THRESHOLDS.medium.files) {
    return "medium";
  }

  // Low: both metrics are below medium thresholds
  return "low";
}
