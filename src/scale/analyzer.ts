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
import { UsageTracker } from "../utils/usage-tracker.js";
import type { SecurityAIModule } from "../ai/security-prompts.js";
import type { StabilityAIModule } from "../ai/stability-prompts.js";
import type { ConformanceAIModule } from "../ai/conformance-prompts.js";
import { mapFilesToModules, getHeadCommit, getFilesSinceCommit } from "../utils/git.js";
import { readManifest } from "./writer.js";
import { logger } from "../utils/logger.js";
import { ScanLogger } from "../utils/scan-logger.js";
import {
  readScanSession,
  writeScanSession,
  deleteScanSession,
  type ScanSession,
} from "../utils/session.js";
import { useaiHeartbeat } from "../integrations/useai.js";

// ─── Constants ───────────────────────────────────────────────

/** Tools the AI is allowed to use during codebase exploration */
const ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Bash"];

/** 20 minutes — large codebases may take a while to explore */
const DEFAULT_TIMEOUT_MS = 1_200_000;

/** Valid values for AI-detected overrides (must match union types in types/index.ts) */
const VALID_LANGUAGES = new Set(["typescript", "javascript", "python", "go", "rust", "java"]);
const VALID_FRAMEWORKS = new Set(["hono", "express", "nestjs", "next", "react", "react-native", "expo", "tauri", "electron", "fastify", "none"]);
const VALID_TEST_FRAMEWORKS = new Set(["vitest", "jest", "mocha", "playwright", "cypress", "detox", "pytest", "go-test"]);

// ─── Options ─────────────────────────────────────────────────

/** Valid dimension names for selective scanning */
export type ScanDimension = "functionality" | "security" | "stability" | "conformance" | "regression";

export const ALL_DIMENSIONS: ScanDimension[] = ["functionality", "security", "stability", "conformance", "regression"];

export interface ScanOptions {
  /** AI provider to use (auto-detected if not provided) */
  aiProvider?: AIProvider;
  /** Progress callback for streaming events */
  onProgress?: (event: AIProgressEvent) => void;
  /** Timeout per dimension in milliseconds (default: 1_200_000 = 20 min) */
  timeoutMs?: number;
  /**
   * Only scan specific dimensions (default: all 5).
   * When functionality is omitted, modules are loaded from existing coverit.json.
   * Requires coverit.json to exist if functionality is not included.
   */
  dimensions?: ScanDimension[];
  /** Force a full scan even if lastScanCommit exists (--full flag) */
  forceFullScan?: boolean;
  /** Optional usage tracker — populated with token usage from each AI call */
  usageTracker?: UsageTracker;
  /** Resume from a previous interrupted scan (default: true) */
  resume?: boolean;
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
  let forceFullScan = false;
  let usageTracker: UsageTracker;

  let dimensions: Set<ScanDimension>;
  let resumeEnabled = true;

  if (optionsOrProvider && "generate" in optionsOrProvider) {
    // Legacy: scanCodebase(root, provider, onProgress)
    aiProvider = optionsOrProvider as AIProvider;
    onProgress = legacyOnProgress;
    timeoutMs = DEFAULT_TIMEOUT_MS;
    dimensions = new Set(ALL_DIMENSIONS);
    usageTracker = new UsageTracker();
  } else if (optionsOrProvider && typeof optionsOrProvider === "object") {
    // New: scanCodebase(root, { aiProvider, onProgress, timeoutMs, dimensions })
    const opts = optionsOrProvider as ScanOptions;
    aiProvider = opts.aiProvider;
    onProgress = opts.onProgress;
    timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    dimensions = new Set(opts.dimensions ?? ALL_DIMENSIONS);
    forceFullScan = opts.forceFullScan ?? false;
    usageTracker = opts.usageTracker ?? new UsageTracker();
    resumeEnabled = opts.resume !== false;
  } else {
    timeoutMs = DEFAULT_TIMEOUT_MS;
    dimensions = new Set(ALL_DIMENSIONS);
    usageTracker = new UsageTracker();
  }

  const scanLog = new ScanLogger(projectRoot);
  logger.debug(`Scanning codebase at ${projectRoot} (AI-driven)`);

  // Step 1: Detect project metadata (fast, deterministic — AI may override later)
  let projectInfo = await detectProjectInfo(projectRoot);
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

  // Resume support: skip dimensions already completed in a previous session
  let scanSession: ScanSession | null = resumeEnabled
    ? await readScanSession(projectRoot)
    : null;
  const skippedDimensions: string[] = [];

  if (scanSession && resumeEnabled) {
    for (const [dim, state] of Object.entries(scanSession.dimensions)) {
      if (state.status === "completed" && dimensions.has(dim as ScanDimension)) {
        dimensions.delete(dim as ScanDimension);
        skippedDimensions.push(dim);
      }
    }
    if (skippedDimensions.length > 0) {
      logger.debug(`Resuming scan: skipping completed dimensions (${skippedDimensions.join(", ")})`);
    }
  }

  // Initialize scan session for tracking
  if (!scanSession) {
    scanSession = { startedAt: new Date().toISOString(), dimensions: {} };
  }

  // If functionality is not requested, we MUST have an existing manifest to get modules from
  const runFunctionality = dimensions.has("functionality");
  if (!runFunctionality && !existingManifest) {
    throw new Error(
      "Cannot skip Functionality scan — no existing coverit.json found. " +
      "Run a full scan first, then use --dimensions to scan individual dimensions.",
    );
  }

  // Step 3: Initialize AI provider (only needed if any AI dimension is requested)
  const needsAI = runFunctionality || dimensions.has("security") || dimensions.has("stability") || dimensions.has("conformance");
  const provider = needsAI ? (aiProvider ?? (await createAIProvider())) : aiProvider ?? (await createAIProvider());
  logger.debug(`Using AI provider: ${provider.name}`);

  const now = new Date().toISOString();
  let modules: ModuleEntry[];
  let totalSourceFiles: number;
  let totalSourceLines: number;
  let aiResult: ReturnType<typeof parseScaleResponse> | null = null;

  // Preserve scanned dates from existing manifest
  const scannedDates: Record<string, string> = {
    ...(existingManifest?.score.scanned ?? {}),
  };

  // ─── Step 2b: Auto-detect incremental scope from lastScanCommit ──
  let autoIncremental = false;
  let autoChangedFiles: string[] = [];
  let autoAffectedModules = new Set<string>();
  let autoUnmappedFiles: string[] = [];

  if (
    !forceFullScan &&
    existingManifest?.project.lastScanCommit &&
    runFunctionality
  ) {
    const headCommit = await getHeadCommit(projectRoot);
    if (headCommit && headCommit !== existingManifest.project.lastScanCommit) {
      autoChangedFiles = await getFilesSinceCommit(
        existingManifest.project.lastScanCommit,
        projectRoot,
      );
      if (autoChangedFiles.length > 0) {
        const modulePaths = existingManifest.modules.map(m => m.path);
        const mapping = mapFilesToModules(autoChangedFiles, modulePaths);
        autoAffectedModules = mapping.affectedModules;
        autoUnmappedFiles = mapping.unmappedFiles;
        autoIncremental = true;
        logger.info(
          `Auto-incremental: ${autoChangedFiles.length} files changed since last scan, ${autoAffectedModules.size} modules affected`,
        );
        onProgress?.({ type: "phase", name: "Auto-incremental", step: 1, total: dimensions.size });
      } else if (autoChangedFiles.length === 0) {
        // getFilesSinceCommit returned empty — could be same commit or invalid hash
        // If same commit, no changes; if invalid hash, fall through to full scan
        if (headCommit === existingManifest.project.lastScanCommit) {
          // This shouldn't happen (we checked !== above) but guard anyway
        }
        // Empty diff but different HEAD — hash might be invalid, do full scan
        logger.debug("No files in diff despite different HEAD — falling back to full scan");
      }
    } else if (headCommit === existingManifest.project.lastScanCommit) {
      // Exact same commit — nothing changed
      logger.info("Nothing changed since last scan.");
      return existingManifest;
    }
    // If headCommit is null (not a git repo), fall through to full scan
  }

  // ─── Step 4: Functionality scan (or reuse from existing manifest) ──
  if (runFunctionality) {
    const dimCount = dimensions.size;
    onProgress?.({ type: "phase", name: "Functionality", step: 1, total: dimCount });
    const funcStart = Date.now();

    // ── Incremental scan path ──
    if (autoIncremental && existingManifest) {
      const changedFiles = autoChangedFiles;
      const affectedModules = autoAffectedModules;
      const unmappedFiles = autoUnmappedFiles;

      logger.debug(`Changed files: ${changedFiles.length}, affected modules: ${affectedModules.size}, unmapped: ${unmappedFiles.length}`);

      // Use incremental prompt
      const { buildIncrementalScalePrompt } = await import("../ai/scale-prompts.js");
      const incMessages = buildIncrementalScalePrompt(
        projectInfo,
        changedFiles,
        [...affectedModules],
        unmappedFiles,
      );

      const response = await provider.generate(incMessages, {
        allowedTools: ALLOWED_TOOLS,
        cwd: projectRoot,
        timeoutMs,
        onProgress,
      });
      usageTracker.add(response.usage, response.model);

      const incResult = parseScaleResponse(response.content);

      // Merge: start with existing modules, update affected ones
      const updatedMap = new Map(incResult.modules.map(m => [m.path, m]));
      modules = existingManifest.modules.map(existing => {
        const updated = updatedMap.get(existing.path);
        if (updated) {
          const entry = aiModuleToEntry(updated);
          // Preserve existing dimension data (security, stability, conformance)
          entry.security = existing.security;
          entry.stability = existing.stability;
          entry.conformance = existing.conformance;
          return entry;
        }
        return existing;
      });

      // Add newly discovered modules
      for (const [path, mod] of updatedMap) {
        if (!modules.some(m => m.path === path)) {
          modules.push(aiModuleToEntry(mod));
        }
      }

      // Remove modules flagged as deleted (files: 0)
      modules = modules.filter(m => m.files > 0);

      // Use existing totals (incremental scan doesn't recount whole project)
      totalSourceFiles = existingManifest.project.sourceFiles;
      totalSourceLines = existingManifest.project.sourceLines;
      scannedDates.functionality = now;

      // Signal to use existing manifest's journeys/contracts
      aiResult = null;

      scanLog.record({
        name: "Functionality",
        success: true,
        durationMs: Date.now() - funcStart,
        detail: `${affectedModules.size} modules updated (incremental)`,
      });
      onProgress?.({ type: "dimension_status", name: "Functionality", status: "done", detail: `${affectedModules.size} modules updated` });

      // Track dimension completion and save manifest incrementally
      scanSession!.dimensions.functionality = { status: "completed", durationMs: Date.now() - funcStart };
      await writeScanSession(projectRoot, scanSession!);
      await savePartialManifest(projectRoot, existingManifest, modules, projectInfo, totalSourceFiles, totalSourceLines, scannedDates, now, aiResult);
    } else {
      // ── Full scan path (existing code) ──
      const messages = buildScalePrompt(projectInfo, existingManifest ?? undefined);

      logger.debug("Sending analysis prompt to AI with tool access...");
      const response = await provider.generate(messages, {
        allowedTools: ALLOWED_TOOLS,
        cwd: projectRoot,
        timeoutMs,
        onProgress,
      });
      usageTracker.add(response.usage, response.model);

      logger.debug(
        `AI analysis complete (${response.content.length} chars, model: ${response.model})`,
      );

      aiResult = parseScaleResponse(response.content);
      logger.debug(
        `Parsed: ${aiResult.modules.length} modules, ${aiResult.journeys.length} journeys, ${aiResult.contracts.length} contracts`,
      );

      // Override deterministic detection with AI-detected values when available
      if (aiResult.language && VALID_LANGUAGES.has(aiResult.language)) {
        projectInfo = { ...projectInfo, language: aiResult.language as typeof projectInfo.language };
      }
      if (aiResult.framework && VALID_FRAMEWORKS.has(aiResult.framework)) {
        projectInfo = { ...projectInfo, framework: aiResult.framework as typeof projectInfo.framework };
      }
      if (aiResult.testFramework && VALID_TEST_FRAMEWORKS.has(aiResult.testFramework)) {
        projectInfo = { ...projectInfo, testFramework: aiResult.testFramework as typeof projectInfo.testFramework };
      }

      scanLog.record({
        name: "Functionality",
        success: true,
        durationMs: Date.now() - funcStart,
        detail: `${aiResult.modules.length} modules discovered`,
      });

      // Emit completion so the CLI progress display includes Functionality
      onProgress?.({ type: "dimension_status", name: "Functionality", status: "done", detail: `${aiResult.modules.length} modules` });

      // Track dimension completion
      scanSession!.dimensions.functionality = { status: "completed", durationMs: Date.now() - funcStart };
      await writeScanSession(projectRoot, scanSession!);

      // Assemble modules from Functionality result
      modules = aiResult.modules.map(aiModuleToEntry);
      totalSourceFiles =
        aiResult.sourceFiles > 0
          ? aiResult.sourceFiles
          : modules.reduce((sum, m) => sum + m.files, 0);
      totalSourceLines =
        aiResult.sourceLines > 0
          ? aiResult.sourceLines
          : modules.reduce((sum, m) => sum + m.lines, 0);
      scannedDates.functionality = now;

      // Save manifest incrementally so Functionality results survive a kill
      await savePartialManifest(projectRoot, existingManifest, modules, projectInfo, totalSourceFiles, totalSourceLines, scannedDates, now, aiResult);
    }
  } else {
    // Reuse modules from existing coverit.json
    logger.debug("Skipping Functionality scan — reusing modules from existing coverit.json");
    modules = existingManifest!.modules;
    totalSourceFiles = existingManifest!.project.sourceFiles;
    totalSourceLines = existingManifest!.project.sourceLines;
    // Use project info from existing manifest
    projectInfo = {
      ...projectInfo,
      language: existingManifest!.project.language,
      framework: existingManifest!.project.framework,
      testFramework: existingManifest!.project.testFramework,
    };
  }

  // ─── Step 5: Parallel dimension scans (only requested ones) ───
  // Security, Stability, Conformance, and Regression are independent
  // of each other (they all depend only on the modules from Functionality).

  const parallelDims: Promise<void>[] = [];
  if (dimensions.has("security") || dimensions.has("stability") ||
      dimensions.has("conformance") || dimensions.has("regression")) {
    await useaiHeartbeat();
  }

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
    usageTracker,
    scanSession: scanSession!,
  };

  if (dimensions.has("security")) {
    parallelDims.push(runSecurityScan(parallelContext, wrapProgress(onProgress, "Security")));
  }
  if (dimensions.has("stability")) {
    parallelDims.push(runStabilityScan(parallelContext, wrapProgress(onProgress, "Stability")));
  }
  if (dimensions.has("conformance")) {
    parallelDims.push(runConformanceScan(parallelContext, wrapProgress(onProgress, "Conformance")));
  }
  if (dimensions.has("regression")) {
    parallelDims.push(runRegressionScan(parallelContext, wrapProgress(onProgress, "Regression")));
  }

  if (parallelDims.length > 0) {
    await Promise.all(parallelDims);
  }

  // ─── Step 6: Assemble final manifest with all dimensions ───
  // When functionality was skipped or incremental scan was used, reuse journeys/contracts from existing manifest.
  const journeys = (runFunctionality && aiResult)
    ? aiResult.journeys.map((j) => ({
        id: j.id,
        name: j.name,
        steps: j.steps,
        covered: j.covered,
        testFile: j.testFile,
      }))
    : existingManifest?.journeys ?? [];

  const contracts = (runFunctionality && aiResult)
    ? aiResult.contracts.map((c) => ({
        endpoint: c.endpoint,
        method: c.method,
        requestSchema: c.requestSchema,
        responseSchema: c.responseSchema,
        covered: c.covered,
        testFile: c.testFile,
      }))
    : existingManifest?.contracts ?? [];

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
    journeys,
    contracts,

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

  // Set lastScanCommit for auto-incremental on next run
  const headCommitForSave = await getHeadCommit(projectRoot);
  if (headCommitForSave) {
    preliminary.project.lastScanCommit = headCommitForSave;
  }

  // Use the scoring engine for consistent scoring across all scanned dimensions
  const scoreResult = calculateScore(preliminary);

  // Preserve history from existing manifest, append new entry
  const previousHistory = existingManifest?.score.history ?? [];
  const scope_label = autoIncremental ? "incremental" : (existingManifest ? "re-analysis" : "first-time");

  const manifest: CoveritManifest = {
    ...preliminary,
    score: {
      ...scoreResult,
      history: [
        ...previousHistory,
        {
          date: now,
          score: scoreResult.overall,
          scope: scope_label,
        },
      ],
    },
  };

  // Flush scan log and clean up session file
  await scanLog.flush(manifest.score.overall);
  await deleteScanSession(projectRoot);

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
  usageTracker: UsageTracker;
  scanSession: ScanSession;
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
  onProgress?.({ type: "dimension_status", name: "Security", status: "running" });
  try {
    logger.debug("Starting security scan...");
    const secMessages = buildSecurityPrompt(ctx.projectInfo, ctx.modules, ctx.existingManifest?.modules);
    const secResponse = await ctx.provider.generate(secMessages, {
      allowedTools: ALLOWED_TOOLS,
      cwd: ctx.projectRoot,
      timeoutMs: ctx.timeoutMs,
      onProgress,
    });
    ctx.usageTracker.add(secResponse.usage, secResponse.model);
    const secResult = parseSecurityResponse(secResponse.content);
    applySecurityResults(ctx.modules, secResult.modules);
    ctx.scannedDates.security = ctx.now;
    const findings = secResult.modules.reduce((s, m) => s + m.findings.length, 0);
    logger.debug(`Security scan complete: ${findings} findings`);
    ctx.scanSession.dimensions.security = { status: "completed", durationMs: Date.now() - start };
    await writeScanSession(ctx.projectRoot, ctx.scanSession);
    await savePartialManifest(ctx.projectRoot, ctx.existingManifest, ctx.modules, ctx.projectInfo, ctx.totalSourceFiles, ctx.totalSourceLines, ctx.scannedDates, ctx.now, null);
    ctx.scanLog.record({
      name: "Security",
      success: true,
      durationMs: Date.now() - start,
      detail: `${findings} findings across ${secResult.modules.length} modules`,
    });
    onProgress?.({ type: "dimension_status", name: "Security", status: "done", detail: `${findings} findings` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Security scan failed:", msg);
    // Restore previous security data so a failed re-scan doesn't wipe existing findings
    restorePreviousDimensionData(ctx, "security");
    ctx.scanSession.dimensions.security = { status: "failed", durationMs: Date.now() - start };
    await writeScanSession(ctx.projectRoot, ctx.scanSession).catch(() => {});
    ctx.scanLog.record({
      name: "Security",
      success: false,
      durationMs: Date.now() - start,
      error: msg,
    });
    onProgress?.({ type: "dimension_status", name: "Security", status: "failed", detail: msg });
  }
}

async function runStabilityScan(
  ctx: ParallelScanContext,
  onProgress?: (event: AIProgressEvent) => void,
): Promise<void> {
  const start = Date.now();
  onProgress?.({ type: "dimension_status", name: "Stability", status: "running" });
  try {
    logger.debug("Starting stability scan...");
    const stabMessages = buildStabilityPrompt(ctx.projectInfo, ctx.modules, ctx.existingManifest?.modules);
    const stabResponse = await ctx.provider.generate(stabMessages, {
      allowedTools: ALLOWED_TOOLS,
      cwd: ctx.projectRoot,
      timeoutMs: ctx.timeoutMs,
      onProgress,
    });
    ctx.usageTracker.add(stabResponse.usage, stabResponse.model);
    const stabResult = parseStabilityResponse(stabResponse.content);
    applyStabilityResults(ctx.modules, stabResult.modules);
    ctx.scannedDates.stability = ctx.now;
    logger.debug(`Stability scan complete: ${stabResult.modules.length} modules assessed`);
    ctx.scanSession.dimensions.stability = { status: "completed", durationMs: Date.now() - start };
    await writeScanSession(ctx.projectRoot, ctx.scanSession);
    await savePartialManifest(ctx.projectRoot, ctx.existingManifest, ctx.modules, ctx.projectInfo, ctx.totalSourceFiles, ctx.totalSourceLines, ctx.scannedDates, ctx.now, null);
    ctx.scanLog.record({
      name: "Stability",
      success: true,
      durationMs: Date.now() - start,
      detail: `${stabResult.modules.length} modules assessed`,
    });
    onProgress?.({ type: "dimension_status", name: "Stability", status: "done", detail: `${stabResult.modules.length} modules` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Stability scan failed:", msg);
    // Restore previous stability data so a failed re-scan doesn't wipe existing gaps
    restorePreviousDimensionData(ctx, "stability");
    ctx.scanSession.dimensions.stability = { status: "failed", durationMs: Date.now() - start };
    await writeScanSession(ctx.projectRoot, ctx.scanSession).catch(() => {});
    ctx.scanLog.record({
      name: "Stability",
      success: false,
      durationMs: Date.now() - start,
      error: msg,
    });
    onProgress?.({ type: "dimension_status", name: "Stability", status: "failed", detail: msg });
  }
}

async function runConformanceScan(
  ctx: ParallelScanContext,
  onProgress?: (event: AIProgressEvent) => void,
): Promise<void> {
  const start = Date.now();
  onProgress?.({ type: "dimension_status", name: "Conformance", status: "running" });
  try {
    logger.debug("Starting conformance scan...");
    const confMessages = buildConformancePrompt(ctx.projectInfo, ctx.modules, ctx.existingManifest?.modules);
    const confResponse = await ctx.provider.generate(confMessages, {
      allowedTools: ALLOWED_TOOLS,
      cwd: ctx.projectRoot,
      timeoutMs: ctx.timeoutMs,
      onProgress,
    });
    ctx.usageTracker.add(confResponse.usage, confResponse.model);
    const confResult = parseConformanceResponse(confResponse.content);
    applyConformanceResults(ctx.modules, confResult.modules);
    ctx.scannedDates.conformance = ctx.now;
    logger.debug(`Conformance scan complete: ${confResult.modules.length} modules assessed`);
    ctx.scanSession.dimensions.conformance = { status: "completed", durationMs: Date.now() - start };
    await writeScanSession(ctx.projectRoot, ctx.scanSession);
    await savePartialManifest(ctx.projectRoot, ctx.existingManifest, ctx.modules, ctx.projectInfo, ctx.totalSourceFiles, ctx.totalSourceLines, ctx.scannedDates, ctx.now, null);
    ctx.scanLog.record({
      name: "Conformance",
      success: true,
      durationMs: Date.now() - start,
      detail: `${confResult.modules.length} modules assessed`,
    });
    onProgress?.({ type: "dimension_status", name: "Conformance", status: "done", detail: `${confResult.modules.length} modules` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Conformance scan failed:", msg);
    // Restore previous conformance data so a failed re-scan doesn't wipe existing violations
    restorePreviousDimensionData(ctx, "conformance");
    ctx.scanSession.dimensions.conformance = { status: "failed", durationMs: Date.now() - start };
    await writeScanSession(ctx.projectRoot, ctx.scanSession).catch(() => {});
    ctx.scanLog.record({
      name: "Conformance",
      success: false,
      durationMs: Date.now() - start,
      error: msg,
    });
    onProgress?.({ type: "dimension_status", name: "Conformance", status: "failed", detail: msg });
  }
}

async function runRegressionScan(
  ctx: ParallelScanContext,
  onProgress?: (event: AIProgressEvent) => void,
): Promise<void> {
  const start = Date.now();
  onProgress?.({ type: "dimension_status", name: "Regression", status: "running" });
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
      ctx.scanSession.dimensions.regression = { status: "completed", durationMs: Date.now() - start };
      await writeScanSession(ctx.projectRoot, ctx.scanSession);
      ctx.scanLog.record({
        name: "Regression",
        success: true,
        durationMs: Date.now() - start,
        detail: `${runResult.passed}/${runResult.total} tests passed`,
      });
      onProgress?.({ type: "dimension_status", name: "Regression", status: "done", detail: `${runResult.passed}/${runResult.total} passed` });
    } else {
      ctx.scannedDates.regression = ctx.now;
      ctx.scanSession.dimensions.regression = { status: "completed", durationMs: Date.now() - start };
      await writeScanSession(ctx.projectRoot, ctx.scanSession);
      logger.debug("Regression scan: no test files found, marking as scanned");
      ctx.scanLog.record({
        name: "Regression",
        success: true,
        durationMs: Date.now() - start,
        detail: "no test files found",
      });
      onProgress?.({ type: "dimension_status", name: "Regression", status: "done", detail: "no tests" });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Regression scan failed:", msg);
    ctx.scanSession.dimensions.regression = { status: "failed", durationMs: Date.now() - start };
    await writeScanSession(ctx.projectRoot, ctx.scanSession).catch(() => {});
    ctx.scanLog.record({
      name: "Regression",
      success: false,
      durationMs: Date.now() - start,
      error: msg,
    });
    onProgress?.({ type: "dimension_status", name: "Regression", status: "failed", detail: msg });
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

/**
 * Restore previous dimension data from the existing manifest when a dimension scan fails.
 * Matches modules by path and copies the relevant dimension data back, so a failed
 * re-scan doesn't wipe data that was gathered in a previous successful scan.
 */
function restorePreviousDimensionData(
  ctx: ParallelScanContext,
  dimension: "security" | "stability" | "conformance",
): void {
  const existingModules = ctx.existingManifest?.modules;
  if (!existingModules?.length) return;

  const existingMap = new Map(existingModules.map((m) => [m.path, m]));
  let restored = 0;

  for (const mod of ctx.modules) {
    const prev = existingMap.get(mod.path);
    if (!prev) continue;

    if (dimension === "security" && prev.security) {
      mod.security = { ...prev.security };
      restored++;
    } else if (dimension === "stability" && prev.stability) {
      mod.stability = { ...prev.stability };
      restored++;
    } else if (dimension === "conformance" && prev.conformance) {
      mod.conformance = { ...prev.conformance };
      restored++;
    }
  }

  if (restored > 0) {
    // Preserve the previous scanned date since we're using old data
    const prevScanned = ctx.existingManifest?.score.scanned?.[dimension];
    if (prevScanned) {
      ctx.scannedDates[dimension] = prevScanned;
    }
    logger.debug(`Restored previous ${dimension} data for ${restored} modules`);
  }
}

// ─── Incremental Save ────────────────────────────────────────

/**
 * Write a partial manifest to disk so progress survives a kill.
 * Assembles a minimal manifest from whatever dimensions have completed so far.
 */
async function savePartialManifest(
  projectRoot: string,
  existingManifest: CoveritManifest | null,
  modules: ModuleEntry[],
  projectInfo: ProjectInfo,
  totalSourceFiles: number,
  totalSourceLines: number,
  scannedDates: Record<string, string>,
  now: string,
  aiResult: ReturnType<typeof parseScaleResponse> | null,
): Promise<void> {
  try {
    const journeys = aiResult
      ? aiResult.journeys.map((j) => ({
          id: j.id,
          name: j.name,
          steps: j.steps,
          covered: j.covered,
          testFile: j.testFile,
        }))
      : existingManifest?.journeys ?? [];

    const contracts = aiResult
      ? aiResult.contracts.map((c) => ({
          endpoint: c.endpoint,
          method: c.method,
          requestSchema: c.requestSchema,
          responseSchema: c.responseSchema,
          covered: c.covered,
          testFile: c.testFile,
        }))
      : existingManifest?.contracts ?? [];

    const partial: CoveritManifest = {
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
      journeys,
      contracts,
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
        history: existingManifest?.score.history ?? [],
        scanned: scannedDates,
      },
    };

    const scored = calculateScore(partial);
    const manifest: CoveritManifest = { ...partial, score: { ...scored, history: partial.score.history, scanned: scannedDates } };

    const { writeManifest: writeM } = await import("./writer.js");
    await writeM(projectRoot, manifest);
    logger.debug(`Partial manifest saved (score: ${manifest.score.overall}/100)`);
  } catch (err) {
    logger.debug(`Partial manifest save failed: ${err instanceof Error ? err.message : err}`);
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
