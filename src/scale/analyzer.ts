/**
 * Coverit Scale — Codebase Analyzer
 *
 * Main entry point for the Scale command. Orchestrates a full codebase
 * analysis and produces a CoveritManifest (coverit.json).
 *
 * Pipeline:
 *  1. Detect project info (framework, language, test runner)
 *  2. Discover module boundaries from directory structure
 *  3. Map existing test files to source modules
 *  4. Classify module complexity
 *  5. Calculate expected test counts (Diamond strategy)
 *  6. Assemble and return the manifest
 *
 * This entire pipeline is filesystem-only — no AI calls.
 * AI-powered enrichment (security scanning, stability analysis,
 * journey detection, contract discovery) happens in later stages.
 */

import type {
  CoveritManifest,
  ModuleEntry,
  FunctionalTestType,
  TestCoverage,
} from "../schema/coverit-manifest.js";
import { DEFAULT_DIMENSIONS } from "../schema/defaults.js";
import { calculateScore } from "../scoring/engine.js";
import { detectProjectInfo } from "../utils/framework-detector.js";
import { detectModules } from "./module-detector.js";
import { mapExistingTests, type TestMapping } from "./test-mapper.js";
import { classifyComplexity } from "./complexity.js";
import { calculateExpectedTests } from "./expected-counts.js";
import { logger } from "../utils/logger.js";

// ─── Core Logic ──────────────────────────────────────────────

/**
 * Analyzes an entire codebase and produces a quality manifest.
 *
 * The manifest captures:
 *  - What the codebase contains (modules, files, complexity)
 *  - What tests exist and what's missing
 *  - Baseline scores for each quality dimension
 *
 * Security, stability, and conformance dimensions are initialized
 * with placeholder scores. They require AI analysis to populate
 * meaningful values, which happens in subsequent pipeline stages.
 */
export async function analyzeCodebase(
  projectRoot: string,
): Promise<CoveritManifest> {
  logger.debug(`Analyzing codebase at ${projectRoot}`);

  // Step 1: Detect project metadata
  const projectInfo = await detectProjectInfo(projectRoot);
  logger.debug(`Detected: ${projectInfo.framework} / ${projectInfo.testFramework}`);

  // Step 2: Discover modules
  const rawModules = await detectModules(projectRoot);
  logger.debug(`Found ${rawModules.length} modules`);

  // Step 3: Map existing tests to modules
  const testMappings = await mapExistingTests(projectRoot, rawModules);
  logger.debug(`Mapped ${testMappings.length} test files`);

  // Step 4-5: Build module entries with complexity and expected counts
  const testsByModule = groupTestsByModule(testMappings);
  const modules: ModuleEntry[] = rawModules.map((rawModule) => {
    const complexity = classifyComplexity(rawModule);
    const expectedTests = calculateExpectedTests(rawModule, complexity);
    const moduleTests = testsByModule.get(rawModule.path) ?? [];

    return buildModuleEntry(
      rawModule.path,
      rawModule.files.length,
      rawModule.lines,
      complexity,
      expectedTests,
      moduleTests,
    );
  });

  // Aggregate totals for project metadata
  const totalSourceFiles = rawModules.reduce(
    (sum, m) => sum + m.files.length,
    0,
  );
  const totalSourceLines = rawModules.reduce(
    (sum, m) => sum + m.lines,
    0,
  );

  const now = new Date().toISOString();

  // Build a preliminary manifest so the scoring engine can compute scores
  const preliminary: CoveritManifest = {
    version: 1,
    createdAt: now,
    updatedAt: now,

    project: {
      name: projectInfo.name,
      root: projectRoot,
      language: projectInfo.language,
      framework: projectInfo.framework,
      testFramework: projectInfo.testFramework,
      sourceFiles: totalSourceFiles,
      sourceLines: totalSourceLines,
    },

    dimensions: DEFAULT_DIMENSIONS,

    modules,

    // Journeys and contracts require AI analysis — initialized empty
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
      gaps: { total: 0, critical: 0, byDimension: {
        functionality: { missing: 0, priority: "none" },
        security: { issues: 0, priority: "pending-ai-scan" },
        stability: { gaps: 0, priority: "pending-ai-scan" },
        conformance: { violations: 0, priority: "pending-ai-scan" },
      }},
      history: [],
      // Only functionality has been scanned at this point
      scanned: { functionality: now },
    },
  };

  // Use the scoring engine for consistent scoring across scale and measure
  const scoreResult = calculateScore(preliminary);

  const manifest: CoveritManifest = {
    ...preliminary,
    score: {
      ...scoreResult,
      history: [
        {
          date: now,
          score: scoreResult.overall,
          scope: "first-time",
        },
      ],
    },
  };

  return manifest;
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Groups test mappings by their module path for efficient lookup
 * during module entry construction.
 */
function groupTestsByModule(
  mappings: TestMapping[],
): Map<string, TestMapping[]> {
  const grouped = new Map<string, TestMapping[]>();

  for (const mapping of mappings) {
    const existing = grouped.get(mapping.modulePath);
    if (existing) {
      existing.push(mapping);
    } else {
      grouped.set(mapping.modulePath, [mapping]);
    }
  }

  return grouped;
}

/**
 * Constructs a ModuleEntry with functionality test coverage,
 * and placeholder values for AI-dependent dimensions.
 */
function buildModuleEntry(
  path: string,
  fileCount: number,
  lineCount: number,
  complexity: ModuleEntry["complexity"],
  expectedTests: Record<FunctionalTestType, number>,
  testMappings: TestMapping[],
): ModuleEntry {
  // Build test coverage per type
  const testsByType = new Map<FunctionalTestType, TestMapping[]>();
  for (const mapping of testMappings) {
    const existing = testsByType.get(mapping.testType);
    if (existing) {
      existing.push(mapping);
    } else {
      testsByType.set(mapping.testType, [mapping]);
    }
  }

  const tests: Partial<Record<FunctionalTestType, TestCoverage>> = {};
  const testTypes: FunctionalTestType[] = [
    "unit",
    "integration",
    "api",
    "e2e",
    "contract",
  ];

  for (const testType of testTypes) {
    const expected = expectedTests[testType];
    // Only include test types where coverage is expected
    if (expected > 0) {
      const typeTests = testsByType.get(testType) ?? [];
      const currentCount = typeTests.reduce(
        (sum, t) => sum + t.testCount,
        0,
      );
      tests[testType] = {
        expected,
        current: currentCount,
        files: typeTests.map((t) => t.testFile),
      };
    }
  }

  return {
    path,
    files: fileCount,
    lines: lineCount,
    complexity,
    functionality: { tests },
    // AI-dependent dimensions — initialized with neutral placeholders
    security: { issues: 0, resolved: 0, findings: [] },
    stability: { score: 0, gaps: [] },
    conformance: { score: 0, violations: [] },
  };
}

