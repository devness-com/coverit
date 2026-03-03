/**
 * Coverit Cover — AI-Driven Multi-Dimension Cover Pipeline
 *
 * Reads gaps from coverit.json across all scanned dimensions, sends AI to:
 *  - Functionality: Generate tests to fill expected vs current gaps
 *  - Security: Fix vulnerabilities identified during scan
 *  - Stability: Fix reliability gaps (error handling, timeouts, cleanup)
 *  - Conformance: Fix safe violations (dead code, naming, unused imports)
 *
 * Processes dimensions sequentially: functionality → security → stability → conformance.
 * Each dimension processes its modules with concurrency control.
 * Progress is saved incrementally so killed processes can resume.
 */

import type {
  CoveritManifest,
  FunctionalTestType,
  Complexity,
} from "../schema/coverit-manifest.js";
import { readManifest, writeManifest } from "../scale/writer.js";
import { scanTests } from "../measure/scanner.js";
import { rescoreManifest } from "../measure/scorer.js";
import { createAIProvider } from "../ai/provider-factory.js";
import {
  buildCoverPrompt,
  parseCoverResponse,
  type ModuleGap,
} from "../ai/cover-prompts.js";
import {
  buildSecurityFixPrompt,
  parseSecurityFixResponse,
  type SecurityFixTarget,
  type SecurityFixSummary,
} from "../ai/security-fix-prompts.js";
import {
  buildStabilityFixPrompt,
  parseStabilityFixResponse,
  type StabilityFixTarget,
  type StabilityFixSummary,
} from "../ai/stability-fix-prompts.js";
import {
  buildConformanceFixPrompt,
  parseConformanceFixResponse,
  type ConformanceFixTarget,
  type ConformanceFixSummary,
} from "../ai/conformance-fix-prompts.js";
import type { AIProvider, AIProgressEvent } from "../ai/types.js";
import { UsageTracker } from "../utils/usage-tracker.js";
import {
  readCoverSession,
  writeCoverSession,
  deleteCoverSession,
  type CoverSession,
} from "../utils/session.js";
import { useaiHeartbeat } from "../integrations/useai.js";
import { getHeadCommit, getFilesSinceCommit, mapFilesToModules } from "../utils/git.js";
import { logger } from "../utils/logger.js";

// ─── Types ───────────────────────────────────────────────────

export type CoverDimension = "functionality" | "security" | "stability" | "conformance";

export const ALL_COVER_DIMENSIONS: CoverDimension[] = [
  "functionality", "security", "stability", "conformance",
];

export interface CoverOptions {
  projectRoot: string;
  /** Only cover specific modules (paths from coverit.json) */
  modules?: string[];
  /** Which dimensions to cover (default: all scanned dimensions with gaps) */
  dimensions?: CoverDimension[];
  /** Max modules to process in parallel (default: 3) */
  concurrency?: number;
  /** Timeout per module in milliseconds (default: 600_000 = 10 min) */
  timeoutMs?: number;
  /** Optional AI provider (auto-detected if not provided) */
  aiProvider?: AIProvider;
  /** Callback for streaming progress events */
  onProgress?: (event: AIProgressEvent) => void;
  /** Optional usage tracker — populated with token usage from each AI call */
  usageTracker?: UsageTracker;
  /** Resume from a previous interrupted session (default: true) */
  resume?: boolean;
  /** Force full cover of all gaps, ignoring incremental detection (default: false) */
  full?: boolean;
}

export interface DimensionCoverResult {
  modulesProcessed: number;
  itemsFixed: number;
  itemsSkipped: number;
  filesModified: string[];
}

export interface CoverResult {
  scoreBefore: number;
  scoreAfter: number;
  modulesProcessed: number;
  testsGenerated: number;
  testsPassed: number;
  testsFailed: number;
  dimensionResults: Partial<Record<CoverDimension, DimensionCoverResult>>;
}

// ─── Constants ───────────────────────────────────────────────

/** Tools the AI can use during test generation and code fixes */
const ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Bash", "Write", "Edit"];

/** 10 minutes per module — generous for complex modules */
const PER_MODULE_TIMEOUT_MS = 600_000;

/** Default number of modules to process in parallel */
const DEFAULT_CONCURRENCY = 3;

const COMPLEXITY_ORDER: Record<Complexity, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/** Dimension processing order — functionality first, then code fixes */
const DIMENSION_ORDER: CoverDimension[] = [
  "functionality", "security", "stability", "conformance",
];

// ─── Core Pipeline (Orchestrator) ────────────────────────────

/**
 * Run the cover pipeline across all requested dimensions.
 *
 * Processes dimensions sequentially:
 *  1. Functionality — generate tests to fill gaps
 *  2. Security — fix vulnerabilities
 *  3. Stability — improve error handling and reliability
 *  4. Conformance — fix safe violations (dead code, naming)
 *
 * Each dimension processes its modules with concurrency control.
 * Progress is saved incrementally for resume support.
 */
export async function cover(options: CoverOptions): Promise<CoverResult> {
  const { projectRoot } = options;

  // Step 1: Read manifest
  const manifest = await readManifest(projectRoot);
  if (!manifest) {
    throw new Error(
      "No coverit.json found. Run /coverit:scan first to scan and analyze the codebase.",
    );
  }

  const scoreBefore = manifest.score.overall;
  logger.debug(`Cover starting. Current score: ${scoreBefore}/100`);

  // Step 2: Determine which dimensions to process
  const requestedDims = options.dimensions ?? getScannedCoverDimensions(manifest);
  if (requestedDims.length === 0) {
    logger.debug("No dimensions with gaps — nothing to cover");
    return emptyResult(scoreBefore);
  }

  // Step 3: Auto-incremental — compute affected modules once for all dimensions
  const affectedModules = await computeAffectedModules(options, manifest);

  // Step 4: Initialize AI provider and session
  const provider = options.aiProvider ?? (await createAIProvider());
  const usageTracker = options.usageTracker ?? new UsageTracker();
  const resumeEnabled = options.resume !== false;
  let session: CoverSession | null = resumeEnabled
    ? await readCoverSession(projectRoot)
    : null;
  if (!session) {
    session = { startedAt: new Date().toISOString(), modules: {} };
  }
  session.dimensionStatus = session.dimensionStatus ?? {};

  logger.debug(`Using AI provider: ${provider.name}`);
  logger.debug(`Dimensions to cover: ${requestedDims.join(", ")}`);

  // Step 5: Process dimensions sequentially
  const dimensionResults: Partial<Record<CoverDimension, DimensionCoverResult>> = {};
  let totalTestsGenerated = 0;
  let totalTestsPassed = 0;
  let totalTestsFailed = 0;
  let totalModulesProcessed = 0;

  for (const dim of DIMENSION_ORDER) {
    if (!requestedDims.includes(dim)) continue;

    // Resume: skip completed dimensions
    if (session.dimensionStatus[dim] === "completed" && resumeEnabled) {
      logger.debug(`Skipping ${dim} — already completed in previous session`);
      continue;
    }

    options.onProgress?.({ type: "dimension_status", name: capitalize(dim), status: "running" });
    session.currentDimension = dim;
    session.dimensionStatus[dim] = "running";
    await writeCoverSession(projectRoot, session);

    try {
      let result: DimensionCoverResult;

      switch (dim) {
        case "functionality": {
          const funcResult = await coverFunctionality(
            options, manifest, session, provider, usageTracker, affectedModules,
          );
          result = funcResult.dimensionResult;
          totalTestsGenerated = funcResult.testsGenerated;
          totalTestsPassed = funcResult.testsPassed;
          totalTestsFailed = funcResult.testsFailed;
          break;
        }
        case "security":
          result = await coverSecurity(
            options, manifest, session, provider, usageTracker, affectedModules,
          );
          break;
        case "stability":
          result = await coverStability(
            options, manifest, session, provider, usageTracker, affectedModules,
          );
          break;
        case "conformance":
          result = await coverConformance(
            options, manifest, session, provider, usageTracker, affectedModules,
          );
          break;
      }

      dimensionResults[dim] = result;
      totalModulesProcessed += result.modulesProcessed;
      session.dimensionStatus[dim] = "completed";
      await writeCoverSession(projectRoot, session);
      options.onProgress?.({
        type: "dimension_status",
        name: capitalize(dim),
        status: "done",
        detail: formatDimensionDetail(dim, result),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`${dim} cover failed: ${message}`);
      session.dimensionStatus[dim] = "failed";
      await writeCoverSession(projectRoot, session).catch(() => {});
      options.onProgress?.({ type: "dimension_status", name: capitalize(dim), status: "failed" });
      // Continue to next dimension — don't let one failure block others
    }
  }

  // Step 6: Final rescan for consistency
  logger.debug("Final rescan for consistency...");
  await rescanAndSaveManifest(projectRoot, manifest);

  // Clean up session on successful completion
  await deleteCoverSession(projectRoot);

  const scoreAfter = manifest.score.overall;
  logger.debug(`Cover complete. Score: ${scoreBefore} → ${scoreAfter}`);

  return {
    scoreBefore,
    scoreAfter,
    modulesProcessed: totalModulesProcessed,
    testsGenerated: totalTestsGenerated,
    testsPassed: totalTestsPassed,
    testsFailed: totalTestsFailed,
    dimensionResults,
  };
}

// ─── Functionality Cover ────────────────────────────────────

interface FunctionalityCoverResult {
  dimensionResult: DimensionCoverResult;
  testsGenerated: number;
  testsPassed: number;
  testsFailed: number;
}

/**
 * Cover functionality gaps by generating tests.
 * This is the original cover behavior, extracted into its own function.
 */
async function coverFunctionality(
  options: CoverOptions,
  manifest: CoveritManifest,
  session: CoverSession,
  provider: AIProvider,
  usageTracker: UsageTracker,
  affectedModules: Set<string> | null,
): Promise<FunctionalityCoverResult> {
  const { projectRoot } = options;
  const gaps = identifyFunctionalityGaps(manifest, options.modules, affectedModules);

  if (gaps.length === 0) {
    logger.debug("No functionality gaps — skipping");
    return {
      dimensionResult: { modulesProcessed: 0, itemsFixed: 0, itemsSkipped: 0, filesModified: [] },
      testsGenerated: 0, testsPassed: 0, testsFailed: 0,
    };
  }

  // Sort: high complexity first, then by largest gap
  gaps.sort(
    (a, b) =>
      COMPLEXITY_ORDER[b.complexity] - COMPLEXITY_ORDER[a.complexity] ||
      b.totalGap - a.totalGap,
  );

  logger.debug(
    `Found ${gaps.length} modules with functionality gaps (${gaps.reduce((s, g) => s + g.totalGap, 0)} total missing tests)`,
  );

  // Resume: skip completed functionality modules
  const resumeEnabled = options.resume !== false;
  let skippedCount = 0;
  if (resumeEnabled) {
    const originalCount = gaps.length;
    const remaining = gaps.filter((g) => {
      const moduleSession = session.modules[g.path];
      return !moduleSession || moduleSession.status !== "completed";
    });
    skippedCount = originalCount - remaining.length;
    if (skippedCount > 0) {
      logger.debug(`Resuming functionality: skipping ${skippedCount} completed modules`);
      gaps.length = 0;
      gaps.push(...remaining);
    }
  }

  if (gaps.length === 0) {
    return {
      dimensionResult: { modulesProcessed: skippedCount, itemsFixed: 0, itemsSkipped: 0, filesModified: [] },
      testsGenerated: 0, testsPassed: 0, testsFailed: 0,
    };
  }

  // Initialize session tracking
  for (const gap of gaps) {
    if (!session.modules[gap.path]) {
      session.modules[gap.path] = { status: "pending", attempts: 0 };
    }
  }
  await writeCoverSession(options.projectRoot, session);

  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

  // Emit all modules as pending
  for (const gap of gaps) {
    options.onProgress?.({ type: "module_status", name: gap.path, status: "pending", dimension: "functionality" });
  }

  // Write lock — serializes manifest updates from parallel workers
  let writeQueue = Promise.resolve();

  const moduleResults = await processWithConcurrency(
    gaps,
    concurrency,
    async (gap) => {
      logger.debug(`Covering ${gap.path} (${gap.complexity}, ${gap.totalGap} gaps)`);
      options.onProgress?.({ type: "module_status", name: gap.path, status: "running", dimension: "functionality" });

      const moduleProgress = wrapModuleProgress(options.onProgress, gap.path);

      const moduleSession = session.modules[gap.path]!;
      moduleSession.status = "in_progress";
      moduleSession.attempts++;
      moduleSession.lastAttemptAt = new Date().toISOString();
      await writeCoverSession(projectRoot, session);

      let summary = { testsWritten: 0, testsPassed: 0, testsFailed: 0, files: [] as string[] };

      try {
        const messages = buildCoverPrompt(gap, manifest.project);
        const response = await provider.generate(messages, {
          allowedTools: ALLOWED_TOOLS,
          cwd: projectRoot,
          timeoutMs: options.timeoutMs ?? PER_MODULE_TIMEOUT_MS,
          onProgress: moduleProgress,
        });
        usageTracker.add(response.usage, response.model);

        summary = parseCoverResponse(response.content);
        logger.debug(
          `${gap.path}: ${summary.testsWritten} written, ${summary.testsPassed} passed, ${summary.testsFailed} failed`,
        );

        moduleSession.status = "completed";
        options.onProgress?.({
          type: "module_status",
          name: gap.path,
          status: "done",
          dimension: "functionality",
          stats: { testsWritten: summary.testsWritten, testsPassed: summary.testsPassed, testsFailed: summary.testsFailed },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`Failed to cover ${gap.path}: ${message}`);
        const timedOut = message.includes("timed out");
        moduleSession.status = timedOut ? "timed_out" : "failed";
        options.onProgress?.({
          type: "module_status",
          name: gap.path,
          status: timedOut ? "timed_out" : "failed",
          dimension: "functionality",
          stats: { testsWritten: summary.testsWritten, testsPassed: summary.testsPassed, testsFailed: summary.testsFailed },
        });
      }

      const p = writeQueue.then(async () => {
        try {
          await writeCoverSession(projectRoot, session);
          await rescanAndSaveManifest(projectRoot, manifest);
          logger.debug(`Saved progress after ${gap.path}`);
        } catch (err) {
          logger.debug(`Incremental save failed: ${err instanceof Error ? err.message : err}`);
        }
      });
      writeQueue = p;
      await p;

      await useaiHeartbeat();
      return summary;
    },
  );

  let totalGenerated = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  for (const result of moduleResults) {
    totalGenerated += result.testsWritten;
    totalPassed += result.testsPassed;
    totalFailed += result.testsFailed;
  }

  return {
    dimensionResult: {
      modulesProcessed: gaps.length + skippedCount,
      itemsFixed: totalGenerated,
      itemsSkipped: 0,
      filesModified: moduleResults.flatMap((r) => r.files),
    },
    testsGenerated: totalGenerated,
    testsPassed: totalPassed,
    testsFailed: totalFailed,
  };
}

// ─── Security Cover ─────────────────────────────────────────

/**
 * Cover security gaps by fixing vulnerabilities in source code.
 * Processes modules sequentially (concurrency=1) since security fixes
 * may have cross-file implications.
 */
async function coverSecurity(
  options: CoverOptions,
  manifest: CoveritManifest,
  session: CoverSession,
  provider: AIProvider,
  usageTracker: UsageTracker,
  affectedModules: Set<string> | null,
): Promise<DimensionCoverResult> {
  const { projectRoot } = options;
  const targets = identifySecurityGaps(manifest, options.modules, affectedModules);

  if (targets.length === 0) {
    logger.debug("No security gaps — skipping");
    return { modulesProcessed: 0, itemsFixed: 0, itemsSkipped: 0, filesModified: [] };
  }

  logger.debug(`Found ${targets.length} modules with security findings (${targets.reduce((s, t) => s + t.findings.length, 0)} total)`);

  session.securityModules = session.securityModules ?? {};
  let totalFixed = 0;
  let totalSkipped = 0;
  const allFilesModified: string[] = [];

  for (const target of targets) {
    // Resume: skip completed modules
    const moduleSession = session.securityModules[target.path];
    if (moduleSession?.status === "completed" && options.resume !== false) continue;

    session.securityModules[target.path] = {
      status: "in_progress",
      attempts: (moduleSession?.attempts ?? 0) + 1,
      lastAttemptAt: new Date().toISOString(),
    };
    await writeCoverSession(projectRoot, session);

    options.onProgress?.({ type: "module_status", name: target.path, status: "running", dimension: "security" });

    try {
      const messages = buildSecurityFixPrompt(target, manifest.project);
      const response = await provider.generate(messages, {
        allowedTools: ALLOWED_TOOLS,
        cwd: projectRoot,
        timeoutMs: options.timeoutMs ?? PER_MODULE_TIMEOUT_MS,
        onProgress: wrapModuleProgress(options.onProgress, target.path),
      });
      usageTracker.add(response.usage, response.model);

      const summary = parseSecurityFixResponse(response.content);
      totalFixed += summary.findingsFixed;
      totalSkipped += summary.findingsSkipped;
      allFilesModified.push(...summary.filesModified);

      applySecurityFix(manifest, target.path, summary);
      await rescoreAndSaveManifest(projectRoot, manifest);

      logger.debug(`${target.path}: ${summary.findingsFixed} fixed, ${summary.findingsSkipped} skipped`);

      session.securityModules[target.path] = {
        status: "completed",
        attempts: session.securityModules[target.path]!.attempts,
      };
      options.onProgress?.({
        type: "module_status",
        name: target.path,
        status: "done",
        dimension: "security",
        detail: `${summary.findingsFixed} fixed`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to fix security in ${target.path}: ${message}`);
      session.securityModules[target.path]!.status = message.includes("timed out") ? "timed_out" : "failed";
      options.onProgress?.({
        type: "module_status",
        name: target.path,
        status: message.includes("timed out") ? "timed_out" : "failed",
        dimension: "security",
      });
    }

    await writeCoverSession(projectRoot, session);
    await useaiHeartbeat();
  }

  return {
    modulesProcessed: targets.length,
    itemsFixed: totalFixed,
    itemsSkipped: totalSkipped,
    filesModified: [...new Set(allFilesModified)],
  };
}

// ─── Stability Cover ────────────────────────────────────────

/**
 * Cover stability gaps by fixing error handling, timeouts, cleanup, etc.
 */
async function coverStability(
  options: CoverOptions,
  manifest: CoveritManifest,
  session: CoverSession,
  provider: AIProvider,
  usageTracker: UsageTracker,
  affectedModules: Set<string> | null,
): Promise<DimensionCoverResult> {
  const { projectRoot } = options;
  const targets = identifyStabilityGaps(manifest, options.modules, affectedModules);

  if (targets.length === 0) {
    logger.debug("No stability gaps — skipping");
    return { modulesProcessed: 0, itemsFixed: 0, itemsSkipped: 0, filesModified: [] };
  }

  logger.debug(`Found ${targets.length} modules with stability gaps (${targets.reduce((s, t) => s + t.gaps.length, 0)} total)`);

  session.stabilityModules = session.stabilityModules ?? {};
  let totalFixed = 0;
  let totalSkipped = 0;
  const allFilesModified: string[] = [];

  for (const target of targets) {
    const moduleSession = session.stabilityModules[target.path];
    if (moduleSession?.status === "completed" && options.resume !== false) continue;

    session.stabilityModules[target.path] = {
      status: "in_progress",
      attempts: (moduleSession?.attempts ?? 0) + 1,
      lastAttemptAt: new Date().toISOString(),
    };
    await writeCoverSession(projectRoot, session);

    options.onProgress?.({ type: "module_status", name: target.path, status: "running", dimension: "stability" });

    try {
      const messages = buildStabilityFixPrompt(target, manifest.project);
      const response = await provider.generate(messages, {
        allowedTools: ALLOWED_TOOLS,
        cwd: projectRoot,
        timeoutMs: options.timeoutMs ?? PER_MODULE_TIMEOUT_MS,
        onProgress: wrapModuleProgress(options.onProgress, target.path),
      });
      usageTracker.add(response.usage, response.model);

      const summary = parseStabilityFixResponse(response.content);
      totalFixed += summary.gapsFixed;
      totalSkipped += summary.gapsSkipped;
      allFilesModified.push(...summary.filesModified);

      applyStabilityFix(manifest, target.path, summary);
      await rescoreAndSaveManifest(projectRoot, manifest);

      logger.debug(`${target.path}: ${summary.gapsFixed} fixed, score ${target.score} → ${summary.newScore}`);

      session.stabilityModules[target.path] = {
        status: "completed",
        attempts: session.stabilityModules[target.path]!.attempts,
      };
      options.onProgress?.({
        type: "module_status",
        name: target.path,
        status: "done",
        dimension: "stability",
        detail: `${summary.gapsFixed} fixed, score → ${summary.newScore}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to fix stability in ${target.path}: ${message}`);
      session.stabilityModules[target.path]!.status = message.includes("timed out") ? "timed_out" : "failed";
      options.onProgress?.({
        type: "module_status",
        name: target.path,
        status: message.includes("timed out") ? "timed_out" : "failed",
        dimension: "stability",
      });
    }

    await writeCoverSession(projectRoot, session);
    await useaiHeartbeat();
  }

  return {
    modulesProcessed: targets.length,
    itemsFixed: totalFixed,
    itemsSkipped: totalSkipped,
    filesModified: [...new Set(allFilesModified)],
  };
}

// ─── Conformance Cover ──────────────────────────────────────

/**
 * Cover conformance gaps by fixing safe violations (dead code, naming).
 * Skips risky violations (layer violations, architectural drift).
 */
async function coverConformance(
  options: CoverOptions,
  manifest: CoveritManifest,
  session: CoverSession,
  provider: AIProvider,
  usageTracker: UsageTracker,
  affectedModules: Set<string> | null,
): Promise<DimensionCoverResult> {
  const { projectRoot } = options;
  const targets = identifyConformanceGaps(manifest, options.modules, affectedModules);

  if (targets.length === 0) {
    logger.debug("No conformance gaps — skipping");
    return { modulesProcessed: 0, itemsFixed: 0, itemsSkipped: 0, filesModified: [] };
  }

  logger.debug(`Found ${targets.length} modules with conformance violations (${targets.reduce((s, t) => s + t.violations.length, 0)} total)`);

  session.conformanceModules = session.conformanceModules ?? {};
  let totalFixed = 0;
  let totalSkipped = 0;
  const allFilesModified: string[] = [];

  for (const target of targets) {
    const moduleSession = session.conformanceModules[target.path];
    if (moduleSession?.status === "completed" && options.resume !== false) continue;

    session.conformanceModules[target.path] = {
      status: "in_progress",
      attempts: (moduleSession?.attempts ?? 0) + 1,
      lastAttemptAt: new Date().toISOString(),
    };
    await writeCoverSession(projectRoot, session);

    options.onProgress?.({ type: "module_status", name: target.path, status: "running", dimension: "conformance" });

    try {
      const messages = buildConformanceFixPrompt(target, manifest.project);
      const response = await provider.generate(messages, {
        allowedTools: ALLOWED_TOOLS,
        cwd: projectRoot,
        timeoutMs: options.timeoutMs ?? PER_MODULE_TIMEOUT_MS,
        onProgress: wrapModuleProgress(options.onProgress, target.path),
      });
      usageTracker.add(response.usage, response.model);

      const summary = parseConformanceFixResponse(response.content);
      totalFixed += summary.violationsFixed;
      totalSkipped += summary.violationsSkipped;
      allFilesModified.push(...summary.filesModified);

      applyConformanceFix(manifest, target.path, summary);
      await rescoreAndSaveManifest(projectRoot, manifest);

      logger.debug(`${target.path}: ${summary.violationsFixed} fixed, ${summary.violationsSkipped} skipped, score ${target.score} → ${summary.newScore}`);

      session.conformanceModules[target.path] = {
        status: "completed",
        attempts: session.conformanceModules[target.path]!.attempts,
      };
      options.onProgress?.({
        type: "module_status",
        name: target.path,
        status: "done",
        dimension: "conformance",
        detail: `${summary.violationsFixed} fixed, ${summary.violationsSkipped} skipped`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to fix conformance in ${target.path}: ${message}`);
      session.conformanceModules[target.path]!.status = message.includes("timed out") ? "timed_out" : "failed";
      options.onProgress?.({
        type: "module_status",
        name: target.path,
        status: message.includes("timed out") ? "timed_out" : "failed",
        dimension: "conformance",
      });
    }

    await writeCoverSession(projectRoot, session);
    await useaiHeartbeat();
  }

  return {
    modulesProcessed: targets.length,
    itemsFixed: totalFixed,
    itemsSkipped: totalSkipped,
    filesModified: [...new Set(allFilesModified)],
  };
}

// ─── Incremental Detection ──────────────────────────────────

/**
 * Compute affected modules since last scan for incremental filtering.
 * Returns null when incremental is bypassed (--full, --modules, no lastScanCommit).
 */
async function computeAffectedModules(
  options: CoverOptions,
  manifest: CoveritManifest,
): Promise<Set<string> | null> {
  if (options.full || options.modules || !manifest.project.lastScanCommit) {
    return null; // No incremental filtering
  }

  const headCommit = await getHeadCommit(options.projectRoot);
  if (!headCommit) return null;

  if (headCommit === manifest.project.lastScanCommit) {
    // Exact same commit — still return null to let dimension handlers decide
    // whether they have gaps worth covering
    return null;
  }

  const changedFiles = await getFilesSinceCommit(manifest.project.lastScanCommit, options.projectRoot);
  if (changedFiles.length === 0) return null;

  const modulePaths = manifest.modules.map((m) => m.path);
  const { affectedModules } = mapFilesToModules(changedFiles, modulePaths);

  if (affectedModules.size > 0) {
    logger.info(`Incremental: ${changedFiles.length} files changed → ${affectedModules.size} modules affected`);
    return affectedModules;
  }

  return null;
}

// ─── Gap Identification ─────────────────────────────────────

/**
 * Extract modules with functionality test gaps.
 * A gap exists when expected > current for any test type.
 */
function identifyFunctionalityGaps(
  manifest: CoveritManifest,
  filterModules?: string[],
  affectedModules?: Set<string> | null,
): ModuleGap[] {
  const result: ModuleGap[] = [];

  for (const mod of manifest.modules) {
    if (filterModules?.length && !filterModules.includes(mod.path)) continue;
    if (affectedModules && !affectedModules.has(mod.path)) continue;

    const gaps: ModuleGap["gaps"] = {};
    let totalGap = 0;
    const existingTestFiles: string[] = [];

    for (const [type, coverage] of Object.entries(mod.functionality.tests)) {
      const cov = coverage as { expected: number; current: number; files: string[] };
      const gap = cov.expected - cov.current;
      if (gap > 0) {
        gaps[type as FunctionalTestType] = {
          expected: cov.expected,
          current: cov.current,
          gap,
        };
        totalGap += gap;
      }
      existingTestFiles.push(...cov.files);
    }

    if (totalGap > 0) {
      result.push({
        path: mod.path,
        complexity: mod.complexity,
        gaps,
        totalGap,
        existingTestFiles,
      });
    }
  }

  return result;
}

/**
 * Extract modules with unresolved security findings.
 */
function identifySecurityGaps(
  manifest: CoveritManifest,
  filterModules?: string[],
  affectedModules?: Set<string> | null,
): SecurityFixTarget[] {
  return manifest.modules
    .filter((mod) => {
      if (filterModules?.length && !filterModules.includes(mod.path)) return false;
      if (affectedModules && !affectedModules.has(mod.path)) return false;
      return mod.security.findings.length > 0;
    })
    .map((mod) => ({
      path: mod.path,
      complexity: mod.complexity,
      findings: mod.security.findings,
    }));
}

/**
 * Extract modules with stability gaps.
 */
function identifyStabilityGaps(
  manifest: CoveritManifest,
  filterModules?: string[],
  affectedModules?: Set<string> | null,
): StabilityFixTarget[] {
  return manifest.modules
    .filter((mod) => {
      if (filterModules?.length && !filterModules.includes(mod.path)) return false;
      if (affectedModules && !affectedModules.has(mod.path)) return false;
      return mod.stability.gaps.length > 0;
    })
    .map((mod) => ({
      path: mod.path,
      complexity: mod.complexity,
      score: mod.stability.score,
      gaps: mod.stability.gaps,
    }));
}

/**
 * Extract modules with conformance violations.
 */
function identifyConformanceGaps(
  manifest: CoveritManifest,
  filterModules?: string[],
  affectedModules?: Set<string> | null,
): ConformanceFixTarget[] {
  return manifest.modules
    .filter((mod) => {
      if (filterModules?.length && !filterModules.includes(mod.path)) return false;
      if (affectedModules && !affectedModules.has(mod.path)) return false;
      return mod.conformance.violations.length > 0;
    })
    .map((mod) => ({
      path: mod.path,
      complexity: mod.complexity,
      score: mod.conformance.score,
      violations: mod.conformance.violations,
    }));
}

// ─── Dimension Detection ────────────────────────────────────

/**
 * Determine which dimensions have been scanned AND have gaps worth covering.
 *
 * Functionality is always checked if there are gaps (even without explicit
 * `scanned.functionality` timestamp) since test gaps are self-evident from
 * expected vs current counts. Other dimensions require a scan timestamp
 * because their gaps come from AI analysis, not filesystem counts.
 */
function getScannedCoverDimensions(manifest: CoveritManifest): CoverDimension[] {
  const scanned = manifest.score.scanned ?? {};
  const result: CoverDimension[] = [];

  // Functionality: always coverable if gaps exist (test counts are objective)
  const hasFuncGaps = manifest.modules.some((mod) =>
    Object.values(mod.functionality.tests).some(
      (cov) => {
        const c = cov as { expected: number; current: number };
        return c.expected > c.current;
      },
    ),
  );
  if (hasFuncGaps) result.push("functionality");

  // Other dimensions: require a scan to have identified the gaps
  if (scanned.security) {
    if (manifest.modules.some((mod) => mod.security.findings.length > 0)) {
      result.push("security");
    }
  }

  if (scanned.stability) {
    if (manifest.modules.some((mod) => mod.stability.gaps.length > 0)) {
      result.push("stability");
    }
  }

  if (scanned.conformance) {
    if (manifest.modules.some((mod) => mod.conformance.violations.length > 0)) {
      result.push("conformance");
    }
  }

  return result;
}

// ─── Manifest Update Helpers ────────────────────────────────

/**
 * Apply security fix results to the manifest.
 * Removes resolved findings and updates counts.
 */
function applySecurityFix(
  manifest: CoveritManifest,
  modulePath: string,
  summary: SecurityFixSummary,
): void {
  const mod = manifest.modules.find((m) => m.path === modulePath);
  if (!mod) return;

  const resolvedSet = new Set(summary.resolvedFindings);
  mod.security.findings = mod.security.findings.filter((f) => !resolvedSet.has(f));
  mod.security.issues = mod.security.findings.length;
  mod.security.resolved += summary.findingsFixed;
}

/**
 * Apply stability fix results to the manifest.
 * Removes resolved gaps and updates module score.
 */
function applyStabilityFix(
  manifest: CoveritManifest,
  modulePath: string,
  summary: StabilityFixSummary,
): void {
  const mod = manifest.modules.find((m) => m.path === modulePath);
  if (!mod) return;

  const resolvedSet = new Set(summary.resolvedGaps);
  mod.stability.gaps = mod.stability.gaps.filter((g) => !resolvedSet.has(g));
  mod.stability.score = summary.newScore;
}

/**
 * Apply conformance fix results to the manifest.
 * Removes resolved violations and updates module score.
 */
function applyConformanceFix(
  manifest: CoveritManifest,
  modulePath: string,
  summary: ConformanceFixSummary,
): void {
  const mod = manifest.modules.find((m) => m.path === modulePath);
  if (!mod) return;

  const resolvedSet = new Set(summary.resolvedViolations);
  mod.conformance.violations = mod.conformance.violations.filter((v) => !resolvedSet.has(v));
  mod.conformance.score = summary.newScore;
}

// ─── Incremental Manifest Update ─────────────────────────────

/**
 * Rescan all test files, update module entries in the manifest, rescore,
 * and write to disk. Mutates the manifest in-place so the live state
 * stays in sync across parallel workers.
 *
 * This is fast (~1s) because scanTests is pure filesystem — no AI.
 */
async function rescanAndSaveManifest(
  projectRoot: string,
  manifest: CoveritManifest,
): Promise<void> {
  const scanResult = await scanTests(projectRoot, manifest.modules);

  for (const mod of manifest.modules) {
    const moduleData = scanResult.byModule.get(mod.path);
    if (!moduleData) continue;

    for (const [testType, scannedData] of Object.entries(moduleData.tests)) {
      const typedKey = testType as FunctionalTestType;
      const existing = mod.functionality.tests[typedKey];
      if (existing) {
        existing.current = scannedData.current;
        existing.files = scannedData.files;
      } else {
        mod.functionality.tests[typedKey] = {
          expected: 0,
          current: scannedData.current,
          files: scannedData.files,
        };
      }
    }
  }

  const rescored = rescoreManifest(manifest);
  manifest.score = rescored.score;
  await writeManifest(projectRoot, rescored);
}

/**
 * Rescore and save without rescanning test files.
 * Used after security/stability/conformance fixes where
 * only the dimension data changed, not test files.
 */
async function rescoreAndSaveManifest(
  projectRoot: string,
  manifest: CoveritManifest,
): Promise<void> {
  const rescored = rescoreManifest(manifest);
  manifest.score = rescored.score;
  await writeManifest(projectRoot, rescored);
}

// ─── Progress Helpers ───────────────────────────────────────

/**
 * Wrap onProgress to prefix tool_use events with module path
 * so the multi-line display can route activity to the correct module line.
 */
function wrapModuleProgress(
  onProgress: ((event: AIProgressEvent) => void) | undefined,
  modulePath: string,
): ((event: AIProgressEvent) => void) | undefined {
  if (!onProgress) return undefined;
  return (event: AIProgressEvent): void => {
    if (event.type === "tool_use") {
      onProgress({
        ...event,
        input: `${modulePath}: ${event.input ?? ""}`,
      });
    } else {
      onProgress(event);
    }
  };
}

function formatDimensionDetail(dim: CoverDimension, result: DimensionCoverResult): string {
  if (result.modulesProcessed === 0) return "no gaps";
  switch (dim) {
    case "functionality":
      return `${result.itemsFixed} tests generated`;
    case "security":
      return `${result.itemsFixed} findings fixed${result.itemsSkipped > 0 ? `, ${result.itemsSkipped} skipped` : ""}`;
    case "stability":
      return `${result.itemsFixed} gaps fixed${result.itemsSkipped > 0 ? `, ${result.itemsSkipped} skipped` : ""}`;
    case "conformance":
      return `${result.itemsFixed} violations fixed${result.itemsSkipped > 0 ? `, ${result.itemsSkipped} skipped` : ""}`;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Utility Helpers ────────────────────────────────────────

function emptyResult(scoreBefore: number): CoverResult {
  return {
    scoreBefore,
    scoreAfter: scoreBefore,
    modulesProcessed: 0,
    testsGenerated: 0,
    testsPassed: 0,
    testsFailed: 0,
    dimensionResults: {},
  };
}

// ─── Concurrency Helper ──────────────────────────────────────

/**
 * Process items in parallel with a concurrency limit.
 * Workers pick items from a shared queue, so work is distributed evenly.
 */
async function processWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  processor: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await processor(items[index]!, index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => worker(),
    ),
  );
  return results;
}
