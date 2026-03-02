/**
 * Unit tests for schema/coverit-manifest.ts
 * Validates that the TypeScript interfaces/types from the manifest schema
 * are structurally correct when used to build manifest objects.
 */
import { describe, it, expect } from "vitest";

import type {
  CoveritManifest,
  ManifestProject,
  DimensionConfig,
  ModuleEntry,
  JourneyEntry,
  ContractEntry,
  ScoreResult,
  ModuleFunctionality,
  ModuleSecurity,
  ModuleStability,
  ModuleConformance,
  CriticalFileEntry,
  TestCoverage,
  FunctionalTestType,
  Complexity,
  SecurityCheck,
  StabilityCheck,
  ConformanceCheck,
  Dimension,
  CoveritScope,
  ScopeDepth,
  GapSummary,
  ScoreHistoryEntry,
} from "../coverit-manifest.js";

import { DEFAULT_DIMENSIONS } from "../defaults.js";

// ─── Helpers ─────────────────────────────────────────────────

function makeMinimalProject(): ManifestProject {
  return {
    name: "test-project",
    root: "/tmp/test",
    language: "typescript",
    framework: "hono",
    testFramework: "vitest",
    sourceFiles: 10,
    sourceLines: 500,
  };
}

function makeMinimalScore(): ScoreResult {
  return {
    overall: 75,
    breakdown: {
      functionality: 80,
      security: 70,
      stability: 65,
      conformance: 90,
      regression: 100,
    },
    gaps: {
      total: 5,
      critical: 1,
      byDimension: {
        functionality: { missing: 3, priority: "high" },
        security: { issues: 1, priority: "critical" },
        stability: { gaps: 1, priority: "medium" },
        conformance: { violations: 0, priority: "low" },
      },
    },
    history: [],
  };
}

function makeMinimalModule(): ModuleEntry {
  return {
    path: "src/services",
    files: 5,
    lines: 300,
    complexity: "medium",
    functionality: { tests: {} },
    security: { issues: 0, resolved: 0, findings: [] },
    stability: { score: 80, gaps: [] },
    conformance: { score: 90, violations: [] },
  };
}

function makeMinimalManifest(): CoveritManifest {
  return {
    version: 1,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    project: makeMinimalProject(),
    dimensions: DEFAULT_DIMENSIONS,
    modules: [],
    journeys: [],
    contracts: [],
    score: makeMinimalScore(),
  };
}

// ─── CoveritManifest Structure ───────────────────────────────

describe("CoveritManifest structure", () => {
  it("can be constructed with all required fields", () => {
    const manifest = makeMinimalManifest();
    expect(manifest.version).toBe(1);
    expect(manifest.createdAt).toBeTruthy();
    expect(manifest.updatedAt).toBeTruthy();
    expect(manifest.project).toBeDefined();
    expect(manifest.dimensions).toBeDefined();
    expect(manifest.modules).toEqual([]);
    expect(manifest.journeys).toEqual([]);
    expect(manifest.contracts).toEqual([]);
    expect(manifest.score).toBeDefined();
  });

  it("accepts modules with full test coverage data", () => {
    const manifest = makeMinimalManifest();
    const mod: ModuleEntry = {
      ...makeMinimalModule(),
      functionality: {
        tests: {
          unit: { expected: 6, current: 4, files: ["test/unit.test.ts"] },
          integration: { expected: 10, current: 8, files: ["test/int.test.ts"] },
        },
      },
    };
    manifest.modules.push(mod);

    expect(manifest.modules).toHaveLength(1);
    expect(manifest.modules[0].functionality.tests.unit?.expected).toBe(6);
    expect(manifest.modules[0].functionality.tests.unit?.current).toBe(4);
    expect(manifest.modules[0].functionality.tests.integration?.files).toHaveLength(1);
  });

  it("accepts journey entries with steps and coverage", () => {
    const manifest = makeMinimalManifest();
    const journey: JourneyEntry = {
      id: "j1",
      name: "User Registration Flow",
      steps: ["Sign up", "Verify email", "Complete profile"],
      covered: true,
      testFile: "e2e/registration.spec.ts",
    };
    manifest.journeys.push(journey);

    expect(manifest.journeys).toHaveLength(1);
    expect(manifest.journeys[0].steps).toHaveLength(3);
    expect(manifest.journeys[0].covered).toBe(true);
    expect(manifest.journeys[0].testFile).toBeTruthy();
  });

  it("accepts contract entries with HTTP method and schemas", () => {
    const manifest = makeMinimalManifest();
    const contract: ContractEntry = {
      endpoint: "POST /api/users",
      method: "POST",
      requestSchema: "CreateUserDto",
      responseSchema: "UserResponse",
      covered: false,
      testFile: null,
    };
    manifest.contracts.push(contract);

    expect(manifest.contracts).toHaveLength(1);
    expect(manifest.contracts[0].method).toBe("POST");
    expect(manifest.contracts[0].covered).toBe(false);
    expect(manifest.contracts[0].testFile).toBeNull();
  });
});

// ─── ManifestProject ─────────────────────────────────────────

describe("ManifestProject structure", () => {
  it("stores project metadata with all required fields", () => {
    const project = makeMinimalProject();
    expect(project.name).toBe("test-project");
    expect(project.root).toBe("/tmp/test");
    expect(project.language).toBe("typescript");
    expect(project.framework).toBe("hono");
    expect(project.testFramework).toBe("vitest");
    expect(project.sourceFiles).toBe(10);
    expect(project.sourceLines).toBe(500);
  });

  it("ManifestProject accepts lastScanCommit field", () => {
    const project: ManifestProject = {
      name: "test",
      root: "/test",
      language: "typescript",
      framework: "none",
      testFramework: "vitest",
      sourceFiles: 10,
      sourceLines: 500,
      lastScanCommit: "abc123def456",
    };
    expect(project.lastScanCommit).toBe("abc123def456");
  });

  it("ManifestProject allows undefined lastScanCommit", () => {
    const project: ManifestProject = {
      name: "test",
      root: "/test",
      language: "typescript",
      framework: "none",
      testFramework: "vitest",
      sourceFiles: 10,
      sourceLines: 500,
    };
    expect(project.lastScanCommit).toBeUndefined();
  });
});

// ─── ModuleEntry ─────────────────────────────────────────────

describe("ModuleEntry structure", () => {
  it("supports all complexity levels", () => {
    const complexities: Complexity[] = ["low", "medium", "high"];
    for (const complexity of complexities) {
      const mod = { ...makeMinimalModule(), complexity };
      expect(mod.complexity).toBe(complexity);
    }
  });

  it("supports optional critical file entries for high-complexity modules", () => {
    const criticalFile: CriticalFileEntry = {
      file: "src/services/booking.service.ts",
      methods: 15,
      lines: 450,
      tests: { unit: 3, integration: 5 },
      securityFlags: ["injection", "auth-bypass"],
      criticalPaths: ["processPayment", "cancelBooking"],
    };
    const mod: ModuleEntry = {
      ...makeMinimalModule(),
      complexity: "high",
      critical: [criticalFile],
    };

    expect(mod.critical).toHaveLength(1);
    expect(mod.critical![0].methods).toBe(15);
    expect(mod.critical![0].securityFlags).toContain("injection");
    expect(mod.critical![0].criticalPaths).toContain("processPayment");
    expect(mod.critical![0].tests.unit).toBe(3);
  });

  it("tracks security findings as typed strings", () => {
    const mod: ModuleEntry = {
      ...makeMinimalModule(),
      security: {
        issues: 2,
        resolved: 1,
        findings: ["injection:booking.service.ts:42", "xss:template.ts:10"],
      },
    };

    expect(mod.security.issues).toBe(2);
    expect(mod.security.resolved).toBe(1);
    expect(mod.security.findings).toHaveLength(2);
    expect(mod.security.findings[0]).toContain("injection");
  });
});

// ─── ScoreResult ─────────────────────────────────────────────

describe("ScoreResult structure", () => {
  it("includes overall score and per-dimension breakdown", () => {
    const score = makeMinimalScore();
    expect(score.overall).toBe(75);
    expect(score.breakdown.functionality).toBe(80);
    expect(score.breakdown.security).toBe(70);
    expect(score.breakdown.stability).toBe(65);
    expect(score.breakdown.conformance).toBe(90);
    expect(score.breakdown.regression).toBe(100);
  });

  it("includes gap summary with per-dimension details", () => {
    const score = makeMinimalScore();
    expect(score.gaps.total).toBe(5);
    expect(score.gaps.critical).toBe(1);
    expect(score.gaps.byDimension.functionality.missing).toBe(3);
    expect(score.gaps.byDimension.security.issues).toBe(1);
    expect(score.gaps.byDimension.stability.gaps).toBe(1);
    expect(score.gaps.byDimension.conformance.violations).toBe(0);
  });

  it("supports optional scanned dimension tracking", () => {
    const score: ScoreResult = {
      ...makeMinimalScore(),
      scanned: {
        functionality: "2024-01-15",
        security: "2024-01-15",
      },
    };

    expect(score.scanned).toBeDefined();
    expect(score.scanned!.functionality).toBe("2024-01-15");
    expect(score.scanned!.security).toBe("2024-01-15");
    expect(score.scanned!.stability).toBeUndefined();
  });

  it("tracks score history entries", () => {
    const entry: ScoreHistoryEntry = {
      date: "2024-01-15",
      score: 72,
      scope: "full",
    };
    const score: ScoreResult = {
      ...makeMinimalScore(),
      history: [entry],
    };

    expect(score.history).toHaveLength(1);
    expect(score.history[0].date).toBe("2024-01-15");
    expect(score.history[0].score).toBe(72);
    expect(score.history[0].scope).toBe("full");
  });
});

// ─── Type Union Coverage ─────────────────────────────────────

describe("type union values", () => {
  it("FunctionalTestType covers all five test types", () => {
    const types: FunctionalTestType[] = ["unit", "integration", "api", "e2e", "contract"];
    expect(types).toHaveLength(5);
  });

  it("SecurityCheck covers OWASP-mapped checks", () => {
    const checks: SecurityCheck[] = [
      "injection",
      "auth-bypass",
      "secrets-exposure",
      "xss",
      "insecure-config",
      "dependency-vulns",
      "data-exposure",
      "ssrf",
      "cryptographic-failures",
      "insecure-deserialization",
    ];
    expect(checks).toHaveLength(10);
  });

  it("StabilityCheck covers reliability checks", () => {
    const checks: StabilityCheck[] = [
      "error-handling",
      "edge-cases",
      "resource-cleanup",
      "graceful-degradation",
      "timeout-handling",
      "concurrent-access",
    ];
    expect(checks).toHaveLength(6);
  });

  it("ConformanceCheck covers pattern compliance checks", () => {
    const checks: ConformanceCheck[] = [
      "pattern-compliance",
      "layer-violations",
      "naming-conventions",
      "dead-code",
      "architectural-drift",
    ];
    expect(checks).toHaveLength(5);
  });

  it("Dimension covers all five quality dimensions", () => {
    const dims: Dimension[] = [
      "functionality",
      "security",
      "stability",
      "conformance",
      "regression",
    ];
    expect(dims).toHaveLength(5);
  });

  it("CoveritScope covers all ten scopes", () => {
    const scopes: CoveritScope[] = [
      "first-time",
      "unstaged",
      "staged",
      "branch",
      "pr",
      "full",
      "rescale",
      "files",
      "ci",
      "measure-only",
    ];
    expect(scopes).toHaveLength(10);
  });

  it("ContractEntry method covers standard HTTP methods", () => {
    const methods: ContractEntry["method"][] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
    expect(methods).toHaveLength(5);
  });
});

// ─── ScopeDepth ──────────────────────────────────────────────

describe("ScopeDepth structure", () => {
  it("accepts all valid functionality depth values", () => {
    const depths: ScopeDepth["functionality"][] = [
      "show-gaps",
      "generate",
      "generate-and-run",
    ];
    expect(depths).toHaveLength(3);
  });

  it("accepts all valid security depth values", () => {
    const depths: ScopeDepth["security"][] = ["skip", "scan-changed", "scan-all"];
    expect(depths).toHaveLength(3);
  });

  it("accepts all valid stability depth values", () => {
    const depths: ScopeDepth["stability"][] = ["skip", "flag-obvious", "analyze", "full"];
    expect(depths).toHaveLength(4);
  });
});
