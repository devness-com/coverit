/**
 * Coverit Scale — AI-Driven Codebase Scanner
 *
 * Main entry point for the Scale command. Delegates the entire codebase
 * analysis to an AI with tool access (Glob, Grep, Read, Bash) that
 * explores the project and produces a complete quality manifest.
 *
 * Pipeline:
 *  1. Detect project metadata (framework, language, test runner) — fast, deterministic
 *  2. Functionality scan — AI explores codebase, discovers modules, maps tests
 *  3. Security scan — AI checks for OWASP-mapped vulnerabilities
 *  4. Stability scan — AI assesses error handling and reliability
 *  5. Conformance scan — AI evaluates coding standards and architecture
 *  6. Regression scan — runs existing tests, computes pass/fail ratio (no AI)
 *  7. Assemble the full manifest with scoring
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
import { createAIProvider } from "../ai/provider-factory.js";
import {
  buildScalePrompt,
  parseScaleResponse,
  type ScaleAIModule,
} from "../ai/scale-prompts.js";
import {
  buildSecurityPrompt,
  parseSecurityResponse,
} from "../ai/security-prompts.js";
import {
  buildStabilityPrompt,
  parseStabilityResponse,
} from "../ai/stability-prompts.js";
import {
  buildConformancePrompt,
  parseConformanceResponse,
} from "../ai/conformance-prompts.js";
import {
  collectTestFiles,
  detectTestRunner,
  executeTests,
} from "../run/pipeline.js";
import type { AIProvider, AIProgressEvent } from "../ai/types.js";
import { readManifest } from "./writer.js";
import { logger } from "../utils/logger.js";

// ─── Constants ───────────────────────────────────────────────

/** Tools the AI is allowed to use during codebase exploration */
const ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Bash"];

/** 10 minutes — large codebases may take a while to explore */
const ANALYSIS_TIMEOUT_MS = 600_000;

// ─── Core Logic ──────────────────────────────────────────────

/**
 * Scans an entire codebase using AI and produces a quality manifest.
 *
 * The AI explores the project using Glob, Grep, Read, and Bash tools,
 * then produces a structured analysis covering:
 *  - Module boundaries and their source files
 *  - Existing test coverage per module
 *  - Complexity assessment per module
 *  - Expected test counts (Diamond testing strategy)
 *  - Critical user journeys and API contracts
 *
 * @param projectRoot - Absolute path to the project root
 * @param aiProvider - Optional AI provider (auto-detected if not provided)
 */
export async function scanCodebase(
  projectRoot: string,
  aiProvider?: AIProvider,
  onProgress?: (event: AIProgressEvent) => void,
): Promise<CoveritManifest> {
  logger.debug(`Scanning codebase at ${projectRoot} (AI-driven)`);

  // Step 1: Detect project metadata (fast, deterministic)
  const projectInfo = await detectProjectInfo(projectRoot);
  logger.debug(
    `Detected: ${projectInfo.framework} / ${projectInfo.testFramework}`,
  );

  // Step 2: Read existing manifest (if any) for incremental analysis
  const existingManifest = await readManifest(projectRoot);
  if (existingManifest) {
    logger.debug(
      `Found existing coverit.json (${existingManifest.modules.length} modules, score ${existingManifest.score.overall}/100)`,
    );
  }

  // Step 3: Initialize AI provider
  const provider = aiProvider ?? (await createAIProvider());
  logger.debug(`Using AI provider: ${provider.name}`);

  // Step 4: Build prompt and call AI with tool access
  onProgress?.({ type: "phase", name: "Functionality", step: 1, total: 5 });
  const messages = buildScalePrompt(projectInfo, existingManifest ?? undefined);

  logger.debug("Sending analysis prompt to AI with tool access...");
  const response = await provider.generate(messages, {
    allowedTools: ALLOWED_TOOLS,
    cwd: projectRoot,
    timeoutMs: ANALYSIS_TIMEOUT_MS,
    onProgress,
  });

  logger.debug(
    `AI analysis complete (${response.content.length} chars, model: ${response.model})`,
  );

  // Step 5: Parse AI response
  const aiResult = parseScaleResponse(response.content);
  logger.debug(
    `Parsed: ${aiResult.modules.length} modules, ${aiResult.journeys.length} journeys, ${aiResult.contracts.length} contracts`,
  );

  // Step 6: Assemble full manifest
  const now = new Date().toISOString();

  const modules: ModuleEntry[] = aiResult.modules.map(aiModuleToEntry);

  // Use AI-reported totals, falling back to aggregation from modules
  const totalSourceFiles =
    aiResult.sourceFiles > 0
      ? aiResult.sourceFiles
      : modules.reduce((sum, m) => sum + m.files, 0);
  const totalSourceLines =
    aiResult.sourceLines > 0
      ? aiResult.sourceLines
      : modules.reduce((sum, m) => sum + m.lines, 0);

  // Preserve scanned dates from existing manifest
  const scannedDates: Record<string, string> = {
    ...(existingManifest?.score.scanned ?? {}),
    functionality: now,
  };

  // ─── Step 7: Security scan ──────────────────────────────────
  onProgress?.({ type: "phase", name: "Security", step: 2, total: 5 });
  try {
    logger.debug("Starting security scan...");
    const secMessages = buildSecurityPrompt(projectInfo, modules);
    const secResponse = await provider.generate(secMessages, {
      allowedTools: ALLOWED_TOOLS,
      cwd: projectRoot,
      timeoutMs: ANALYSIS_TIMEOUT_MS,
      onProgress,
    });
    const secResult = parseSecurityResponse(secResponse.content);
    applySecurityResults(modules, secResult.modules);
    scannedDates.security = now;
    logger.debug(
      `Security scan complete: ${secResult.modules.reduce((s, m) => s + m.findings.length, 0)} findings`,
    );
  } catch (err) {
    logger.error(
      "Security scan failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // ─── Step 8: Stability scan ─────────────────────────────────
  onProgress?.({ type: "phase", name: "Stability", step: 3, total: 5 });
  try {
    logger.debug("Starting stability scan...");
    const stabMessages = buildStabilityPrompt(projectInfo, modules);
    const stabResponse = await provider.generate(stabMessages, {
      allowedTools: ALLOWED_TOOLS,
      cwd: projectRoot,
      timeoutMs: ANALYSIS_TIMEOUT_MS,
      onProgress,
    });
    const stabResult = parseStabilityResponse(stabResponse.content);
    applyStabilityResults(modules, stabResult.modules);
    scannedDates.stability = now;
    logger.debug(
      `Stability scan complete: ${stabResult.modules.length} modules assessed`,
    );
  } catch (err) {
    logger.error(
      "Stability scan failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // ─── Step 9: Conformance scan ───────────────────────────────
  onProgress?.({ type: "phase", name: "Conformance", step: 4, total: 5 });
  try {
    logger.debug("Starting conformance scan...");
    const confMessages = buildConformancePrompt(projectInfo, modules);
    const confResponse = await provider.generate(confMessages, {
      allowedTools: ALLOWED_TOOLS,
      cwd: projectRoot,
      timeoutMs: ANALYSIS_TIMEOUT_MS,
      onProgress,
    });
    const confResult = parseConformanceResponse(confResponse.content);
    applyConformanceResults(modules, confResult.modules);
    scannedDates.conformance = now;
    logger.debug(
      `Conformance scan complete: ${confResult.modules.length} modules assessed`,
    );
  } catch (err) {
    logger.error(
      "Conformance scan failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // ─── Step 10: Regression scan (no AI — run tests directly) ──
  onProgress?.({ type: "phase", name: "Regression", step: 5, total: 5 });
  try {
    logger.debug("Starting regression scan (test execution)...");
    // Build a temporary manifest to use collectTestFiles/detectTestRunner
    const tempManifest: CoveritManifest = {
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
      dimensions: existingManifest?.dimensions ?? DEFAULT_DIMENSIONS,
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
        history: [],
        scanned: scannedDates,
      },
    };

    const testFiles = collectTestFiles(tempManifest);
    if (testFiles.length > 0) {
      const testRunner = detectTestRunner(tempManifest);
      const runResult = await executeTests(projectRoot, testFiles, testRunner);
      logger.debug(
        `Regression scan: ${runResult.passed}/${runResult.total} tests passed`,
      );
      scannedDates.regression = now;
    } else {
      // No tests to run — regression is trivially 100 (nothing to regress)
      scannedDates.regression = now;
      logger.debug("Regression scan: no test files found, marking as scanned");
    }
  } catch (err) {
    logger.error(
      "Regression scan failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // ─── Step 11: Assemble final manifest with all dimensions ───
  const preliminary: CoveritManifest = {
    version: 1,
    createdAt: existingManifest?.createdAt ?? now,
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

    dimensions: existingManifest?.dimensions ?? DEFAULT_DIMENSIONS,
    modules,

    journeys: aiResult.journeys.map((j) => ({
      id: j.id,
      name: j.name,
      steps: j.steps,
      covered: j.covered,
      testFile: j.testFile,
    })),

    contracts: aiResult.contracts.map((c) => ({
      endpoint: c.endpoint,
      method: c.method,
      requestSchema: c.requestSchema,
      responseSchema: c.responseSchema,
      covered: c.covered,
      testFile: c.testFile,
    })),

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
      history: [],
      scanned: scannedDates,
    },
  };

  // Use the scoring engine for consistent scoring across all scanned dimensions
  const scoreResult = calculateScore(preliminary);

  // Preserve history from existing manifest, append new entry
  const previousHistory = existingManifest?.score.history ?? [];
  const scope = existingManifest ? "re-analysis" : "first-time";

  const manifest: CoveritManifest = {
    ...preliminary,
    score: {
      ...scoreResult,
      history: [
        ...previousHistory,
        {
          date: now,
          score: scoreResult.overall,
          scope,
        },
      ],
    },
  };

  return manifest;
}

// ─── Dimension Result Applicators ────────────────────────────

import type { SecurityAIModule } from "../ai/security-prompts.js";
import type { StabilityAIModule } from "../ai/stability-prompts.js";
import type { ConformanceAIModule } from "../ai/conformance-prompts.js";

/**
 * Apply security scan results to existing modules by matching on path.
 */
function applySecurityResults(
  modules: ModuleEntry[],
  securityModules: SecurityAIModule[],
): void {
  const secMap = new Map(securityModules.map((m) => [m.path, m]));
  for (const mod of modules) {
    const sec = secMap.get(mod.path);
    if (sec) {
      mod.security = {
        issues: sec.issues,
        resolved: sec.resolved,
        findings: sec.findings,
      };
    }
  }
}

/**
 * Apply stability scan results to existing modules by matching on path.
 */
function applyStabilityResults(
  modules: ModuleEntry[],
  stabilityModules: StabilityAIModule[],
): void {
  const stabMap = new Map(stabilityModules.map((m) => [m.path, m]));
  for (const mod of modules) {
    const stab = stabMap.get(mod.path);
    if (stab) {
      mod.stability = {
        score: stab.score,
        gaps: stab.gaps,
      };
    }
  }
}

/**
 * Apply conformance scan results to existing modules by matching on path.
 */
function applyConformanceResults(
  modules: ModuleEntry[],
  conformanceModules: ConformanceAIModule[],
): void {
  const confMap = new Map(conformanceModules.map((m) => [m.path, m]));
  for (const mod of modules) {
    const conf = confMap.get(mod.path);
    if (conf) {
      mod.conformance = {
        score: conf.score,
        violations: conf.violations,
      };
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Convert an AI module response to a full ModuleEntry with
 * placeholder values for AI-dependent dimensions (security, stability, conformance).
 */
function aiModuleToEntry(aiModule: ScaleAIModule): ModuleEntry {
  const tests: Partial<Record<FunctionalTestType, TestCoverage>> = {};
  const validTypes = new Set<FunctionalTestType>([
    "unit",
    "integration",
    "api",
    "e2e",
    "contract",
  ]);

  for (const [testType, coverage] of Object.entries(
    aiModule.functionality.tests,
  )) {
    if (!validTypes.has(testType as FunctionalTestType)) continue;
    tests[testType as FunctionalTestType] = {
      expected: coverage.expected,
      current: coverage.current,
      files: coverage.files,
    };
  }

  return {
    path: aiModule.path,
    files: aiModule.files,
    lines: aiModule.lines,
    complexity: aiModule.complexity,
    functionality: { tests },
    // AI-dependent dimensions — initialized with neutral placeholders
    security: { issues: 0, resolved: 0, findings: [] },
    stability: { score: 0, gaps: [] },
    conformance: { score: 0, violations: [] },
  };
}
