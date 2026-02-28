/**
 * Unit tests for scorer.ts — edge cases
 * Tests rescoreManifest with empty history, empty modules,
 * scanned state preservation, and various score values.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../scoring/engine.js", () => ({
  calculateScore: vi.fn(),
}));

import { rescoreManifest } from "../scorer.js";
import { calculateScore } from "../../scoring/engine.js";
import type { CoveritManifest, ScoreResult } from "../../schema/coverit-manifest.js";

// --- Fixtures ---

function createManifest(overrides: Partial<{
  historyLength: number;
  modules: CoveritManifest["modules"];
  scanned: CoveritManifest["score"]["scanned"];
  overall: number;
}>= {}): CoveritManifest {
  const {
    historyLength = 0,
    modules,
    scanned,
    overall = 50,
  } = overrides;

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
    modules: modules ?? [
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
      overall,
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
      scanned,
    },
  };
}

function createScoreResult(overall: number): ScoreResult {
  return {
    overall,
    breakdown: {
      functionality: overall,
      security: 100,
      stability: 80,
      conformance: 90,
      regression: 100,
    },
    gaps: {
      total: 0,
      critical: 0,
      byDimension: {
        functionality: { missing: 0, priority: "none" },
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

describe("rescoreManifest — edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates first history entry when history is empty", () => {
    const manifest = createManifest({ historyLength: 0 });
    const scoreResult = createScoreResult(65);
    vi.mocked(calculateScore).mockReturnValue(scoreResult);

    const result = rescoreManifest(manifest);

    expect(result.score.history).toHaveLength(1);
    expect(result.score.history[0]!.scope).toBe("measure");
    expect(result.score.history[0]!.score).toBe(65);
    expect(result.score.history[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("always sets functionality as scanned before calling calculateScore", () => {
    const manifest = createManifest({ scanned: undefined });
    const scoreResult = createScoreResult(50);
    vi.mocked(calculateScore).mockReturnValue(scoreResult);

    rescoreManifest(manifest);

    expect(calculateScore).toHaveBeenCalledTimes(1);
    const calledManifest = vi.mocked(calculateScore).mock.calls[0]![0];
    // Even when no scanned state existed, functionality should be set
    expect(calledManifest.score.scanned).toBeDefined();
    expect(calledManifest.score.scanned!.functionality).toBeDefined();
    // Should be an ISO datetime string
    expect(calledManifest.score.scanned!.functionality).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("preserves existing scanned dimensions while adding functionality", () => {
    const existingScanned = {
      security: "2024-01-15T00:00:00.000Z",
      stability: "2024-01-16T00:00:00.000Z",
    };
    const manifest = createManifest({ scanned: existingScanned });
    const scoreResult = createScoreResult(60);
    vi.mocked(calculateScore).mockReturnValue(scoreResult);

    rescoreManifest(manifest);

    const calledManifest = vi.mocked(calculateScore).mock.calls[0]![0];
    // Existing scanned dimensions should be preserved
    expect(calledManifest.score.scanned!.security).toBe("2024-01-15T00:00:00.000Z");
    expect(calledManifest.score.scanned!.stability).toBe("2024-01-16T00:00:00.000Z");
    // functionality should also be present
    expect(calledManifest.score.scanned!.functionality).toBeDefined();
  });

  it("does not mutate the original manifest", () => {
    const manifest = createManifest({ historyLength: 1 });
    const originalUpdatedAt = manifest.updatedAt;
    const originalHistoryLength = manifest.score.history.length;
    const scoreResult = createScoreResult(90);
    vi.mocked(calculateScore).mockReturnValue(scoreResult);

    const result = rescoreManifest(manifest);

    // Original should be unchanged
    expect(manifest.updatedAt).toBe(originalUpdatedAt);
    expect(manifest.score.history).toHaveLength(originalHistoryLength);
    // Result should be different
    expect(result.updatedAt).not.toBe(originalUpdatedAt);
    expect(result.score.history.length).toBeGreaterThan(originalHistoryLength);
  });

  it("handles score of 0 correctly", () => {
    const manifest = createManifest();
    const scoreResult = createScoreResult(0);
    vi.mocked(calculateScore).mockReturnValue(scoreResult);

    const result = rescoreManifest(manifest);

    expect(result.score.overall).toBe(0);
    expect(result.score.history[0]!.score).toBe(0);
  });

  it("handles perfect score of 100 correctly", () => {
    const manifest = createManifest();
    const scoreResult = createScoreResult(100);
    vi.mocked(calculateScore).mockReturnValue(scoreResult);

    const result = rescoreManifest(manifest);

    expect(result.score.overall).toBe(100);
    expect(result.score.history[0]!.score).toBe(100);
  });

  it("uses score result breakdown and gaps in the returned manifest", () => {
    const manifest = createManifest();
    const scoreResult = createScoreResult(72);
    scoreResult.breakdown.functionality = 55;
    scoreResult.breakdown.security = 80;
    scoreResult.gaps.total = 5;
    scoreResult.gaps.critical = 2;
    vi.mocked(calculateScore).mockReturnValue(scoreResult);

    const result = rescoreManifest(manifest);

    expect(result.score.breakdown.functionality).toBe(55);
    expect(result.score.breakdown.security).toBe(80);
    expect(result.score.gaps.total).toBe(5);
    expect(result.score.gaps.critical).toBe(2);
  });
});
