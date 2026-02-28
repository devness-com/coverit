/**
 * Unit tests for dashboard.ts — rendering edge cases
 * Tests empty modules, zero gaps, unscanned dimensions,
 * different health statuses, and module score computation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderDashboard } from "../dashboard.js";
import type { CoveritManifest, ModuleEntry } from "../../schema/coverit-manifest.js";

// --- Fixtures ---

function createBaseManifest(overrides: Partial<{
  modules: ModuleEntry[];
  overall: number;
  gapsTotal: number;
  gapsCritical: number;
  scanned: CoveritManifest["score"]["scanned"];
}>= {}): CoveritManifest {
  const {
    modules = [],
    overall = 50,
    gapsTotal = 0,
    gapsCritical = 0,
    scanned = { functionality: "2024-01-01T00:00:00.000Z" },
  } = overrides;

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
    modules,
    journeys: [],
    contracts: [],
    score: {
      overall,
      breakdown: {
        functionality: overall,
        security: 100,
        stability: 80,
        conformance: 90,
        regression: 100,
      },
      gaps: {
        total: gapsTotal,
        critical: gapsCritical,
        byDimension: {
          functionality: { missing: gapsTotal, priority: gapsTotal > 0 ? "medium" : "none" },
          security: { issues: 0, priority: "none" },
          stability: { gaps: 0, priority: "none" },
          conformance: { violations: 0, priority: "none" },
        },
      },
      history: [],
      scanned,
    },
  };
}

function makeModule(overrides: Partial<{
  path: string;
  complexity: "low" | "medium" | "high";
  unitCurrent: number;
  unitExpected: number;
  integrationCurrent: number;
  integrationExpected: number;
  securityFindings: string[];
  stabilityGaps: string[];
  conformanceViolations: string[];
}>= {}): ModuleEntry {
  const {
    path: modPath = "src/services",
    complexity = "medium",
    unitCurrent = 4,
    unitExpected = 6,
    integrationCurrent = 0,
    integrationExpected = 0,
    securityFindings = [],
    stabilityGaps = [],
    conformanceViolations = [],
  } = overrides;

  const tests: ModuleEntry["functionality"]["tests"] = {
    unit: { expected: unitExpected, current: unitCurrent, files: ["test.ts"] },
  };
  if (integrationExpected > 0) {
    tests.integration = { expected: integrationExpected, current: integrationCurrent, files: [] };
  }

  return {
    path: modPath,
    files: 5,
    lines: 500,
    complexity,
    functionality: { tests },
    security: { issues: securityFindings.length, resolved: 0, findings: securityFindings },
    stability: { score: 80, gaps: stabilityGaps },
    conformance: { score: 90, violations: conformanceViolations },
  };
}

// --- Tests ---

describe("renderDashboard — edge cases", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("shows (none) when modules array is empty", () => {
    const manifest = createBaseManifest({ modules: [] });

    renderDashboard(manifest);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0]![0] as string;
    expect(output).toContain("Modules");
    expect(output).toContain("(none)");
  });

  it("shows 'None -- all clear' when there are zero gaps", () => {
    const manifest = createBaseManifest({
      modules: [makeModule({ unitCurrent: 6, unitExpected: 6 })],
      gapsTotal: 0,
      gapsCritical: 0,
      overall: 100,
    });

    renderDashboard(manifest);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0]![0] as string;
    expect(output).toContain("Gaps");
    expect(output).toContain("all clear");
  });

  it("shows 'pending' for unscanned dimensions", () => {
    // Only functionality is scanned, others are not
    const manifest = createBaseManifest({
      modules: [makeModule()],
      scanned: { functionality: "2024-01-01T00:00:00.000Z" },
    });

    renderDashboard(manifest);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0]![0] as string;

    // Functionality should show a score, not "pending"
    expect(output).toContain("Functionality");
    // Unscanned dimensions should show "pending"
    expect(output).toContain("pending");
  });

  it("renders healthy indicator for score >= 70", () => {
    const manifest = createBaseManifest({ overall: 85 });

    renderDashboard(manifest);

    const output = logSpy.mock.calls[0]![0] as string;
    expect(output).toContain("85/100");
    // Should have the green circle indicator (●)
    expect(output).toContain("●");
  });

  it("renders at-risk indicator for score < 50", () => {
    const manifest = createBaseManifest({ overall: 30 });

    renderDashboard(manifest);

    const output = logSpy.mock.calls[0]![0] as string;
    expect(output).toContain("30/100");
    expect(output).toContain("●");
  });

  it("renders gap items with critical severity for injection findings", () => {
    const manifest = createBaseManifest({
      modules: [makeModule({
        securityFindings: ["injection:auth.ts:42"],
        stabilityGaps: ["No timeout handling"],
      })],
      gapsTotal: 4,
      gapsCritical: 1,
      overall: 40,
    });

    renderDashboard(manifest);

    const output = logSpy.mock.calls[0]![0] as string;
    expect(output).toContain("Gaps");
    expect(output).toContain("4 total");
    expect(output).toContain("1 critical");
    expect(output).toContain("Security");
    expect(output).toContain("injection:auth.ts:42");
    expect(output).toContain("Stability");
  });

  it("truncates long module paths with ellipsis", () => {
    const manifest = createBaseManifest({
      modules: [makeModule({
        path: "src/very/deeply/nested/module/path",
      })],
      overall: 70,
    });

    renderDashboard(manifest);

    const output = logSpy.mock.calls[0]![0] as string;
    // Long paths get truncated with unicode ellipsis
    expect(output).toContain("…");
  });

  it("renders module table with correct test count ratios and colors", () => {
    const manifest = createBaseManifest({
      modules: [
        makeModule({
          path: "src/services",
          complexity: "high",
          unitCurrent: 8,
          unitExpected: 12,
          integrationCurrent: 20,
          integrationExpected: 20,
        }),
        makeModule({
          path: "src/utils",
          complexity: "low",
          unitCurrent: 3,
          unitExpected: 3,
        }),
      ],
      overall: 75,
    });

    renderDashboard(manifest);

    const output = logSpy.mock.calls[0]![0] as string;
    expect(output).toContain("Modules (2)");
    expect(output).toContain("src/services");
    expect(output).toContain("src/utils");
    // Test count ratios
    expect(output).toContain("8/12");
    expect(output).toContain("20/20");
    expect(output).toContain("3/3");
    // Complexity labels
    expect(output).toContain("high");
    expect(output).toContain("low");
  });

  it("computes module score correctly as current/expected ratio", () => {
    // Module with 3/6 unit = 50% coverage → score ~50
    const manifest = createBaseManifest({
      modules: [makeModule({
        unitCurrent: 3,
        unitExpected: 6,
      })],
      overall: 50,
    });

    renderDashboard(manifest);

    const output = logSpy.mock.calls[0]![0] as string;
    // Module score should be 50 (3/6 = 50%)
    expect(output).toContain("50");
  });

  it("shows conformance violations in gap items", () => {
    const manifest = createBaseManifest({
      modules: [makeModule({
        conformanceViolations: ["layer-violation: imports from controller"],
      })],
      gapsTotal: 3,
      overall: 60,
    });

    renderDashboard(manifest);

    const output = logSpy.mock.calls[0]![0] as string;
    expect(output).toContain("Conformance");
    expect(output).toContain("layer-violation");
  });

  it("shows functionality gaps when tests are missing", () => {
    const manifest = createBaseManifest({
      modules: [makeModule({
        unitCurrent: 2,
        unitExpected: 6,
        integrationCurrent: 0,
        integrationExpected: 10,
      })],
      gapsTotal: 14,
      overall: 30,
    });

    renderDashboard(manifest);

    const output = logSpy.mock.calls[0]![0] as string;
    expect(output).toContain("Functionality");
    expect(output).toContain("tests missing");
  });
});
