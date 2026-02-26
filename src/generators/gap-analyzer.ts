/**
 * Gap Analyzer — Manifest-Driven Test Gap Detection
 *
 * Reads a CoveritManifest and identifies prioritized gaps where
 * tests are missing. Replaces the "AI decides from scratch" triage
 * with a deterministic, manifest-driven approach.
 *
 * Priority logic (descending):
 *   1. Security gaps (any module with unresolved issues) -> critical
 *   2. Integration gaps in high-complexity modules -> high
 *   3. API gaps (missing endpoint tests) -> high
 *   4. Integration gaps in medium-complexity modules -> medium
 *   5. Unit test gaps -> medium
 *   6. E2E journey gaps -> medium
 *   7. Contract test gaps -> low
 */

import type {
  CoveritManifest,
  ModuleEntry,
  FunctionalTestType,
  TestCoverage,
} from "../schema/coverit-manifest.js";

// ─── Public Types ──────────────────────────────────────────

export interface Gap {
  modulePath: string;
  testType: FunctionalTestType;
  expected: number;
  current: number;
  missing: number;
  priority: "critical" | "high" | "medium" | "low";
  /** Source files in this module to generate tests for */
  sourceFiles: string[];
  /** Description for the AI prompt */
  description: string;
}

export interface GapAnalysis {
  gaps: Gap[];
  totalMissing: number;
  /** Gaps sorted by priority: security > integration > api > e2e > unit > contract */
  prioritized: Gap[];
}

// ─── Priority Ordering ─────────────────────────────────────
// Lower index = higher priority when sorting

const PRIORITY_RANK: Record<Gap["priority"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * Secondary sort within same priority — test types that catch
 * more integration-level bugs are ordered first.
 */
const TEST_TYPE_RANK: Record<FunctionalTestType, number> = {
  integration: 0,
  api: 1,
  e2e: 2,
  unit: 3,
  contract: 4,
};

// ─── Main Entry Point ──────────────────────────────────────

/**
 * Analyze a manifest to find all test coverage gaps, prioritized
 * for generation. Optionally filter to only modules containing
 * the specified changed files.
 */
export function analyzeGaps(
  manifest: CoveritManifest,
  changedFiles?: string[],
): GapAnalysis {
  const modules = changedFiles
    ? filterModulesByChangedFiles(manifest.modules, changedFiles)
    : manifest.modules;

  const gaps: Gap[] = [];

  for (const mod of modules) {
    const moduleGaps = analyzeModuleGaps(mod);
    gaps.push(...moduleGaps);
  }

  // Uncovered journeys contribute e2e gaps even if no module matched
  const journeyGaps = analyzeJourneyGaps(manifest, changedFiles);
  gaps.push(...journeyGaps);

  // Uncovered contracts contribute contract gaps
  const contractGaps = analyzeContractGaps(manifest, changedFiles);
  gaps.push(...contractGaps);

  const prioritized = sortByPriority(gaps);
  const totalMissing = gaps.reduce((sum, g) => sum + g.missing, 0);

  return { gaps, totalMissing, prioritized };
}

// ─── Module Gap Analysis ───────────────────────────────────

function analyzeModuleGaps(mod: ModuleEntry): Gap[] {
  const gaps: Gap[] = [];
  const hasSecurityIssues = mod.security.issues > 0;

  const testEntries = Object.entries(mod.functionality.tests) as Array<
    [FunctionalTestType, TestCoverage]
  >;

  for (const [testType, coverage] of testEntries) {
    const missing = coverage.expected - coverage.current;
    if (missing <= 0) continue;

    const priority = classifyPriority(testType, mod, hasSecurityIssues);
    const sourceFiles = resolveSourceFiles(mod);
    const description = buildGapDescription(testType, mod, coverage, hasSecurityIssues);

    gaps.push({
      modulePath: mod.path,
      testType,
      expected: coverage.expected,
      current: coverage.current,
      missing,
      priority,
      sourceFiles,
      description,
    });
  }

  return gaps;
}

/**
 * Classify priority based on test type, module characteristics,
 * and security status. Security gaps always escalate to critical.
 */
function classifyPriority(
  testType: FunctionalTestType,
  mod: ModuleEntry,
  hasSecurityIssues: boolean,
): Gap["priority"] {
  // Rule 1: Security gaps -> critical
  if (hasSecurityIssues) return "critical";

  switch (testType) {
    case "integration":
      // Rule 2: Integration + high complexity -> high
      if (mod.complexity === "high") return "high";
      // Rule 4: Integration + medium complexity -> medium
      return "medium";

    case "api":
      // Rule 3: API gaps -> high
      return "high";

    case "unit":
      // Rule 5: Unit gaps -> medium
      return "medium";

    case "e2e":
      // Rule 6: E2E journey gaps -> medium
      return "medium";

    case "contract":
      // Rule 7: Contract gaps -> low
      return "low";
  }
}

// ─── Journey Gap Analysis ──────────────────────────────────

function analyzeJourneyGaps(
  manifest: CoveritManifest,
  changedFiles?: string[],
): Gap[] {
  const gaps: Gap[] = [];

  for (const journey of manifest.journeys) {
    if (journey.covered) continue;

    // If filtering by changed files, skip journeys that don't
    // intersect with any changed file's module
    if (changedFiles && changedFiles.length > 0) {
      const journeyModules = manifest.modules.map((m) => m.path);
      const changedModules = changedFiles.map((f) => findModulePath(f, journeyModules));
      // Only include if at least one changed file maps to a known module
      if (!changedModules.some(Boolean)) continue;
    }

    gaps.push({
      modulePath: "(journey)",
      testType: "e2e",
      expected: 1,
      current: 0,
      missing: 1,
      priority: "medium",
      sourceFiles: [],
      description: `E2E journey: "${journey.name}" — steps: ${journey.steps.join(" -> ")}`,
    });
  }

  return gaps;
}

// ─── Contract Gap Analysis ─────────────────────────────────

function analyzeContractGaps(
  manifest: CoveritManifest,
  changedFiles?: string[],
): Gap[] {
  const uncoveredContracts = manifest.contracts.filter((c) => !c.covered);
  if (uncoveredContracts.length === 0) return [];

  // If filtering by changed files, only include contracts whose
  // endpoints might be affected. We use a simple heuristic: if
  // any changed file is in a controller/route module, include
  // the corresponding contracts.
  if (changedFiles && changedFiles.length > 0) {
    const hasControllerChanges = changedFiles.some(
      (f) => /controller|route|handler/i.test(f),
    );
    if (!hasControllerChanges) return [];
  }

  // Group all uncovered contracts into a single gap entry
  const endpoints = uncoveredContracts.map(
    (c) => `${c.method} ${c.endpoint}`,
  );

  return [
    {
      modulePath: "(contracts)",
      testType: "contract",
      expected: uncoveredContracts.length,
      current: 0,
      missing: uncoveredContracts.length,
      priority: "low",
      sourceFiles: [],
      description: `Contract validation for uncovered endpoints: ${endpoints.join(", ")}`,
    },
  ];
}

// ─── Filtering ─────────────────────────────────────────────

/**
 * Keep only modules that contain at least one of the changed files.
 * A file belongs to a module if its path starts with the module's path.
 */
function filterModulesByChangedFiles(
  modules: ModuleEntry[],
  changedFiles: string[],
): ModuleEntry[] {
  return modules.filter((mod) =>
    changedFiles.some((file) => file.startsWith(mod.path)),
  );
}

function findModulePath(
  filePath: string,
  modulePaths: string[],
): string | undefined {
  return modulePaths.find((mp) => filePath.startsWith(mp));
}

// ─── Source File Resolution ────────────────────────────────

/**
 * Resolve which source files in a module should be used for
 * test generation. Prefers critical file entries when available,
 * otherwise constructs paths from module metadata.
 */
function resolveSourceFiles(mod: ModuleEntry): string[] {
  if (mod.critical && mod.critical.length > 0) {
    return mod.critical.map((c) => `${mod.path}/${c.file}`);
  }

  // Without per-file breakdown, return the module path itself
  // so the targeted generator can glob for source files
  return [mod.path];
}

// ─── Description Building ──────────────────────────────────

function buildGapDescription(
  testType: FunctionalTestType,
  mod: ModuleEntry,
  coverage: TestCoverage,
  hasSecurityIssues: boolean,
): string {
  const parts: string[] = [];

  const typeLabel = TEST_TYPE_LABELS[testType];
  parts.push(
    `Generate ${coverage.expected - coverage.current} ${typeLabel} test(s) for module "${mod.path}"`,
  );
  parts.push(
    `(complexity: ${mod.complexity}, current: ${coverage.current}/${coverage.expected})`,
  );

  if (hasSecurityIssues) {
    const findings = mod.security.findings.slice(0, 3).join(", ");
    parts.push(
      `[SECURITY] ${mod.security.issues} unresolved issue(s): ${findings}`,
    );
  }

  if (mod.critical && mod.critical.length > 0) {
    const criticalMethods = mod.critical
      .flatMap((c) => c.criticalPaths)
      .slice(0, 5);
    if (criticalMethods.length > 0) {
      parts.push(`Critical paths: ${criticalMethods.join(", ")}`);
    }
  }

  return parts.join(". ");
}

const TEST_TYPE_LABELS: Record<FunctionalTestType, string> = {
  unit: "unit",
  integration: "integration",
  api: "API endpoint",
  e2e: "end-to-end",
  contract: "contract validation",
};

// ─── Sorting ───────────────────────────────────────────────

/**
 * Sort gaps by priority (critical first), then by test type rank
 * (integration before unit), then by missing count (largest gaps first).
 */
function sortByPriority(gaps: Gap[]): Gap[] {
  return [...gaps].sort((a, b) => {
    const priorityDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (priorityDiff !== 0) return priorityDiff;

    const typeDiff = TEST_TYPE_RANK[a.testType] - TEST_TYPE_RANK[b.testType];
    if (typeDiff !== 0) return typeDiff;

    // Larger gaps first within same priority and type
    return b.missing - a.missing;
  });
}
