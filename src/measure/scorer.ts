/**
 * Scorer — Recalculates all quality scores from manifest data
 *
 * Takes a manifest (with test counts already updated by the scanner),
 * runs it through the scoring engine to produce per-dimension and
 * overall scores, rebuilds the gap summary, and appends a history entry.
 *
 * Pure computation — no filesystem or AI calls.
 */

import type {
  CoveritManifest,
  ScoreHistoryEntry,
} from "../schema/coverit-manifest.js";
import { MAX_SCORE_HISTORY } from "../schema/defaults.js";
import { calculateScore } from "../scoring/engine.js";

// ─── Public API ─────────────────────────────────────────────

/**
 * Recalculate all scores from the manifest's current module data.
 *
 * Mutates nothing — returns a new manifest with updated scores.
 *
 * Flow:
 *   1. Run the scoring engine to get breakdown, overall, and gaps
 *   2. Append a new history entry with today's score
 *   3. Trim history to MAX_SCORE_HISTORY entries
 */
export function rescoreManifest(
  manifest: CoveritManifest,
  scope: string = "measure",
): CoveritManifest {
  // Ensure scanned includes functionality (measure always rescans test files)
  const now = new Date().toISOString();
  const existingScanned = manifest.score.scanned ?? {};
  const scanned = { ...existingScanned, functionality: now };

  // Inject scanned state before calculating so the engine can use it
  const manifestWithScanned: CoveritManifest = {
    ...manifest,
    score: { ...manifest.score, scanned },
  };

  // The scoring engine computes breakdown, overall, and gaps
  // but preserves existing history — we append a new entry below
  const scoreResult = calculateScore(manifestWithScanned);

  const history = appendHistory(
    manifest.score.history,
    scoreResult.overall,
    scope,
  );

  return {
    ...manifest,
    updatedAt: now,
    score: {
      ...scoreResult,
      history,
    },
  };
}

// ─── History Management ─────────────────────────────────────

/**
 * Append a new score entry to history, keeping at most MAX_SCORE_HISTORY entries.
 * Most recent entries are preserved when trimming.
 */
function appendHistory(
  existing: ScoreHistoryEntry[],
  score: number,
  scope: string,
): ScoreHistoryEntry[] {
  const entry: ScoreHistoryEntry = {
    date: new Date().toISOString(),
    score,
    scope,
  };

  const updated = [...existing, entry];

  // Trim to max history length, keeping the most recent entries
  if (updated.length > MAX_SCORE_HISTORY) {
    return updated.slice(updated.length - MAX_SCORE_HISTORY);
  }

  return updated;
}
