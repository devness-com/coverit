/**
 * Coverit Scale — AI-Driven Codebase Scanner
 *
 * Main entry point for the Scale command. Delegates the entire codebase
 * analysis to an AI with tool access (Glob, Grep, Read, Bash) that
 * explores the project and produces a complete quality manifest.
 *
 * Pipeline:
 *  1. Detect project metadata (framework, language, test runner) — fast, deterministic
 *  2. Functionality scan — AI explores codebase, discovers modules, maps tests (sequential)
 *  3. Parallel scans — Security, Stability, Conformance, Regression run concurrently
 *  4. Assemble the full manifest with scoring
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
import type { ProjectInfo } from "../types/index.js";
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
import type { SecurityAIModule } from "../ai/security-prompts.js";
import type { StabilityAIModule } from "../ai/stability-prompts.js";
import type { ConformanceAIModule } from "../ai/conformance-prompts.js";
import { readManifest } from "./writer.js";
import { logger } from "../utils/logger.js";
import { ScanLogger } from "../utils/scan-logger.js";
import { useaiHeartbeat } from "../integrations/useai.js";

// ─── Constants ───────────────────────────────────────────────

/** Tools the AI is allowed to use during codebase exploration */
const ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Bash"];

/** 15 minutes — large codebases may take a while to explore */
const DEFAULT_TIMEOUT_MS = 900_000;

// ─── Options ─────────────────────────────────────────────────

export interface ScanOptions {
  /** AI provider to use (auto-detected if not provided) */
  aiProvider?: AIProvider;
  /** Progress callback for streaming events */
  onProgress?: (event: AIProgressEvent) => void;
  /** Timeout per dimension in milliseconds (default: 900_000 = 15 min) */
  timeoutMs?: number;
}

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
 * After the initial Functionality scan, dimensions 2-5 (Security,
 * Stability, Conformance, Regression) run in parallel for faster results.
 *
 * @param projectRoot - Absolute path to the project root
 * @param options - Scan configuration options
 */
export async function scanCodebase(
  projectRoot: string,
  options?: ScanOptions,
): Promise<CoveritManifest>;
/**
 * @deprecated Use the options-based overload instead.
 */
export async function scanCodebase(
  projectRoot: string,
  aiProvider?: AIProvider,
  onProgress?: (event: AIProgressEvent) => void,
): Promise<CoveritManifest>;
export async function scanCodebase(
  projectRoot: string,
  optionsOrProvider?: ScanOptions | AIProvider,
  legacyOnProgress?: (event: AIProgressEvent) => void,
): Promise<CoveritManifest> {
  // Support both new options-based and legacy positional signatures
  let aiProvider: AIProvider | undefined;
  let onProgress: ((event: AIProgressEvent) => void) | undefined;
  let timeoutMs: number;

  if (optionsOrProvider && "generate" in optionsOrProvider) {
    // Legacy: scanCodebase(root, provider, onProgress)
    aiProvider = optionsOrProvider as AIProvider;
    onProgress = legacyOnProgress;
    timeoutMs = DEFAULT_TIMEOUT_MS;
  } else if (optionsOrProvider && typeof optionsOrProvider === "object") {
    // New: scanCodebase(root, { aiProvider, onProgress, timeoutMs })
    const opts = optionsOrProvider as ScanOptions;
    aiProvider = opts.aiProvider;
    onProgress = opts.onProgress;
    timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  } else {
    timeoutMs = DEFAULT_TIMEOUT_MS;
  }

  const scanLog = new ScanLogger(projectRoot);
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

  // ─── Step 4: Functionality scan (sequential — produces modules) ──
  onProgress?.({ type: "phase", name: "Functionality", step: 1, total: 5 });
  const funcStart = Date.now();
  const messages = buildScalePrompt(projectInfo, existingManifest ?? undefined);

  logger.debug("Sending analysis prompt to AI with tool access...");
  const response = await provider.generate(messages, {
    allowedTools: ALLOWED_TOOLS,
    cwd: projectRoot,
    timeoutMs,
    onProgress,
  });

  logger.debug(
    `AI analysis complete (${response.content.length} chars, model: ${response.model})`,
  );

  const aiResult = parseScaleResponse(response.content);
  logger.debug(
    `Parsed: ${aiResult.modules.length} modules, ${aiResult.journeys.length} journeys, ${aiResult.contracts.length} contracts`,
  );

  scanLog.record({
    name: "Functionality",
    success: true,
    durationMs: Date.now() - funcStart,
    detail: `${aiResult.modules.length} modules discovered`,
  });

  // Step 5: Assemble modules from Functionality result
  const now = new Date().toISOString();
  const modules: ModuleEntry[] = aiResult.modules.map(aiModuleToEntry);

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

  // ─── Step 6: Parallel dimension scans ─────────────────────────
  // Security, Stability, Conformance, and Regression are independent
  // of each other (they all depend only on the modules from Functionality).
  // Running them concurrently gives ~3-4x speedup.

  onProgress?.({ type: "phase", name: "Security + Stability + Conformance + Regression", step: 2, total: 2 });
  await useaiHeartbeat();

  const parallelContext: ParallelScanContext = {
    provider,
    projectInfo,
    projectRoot,
    modules,
    scannedDates,
    now,
    timeoutMs,
    totalSourceFiles,
    totalSourceLines,
    existingManifest,
    scanLog,
  };

  await Promise.all([
    runSecurityScan(parallelContext, wrapProgress(onProgress, "Security")),
    runStabilityScan(parallelContext, wrapProgress(onProgress, "Stability")),
    runConformanceScan(parallelContext, wrapProgress(onProgress, "Conformance")),
    runRegressionScan(parallelContext, wrapProgress(onProgress, "Regression")),
  ]);

  // ─── Step 7: Assemble final manifest with all dimensions ───
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

  // Flush scan log
  await scanLog.flush(manifest.score.overall);

  return manifest;
}

// ─── Parallel Scan Context ───────────────────────────────────

interface ParallelScanContext {
  provider: AIProvider;
  projectInfo: ProjectInfo;
  projectRoot: string;
  modules: ModuleEntry[];
  scannedDates: Record<string, string>;
  now: string;
  timeoutMs: number;
  totalSourceFiles: number;
  totalSourceLines: number;
  existingManifest: CoveritManifest | null;
  scanLog: ScanLogger;
}

/**
 * Wrap an onProgress callback to prefix tool activity with the dimension name.
 * Phase events are suppressed since we set one phase for all parallel dimensions.
 */
function wrapProgress(
  onProgress: ((event: AIProgressEvent) => void) | undefined,
  dimensionName: string,
): ((event: AIProgressEvent) => void) | undefined {
  if (!onProgress) return undefined;
  return (event: AIProgressEvent) => {
    if (event.type === "phase") return; // suppress — handled by caller
    if (event.type === "tool_use") {
      onProgress({
        ...event,
        input: event.input ? `${dimensionName}: ${event.input}` : dimensionName,
      });
    } else {
      onProgress(event);
    }
  };
}

// ─── Dimension Scan Functions ────────────────────────────────

async function runSecurityScan(
  ctx: ParallelScanContext,
  onProgress?: (event: AIProgressEvent) => void,
): Promise<void> {
  const start = Date.now();
  try {
    logger.debug("Starting security scan...");
    const secMessages = buildSecurityPrompt(ctx.projectInfo, ctx.modules);
    const secResponse = await ctx.provider.generate(secMessages, {
      allowedTools: ALLOWED_TOOLS,
      cwd: ctx.projectRoot,
      timeoutMs: ctx.timeoutMs,
      onProgress,
    });
    const secResult = parseSecurityResponse(secResponse.content);
    applySecurityResults(ctx.modules, secResult.modules);
    ctx.scannedDates.security = ctx.now;
    const findings = secResult.modules.reduce((s, m) => s + m.findings.length, 0);
    logger.debug(`Security scan complete: ${findings} findings`);
    ctx.scanLog.record({
      name: "Security",
      success: true,
      durationMs: Date.now() - start,
      detail: `${findings} findings across ${secResult.modules.length} modules`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Security scan failed:", msg);
    ctx.scanLog.record({
      name: "Security",
      success: false,
      durationMs: Date.now() - start,
      error: msg,
    });
  }
}

async function runStabilityScan(
  ctx: ParallelScanContext,
  onProgress?: (event: AIProgressEvent) => void,
): Promise<void> {
  const start = Date.now();
  try {
    logger.debug("Starting stability scan...");
    const stabMessages = buildStabilityPrompt(ctx.projectInfo, ctx.modules);
    const stabResponse = await ctx.provider.generate(stabMessages, {
      allowedTools: ALLOWED_TOOLS,
      cwd: ctx.projectRoot,
      timeoutMs: ctx.timeoutMs,
      onProgress,
    });
    const stabResult = parseStabilityResponse(stabResponse.content);
    applyStabilityResults(ctx.modules, stabResult.modules);
    ctx.scannedDates.stability = ctx.now;
    logger.debug(`Stability scan complete: ${stabResult.modules.length} modules assessed`);
    ctx.scanLog.record({
      name: "Stability",
      success: true,
      durationMs: Date.now() - start,
      detail: `${stabResult.modules.length} modules assessed`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Stability scan failed:", msg);
    ctx.scanLog.record({
      name: "Stability",
      success: false,
      durationMs: Date.now() - start,
      error: msg,
    });
  }
}

async function runConformanceScan(
  ctx: ParallelScanContext,
  onProgress?: (event: AIProgressEvent) => void,
): Promise<void> {
  const start = Date.now();
  try {
    logger.debug("Starting conformance scan...");
    const confMessages = buildConformancePrompt(ctx.projectInfo, ctx.modules);
    const confResponse = await ctx.provider.generate(confMessages, {
      allowedTools: ALLOWED_TOOLS,
      cwd: ctx.projectRoot,
      timeoutMs: ctx.timeoutMs,
      onProgress,
    });
    const confResult = parseConformanceResponse(confResponse.content);
    applyConformanceResults(ctx.modules, confResult.modules);
    ctx.scannedDates.conformance = ctx.now;
    logger.debug(`Conformance scan complete: ${confResult.modules.length} modules assessed`);
    ctx.scanLog.record({
      name: "Conformance",
      success: true,
      durationMs: Date.now() - start,
      detail: `${confResult.modules.length} modules assessed`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Conformance scan failed:", msg);
    ctx.scanLog.record({
      name: "Conformance",
      success: false,
      durationMs: Date.now() - start,
      error: msg,
    });
  }
}

async function runRegressionScan(
  ctx: ParallelScanContext,
  onProgress?: (event: AIProgressEvent) => void,
): Promise<void> {
  // Suppress unused param warning — regression doesn't use AI progress events
  void onProgress;
  const start = Date.now();
  try {
    logger.debug("Starting regression scan (test execution)...");
    const tempManifest: CoveritManifest = {
      version: 1,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      project: {
        name: ctx.projectInfo.name,
        root: ctx.projectRoot,
        language: ctx.projectInfo.language,
        framework: ctx.projectInfo.framework,
        testFramework: ctx.projectInfo.testFramework,
        sourceFiles: ctx.totalSourceFiles,
        sourceLines: ctx.totalSourceLines,
      },
      dimensions: ctx.existingManifest?.dimensions ?? DEFAULT_DIMENSIONS,
      modules: ctx.modules,
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
        scanned: ctx.scannedDates,
      },
    };

    const testFiles = collectTestFiles(tempManifest);
    if (testFiles.length > 0) {
      const testRunner = detectTestRunner(tempManifest);
      const runResult = await executeTests(ctx.projectRoot, testFiles, testRunner);
      logger.debug(`Regression scan: ${runResult.passed}/${runResult.total} tests passed`);
      ctx.scannedDates.regression = ctx.now;
      ctx.scanLog.record({
        name: "Regression",
        success: true,
        durationMs: Date.now() - start,
        detail: `${runResult.passed}/${runResult.total} tests passed`,
      });
    } else {
      ctx.scannedDates.regression = ctx.now;
      logger.debug("Regression scan: no test files found, marking as scanned");
      ctx.scanLog.record({
        name: "Regression",
        success: true,
        durationMs: Date.now() - start,
        detail: "no test files found",
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Regression scan failed:", msg);
    ctx.scanLog.record({
      name: "Regression",
      success: false,
      durationMs: Date.now() - start,
      error: msg,
    });
  }
}

// ─── Dimension Result Applicators ────────────────────────────

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
