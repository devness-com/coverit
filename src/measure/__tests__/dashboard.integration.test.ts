/**
 * Integration tests for dashboard.ts
 * Tests renderDashboard with real chalk rendering and various manifest states.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderDashboard } from "../dashboard.js";
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
        unit: { expected: 6, current: 4, files: ["test.ts"] },
      },
    },
    security: { issues: 0, resolved: 0, findings: [] },
    stability: { score: 80, gaps: [] },
    conformance: { score: 90, violations: [] },
    ...overrides,
  };
}

function createManifest(overrides: Partial<CoveritManifest> = {}): CoveritManifest {
  return {
    version: 1,
    createdAt: "2024-01-01",
    updatedAt: "2024-01-02",
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
    modules: [
      makeModule({
        path: "src/services",
        complexity: "high",
        functionality: {
          tests: {
            unit: { expected: 12, current: 8, files: ["unit.test.ts"] },
            integration: { expected: 20, current: 10, files: ["int.test.ts"] },
            api: { expected: 8, current: 3, files: [] },
          },
        },
        security: { issues: 2, resolved: 0, findings: ["injection:auth.ts:42", "xss:form.ts:10"] },
        stability: { score: 60, gaps: ["No timeout handling", "Missing retry logic"] },
        conformance: { score: 70, violations: ["layer-violation: controller imports repo"] },
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
    ],
    journeys: [],
    contracts: [],
    score: {
      overall: 58,
      breakdown: {
        functionality: 45,
        security: 25,
        stability: 65,
        conformance: 75,
        regression: 100,
      },
      gaps: {
        total: 22,
        critical: 5,
        byDimension: {
          functionality: { missing: 19, priority: "high" },
          security: { issues: 2, priority: "high" },
          stability: { gaps: 2, priority: "medium" },
          conformance: { violations: 1, priority: "low" },
        },
      },
      history: [
        { date: "2024-01-01", score: 40, scope: "first-time" },
        { date: "2024-01-02", score: 58, scope: "re-analysis" },
      ],
      scanned: {
        functionality: "2024-01-01T00:00:00.000Z",
        security: "2024-01-01T00:00:00.000Z",
        stability: "2024-01-01T00:00:00.000Z",
        conformance: "2024-01-01T00:00:00.000Z",
      },
    },
    ...overrides,
  };
}

// --- Tests ---

describe("dashboard integration", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("renders complete dashboard with all sections for a manifest with gaps", () => {
    const manifest = createManifest();

    renderDashboard(manifest);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0]![0] as string;

    // Header shows overall score
    expect(output).toContain("58/100");
    expect(output).toContain("coverit");

    // Dimensions section shows all 5 dimensions
    expect(output).toContain("Dimensions");
    expect(output).toContain("Functionality");
    expect(output).toContain("Security");
    expect(output).toContain("Stability");
    expect(output).toContain("Conformance");
    expect(output).toContain("Regression");

    // Scanned dimensions should show their score
    expect(output).toContain("45/100");
    expect(output).toContain("25/100");

    // Unscanned dimension (regression) should show "pending"
    expect(output).toContain("pending");

    // Gaps section
    expect(output).toContain("Gaps");
    expect(output).toContain("22 total");

    // Gap items from collectGapItems
    expect(output).toContain("Security");
    expect(output).toContain("injection:auth.ts:42");
    expect(output).toContain("Stability");

    // Module table
    expect(output).toContain("Modules");
    expect(output).toContain("src/services");
    expect(output).toContain("src/utils");
    expect(output).toContain("high");
    expect(output).toContain("low");
  });

  it("renders dashboard with zero gaps and no modules", () => {
    const manifest = createManifest({
      modules: [],
      score: {
        overall: 100,
        breakdown: {
          functionality: 100,
          security: 100,
          stability: 100,
          conformance: 100,
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
      },
    });

    renderDashboard(manifest);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0]![0] as string;

    // Header shows perfect score
    expect(output).toContain("100/100");

    // Gaps section shows "None -- all clear"
    expect(output).toContain("None");
    expect(output).toContain("all clear");

    // Module table shows "(none)"
    expect(output).toContain("(none)");
  });

  it("renders module table with correct test type columns", () => {
    const manifest = createManifest();

    renderDashboard(manifest);

    const output = logSpy.mock.calls[0]![0] as string;

    // Column headers
    expect(output).toContain("Unit");
    expect(output).toContain("Intg");
    expect(output).toContain("API");
    expect(output).toContain("E2E");
    expect(output).toContain("Cntr");
    expect(output).toContain("Score");
    expect(output).toContain("Cmplx");

    // src/services should show test ratio for unit (8/12)
    expect(output).toContain("8/12");
    // src/utils should show 3/3 for unit
    expect(output).toContain("3/3");
  });

  it("handles unscanned dimensions showing pending", () => {
    const manifest = createManifest({
      score: {
        ...createManifest().score,
        scanned: {
          functionality: "2024-01-01T00:00:00.000Z",
          // Only functionality scanned
        },
      },
    });

    renderDashboard(manifest);

    const output = logSpy.mock.calls[0]![0] as string;

    // Functionality should show a score
    expect(output).toContain("45/100");

    // Unscanned dimensions should show "pending"
    const pendingCount = (output.match(/pending/g) || []).length;
    expect(pendingCount).toBe(4); // security, stability, conformance, regression
  });

  it("truncates long module paths in the table", () => {
    const manifest = createManifest({
      modules: [
        makeModule({
          path: "src/services/very/deeply/nested/module",
          complexity: "medium",
        }),
      ],
    });

    renderDashboard(manifest);

    const output = logSpy.mock.calls[0]![0] as string;

    // The module path should be truncated (colModule = 20)
    // "src/services/very/deeply/nested/module" is 38 chars > 20
    // So it should be truncated to 19 chars + ellipsis
    expect(output).toContain("\u2026"); // Ellipsis character
  });
});
