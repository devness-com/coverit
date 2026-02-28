/**
 * Unit tests for scorer.ts
 * Tests rescoreManifest with mocked scoring engine.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../scoring/engine.js", () => ({
  calculateScore: vi.fn(),
}));

import { rescoreManifest } from "../scorer.js";
import { calculateScore } from "../../scoring/engine.js";
import type { CoveritManifest, ScoreResult } from "../../schema/coverit-manifest.js";
import { MAX_SCORE_HISTORY } from "../../schema/defaults.js";

// --- Fixtures ---

function createManifest(historyLength = 0): CoveritManifest {
  const history = Array.from({ length: historyLength }, (_, i) => ({
    date: `2024-01-${String(i + 1).padStart(2, "0")}`,
    score: 50 + i,
    scope: "test",
  }));

  return {
    version: 1,
    createdAt: "2024-01-01",
    updatedAt: "2024-01-01",
    project: {
      name: "test",
      root: "/tmp/test",
      language: "typescript",
      framework: "nestjs",
      testFramework: "vitest",
      sourceFiles: 10,
      sourceLines: 1000,
    },
    dimensions: {
      functionality: {
        enabled: true,
        weight: 0.35,
        targets: {
          unit: { coverage: "critical-paths" },
          integration: { coverage: "all-boundaries" },
          api: { coverage: "all-endpoints" },
          e2e: { coverage: "critical-journeys" },
          contract: { coverage: "all-public-apis" },
        },
      },
      security: { enabled: true, weight: 0.25, checks: [] },
      stability: { enabled: true, weight: 0.15, checks: [] },
      conformance: { enabled: true, weight: 0.15, checks: [] },
      regression: { enabled: true, weight: 0.10, strategy: "all-existing-tests-pass" },
    },
    modules: [
      {
        path: "src/services",
        files: 5,
        lines: 500,
        complexity: "medium",
        functionality: {
          tests: {
            unit: { expected: 6, current: 4, files: ["test.ts"] },
          },
        },
        security: { issues: 0, resolved: 0, findings: [] },
        stability: { score: 80, gaps: [] },
        conformance: { score: 90, violations: [] },
      },
    ],
    journeys: [],
    contracts: [],
    score: {
      overall: 50,
      breakdown: {
        functionality: 50,
        security: 100,
        stability: 80,
        conformance: 90,
        regression: 100,
      },
      gaps: {
        total: 2,
        critical: 0,
        byDimension: {
          functionality: { missing: 2, priority: "medium" },
          security: { issues: 0, priority: "none" },
          stability: { gaps: 0, priority: "none" },
          conformance: { violations: 0, priority: "none" },
        },
      },
      history,
    },
  };
}

function createScoreResult(overall: number): ScoreResult {
  return {
    overall,
    breakdown: {
      functionality: 67,
      security: 100,
      stability: 80,
      conformance: 90,
      regression: 100,
    },
    gaps: {
      total: 2,
      critical: 0,
      byDimension: {
        functionality: { missing: 2, priority: "medium" },
        security: { issues: 0, priority: "none" },
        stability: { gaps: 0, priority: "none" },
        conformance: { violations: 0, priority: "none" },
      },
    },
    history: [],
    scanned: { functionality: "2024-01-01T00:00:00.000Z" },
  };
}

// --- Tests ---

describe("rescoreManifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("produces updated manifest with new scores and a history entry appended", () => {
    const manifest = createManifest(1);
    const scoreResult = createScoreResult(75);
    vi.mocked(calculateScore).mockReturnValue(scoreResult);

    const result = rescoreManifest(manifest);

    // Should have called calculateScore with functionality scanned set
    expect(calculateScore).toHaveBeenCalledTimes(1);
    const calledWith = vi.mocked(calculateScore).mock.calls[0]![0];
    expect(calledWith.score.scanned!.functionality).toBeDefined();

    // Result should have updated overall score
    expect(result.score.overall).toBe(75);
    expect(result.score.breakdown.functionality).toBe(67);

    // History should have the original entry + new one
    expect(result.score.history).toHaveLength(2);
    expect(result.score.history[0]!.scope).toBe("test"); // Original
    expect(result.score.history[1]!.scope).toBe("measure"); // New entry
    expect(result.score.history[1]!.score).toBe(75);

    // updatedAt should be a full ISO timestamp string
    expect(result.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("trims history to MAX_SCORE_HISTORY keeping most recent entries", () => {
    const manifest = createManifest(MAX_SCORE_HISTORY);
    const scoreResult = createScoreResult(80);
    vi.mocked(calculateScore).mockReturnValue(scoreResult);

    const result = rescoreManifest(manifest);

    // Should be exactly MAX_SCORE_HISTORY (original was full, new one added, then trimmed)
    expect(result.score.history).toHaveLength(MAX_SCORE_HISTORY);

    // Last entry should be the new "measure" entry
    const lastEntry = result.score.history[result.score.history.length - 1]!;
    expect(lastEntry.scope).toBe("measure");
    expect(lastEntry.score).toBe(80);

    // First entry should NOT be the original first entry (it was trimmed)
    expect(result.score.history[0]!.date).not.toBe("2024-01-01");
  });
});
