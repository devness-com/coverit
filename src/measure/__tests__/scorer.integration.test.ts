/**
 * Integration tests for scorer.ts
 * Tests rescoreManifest using the real scoring engine (no mocks).
 */
import { describe, it, expect } from "vitest";
import { rescoreManifest } from "../scorer.js";
import type { CoveritManifest, ModuleEntry } from "../../schema/coverit-manifest.js";
import { DEFAULT_DIMENSIONS } from "../../schema/defaults.js";

// --- Helpers ---

function makeModule(overrides: Partial<ModuleEntry> & { path: string }): ModuleEntry {
  return {
    files: 5,
    lines: 500,
    complexity: "medium",
    functionality: {
      tests: {
        unit: { expected: 6, current: 6, files: ["test.ts"] },
        integration: { expected: 10, current: 10, files: ["int.test.ts"] },
      },
    },
    security: { issues: 0, resolved: 0, findings: [] },
    stability: { score: 100, gaps: [] },
    conformance: { score: 100, violations: [] },
    ...overrides,
  };
}

function createManifest(modules: ModuleEntry[], history: CoveritManifest["score"]["history"] = []): CoveritManifest {
  return {
    version: 1,
    createdAt: "2024-01-01",
    updatedAt: "2024-01-01",
    project: {
      name: "test-project",
      root: "/tmp/test",
      language: "typescript",
      framework: "nestjs",
      testFramework: "vitest",
      sourceFiles: 20,
      sourceLines: 3000,
    },
    dimensions: DEFAULT_DIMENSIONS,
    modules,
    journeys: [],
    contracts: [],
    score: {
      overall: 0,
      breakdown: {
        functionality: 0,
        security: 0,
        stability: 0,
        conformance: 0,
        regression: 0,
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
      history,
    },
  };
}

// --- Tests ---

describe("scorer integration", () => {
  it("produces correct scores for modules with full test coverage", () => {
    const modules = [
      makeModule({
        path: "src/services",
        complexity: "high",
        functionality: {
          tests: {
            unit: { expected: 12, current: 12, files: ["unit.test.ts"] },
            integration: { expected: 20, current: 20, files: ["int.test.ts"] },
          },
        },
        stability: { score: 100, gaps: [] },
        conformance: { score: 100, violations: [] },
      }),
      makeModule({
        path: "src/utils",
        complexity: "low",
        functionality: {
          tests: {
            unit: { expected: 3, current: 3, files: ["utils.test.ts"] },
          },
        },
      }),
    ];

    const manifest = createManifest(modules);
    const result = rescoreManifest(manifest);

    // Functionality should be 100 (all tests met)
    expect(result.score.breakdown.functionality).toBe(100);

    // Security should be 100 (no findings)
    expect(result.score.breakdown.security).toBe(100);

    // Overall should be high since all dimensions are perfect
    // Only functionality is scanned (rescoreManifest sets it)
    expect(result.score.overall).toBe(100);

    // Gaps should be 0
    expect(result.score.gaps.total).toBe(0);
    expect(result.score.gaps.critical).toBe(0);
  });

  it("handles modules with partial coverage and security findings", () => {
    const modules = [
      makeModule({
        path: "src/services",
        complexity: "high",
        functionality: {
          tests: {
            unit: { expected: 12, current: 6, files: ["unit.test.ts"] },
            integration: { expected: 20, current: 5, files: ["int.test.ts"] },
          },
        },
        security: { issues: 1, resolved: 0, findings: ["injection:auth.ts:42"] },
        stability: { score: 60, gaps: ["No error handling"] },
        conformance: { score: 70, violations: ["layer-violation"] },
      }),
    ];

    const manifest = createManifest(modules);
    const result = rescoreManifest(manifest);

    // Functionality should be less than 100 (partial coverage)
    expect(result.score.breakdown.functionality).toBeLessThan(100);
    expect(result.score.breakdown.functionality).toBeGreaterThan(0);

    // Security should be low due to injection finding (critical cap at 25)
    expect(result.score.breakdown.security).toBeLessThanOrEqual(25);

    // Gaps should reflect missing tests
    expect(result.score.gaps.total).toBeGreaterThan(0);
    expect(result.score.gaps.byDimension.functionality.missing).toBeGreaterThan(0);
    expect(result.score.gaps.byDimension.security.issues).toBe(1);
  });

  it("appends history entry and preserves existing entries", () => {
    const existingHistory = [
      { date: "2024-01-01", score: 40, scope: "first-time" },
      { date: "2024-01-15", score: 55, scope: "re-analysis" },
    ];

    const modules = [
      makeModule({
        path: "src/services",
        complexity: "medium",
      }),
    ];

    const manifest = createManifest(modules, existingHistory);
    const result = rescoreManifest(manifest);

    // History should have 3 entries: 2 existing + 1 new
    expect(result.score.history).toHaveLength(3);

    // First two should be the originals
    expect(result.score.history[0]!.scope).toBe("first-time");
    expect(result.score.history[0]!.score).toBe(40);
    expect(result.score.history[1]!.scope).toBe("re-analysis");
    expect(result.score.history[1]!.score).toBe(55);

    // Last should be new "measure" entry with current ISO timestamp
    const newEntry = result.score.history[2]!;
    expect(newEntry.scope).toBe("measure");
    expect(newEntry.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(newEntry.score).toBe(result.score.overall);
  });

  it("updatedAt is set to a full ISO timestamp", () => {
    const modules = [makeModule({ path: "src/services" })];
    const manifest = createManifest(modules);

    const result = rescoreManifest(manifest);

    expect(result.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // Should be a valid date
    expect(new Date(result.updatedAt).toString()).not.toBe("Invalid Date");
  });

  it("sets scanned.functionality timestamp in the result", () => {
    const modules = [makeModule({ path: "src/services" })];
    const manifest = createManifest(modules);

    const result = rescoreManifest(manifest);

    expect(result.score.scanned).toBeDefined();
    expect(result.score.scanned!.functionality).toBeDefined();
    // Should be an ISO timestamp
    expect(result.score.scanned!.functionality).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
