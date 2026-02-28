/**
 * Unit tests for dashboard.ts
 * Tests renderDashboard with mocked console.log.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderDashboard } from "../dashboard.js";
import type { CoveritManifest } from "../../schema/coverit-manifest.js";

// --- Fixtures ---

function createManifest(): CoveritManifest {
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
    modules: [
      {
        path: "src/services",
        files: 5,
        lines: 500,
        complexity: "high",
        functionality: {
          tests: {
            unit: { expected: 12, current: 8, files: ["unit.test.ts"] },
            integration: { expected: 20, current: 15, files: ["int.test.ts"] },
          },
        },
        security: { issues: 1, resolved: 0, findings: ["injection:auth.ts:42"] },
        stability: { score: 75, gaps: ["No timeout handling in processPayment"] },
        conformance: { score: 85, violations: [] },
      },
      {
        path: "src/utils",
        files: 3,
        lines: 200,
        complexity: "low",
        functionality: {
          tests: {
            unit: { expected: 3, current: 3, files: ["utils.test.ts"] },
          },
        },
        security: { issues: 0, resolved: 0, findings: [] },
        stability: { score: 95, gaps: [] },
        conformance: { score: 100, violations: [] },
      },
    ],
    journeys: [],
    contracts: [],
    score: {
      overall: 72,
      breakdown: {
        functionality: 65,
        security: 75,
        stability: 80,
        conformance: 90,
        regression: 100,
      },
      gaps: {
        total: 10,
        critical: 1,
        byDimension: {
          functionality: { missing: 9, priority: "medium" },
          security: { issues: 1, priority: "medium" },
          stability: { gaps: 1, priority: "low" },
          conformance: { violations: 0, priority: "none" },
        },
      },
      history: [{ date: "2024-01-01", score: 60, scope: "first-time" }],
      scanned: {
        functionality: "2024-01-01T00:00:00.000Z",
        security: "2024-01-01T00:00:00.000Z",
        stability: "2024-01-01T00:00:00.000Z",
        conformance: "2024-01-01T00:00:00.000Z",
      },
    },
  };
}

// --- Tests ---

describe("renderDashboard", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("renders dashboard with header, dimensions, gaps, and module table", () => {
    const manifest = createManifest();

    renderDashboard(manifest);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0]![0] as string;

    // Header — score should appear
    expect(output).toContain("72/100");
    expect(output).toContain("coverit");

    // Dimensions section
    expect(output).toContain("Dimensions");
    expect(output).toContain("Functionality");
    expect(output).toContain("Security");
    expect(output).toContain("Stability");
    expect(output).toContain("Conformance");
    expect(output).toContain("Regression");

    // Gaps section
    expect(output).toContain("Gaps");
    expect(output).toContain("10 total");

    // Module table
    expect(output).toContain("Modules");
    expect(output).toContain("src/services");
    expect(output).toContain("src/utils");
  });
});
