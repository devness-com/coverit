/**
 * Coverit Cover — AI-Driven Test Generation Pipeline
 *
 * Reads gaps from coverit.json, sends AI to generate tests for each module,
 * runs the tests, and updates the manifest with new scores.
 *
 * The AI gets full tool access and autonomously:
 *  - Explores source code to understand what to test
 *  - Writes test files
 *  - Runs tests and fixes failures
 *
 * This replaces the old scan → generate → run → fix pipeline with a single
 * AI-driven pass per module, orchestrated by coverit.json gaps.
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

export interface CoverOptions {
  projectRoot: string;
  /** Only cover specific modules (paths from coverit.json) */
  modules?: string[];
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

export interface CoverResult {
  scoreBefore: number;
  scoreAfter: number;
  modulesProcessed: number;
  testsGenerated: number;
  testsPassed: number;
  testsFailed: number;
}

// ─── Constants ───────────────────────────────────────────────

/** Tools the AI can use during test generation */
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

// ─── Core Pipeline ──────────────────────────────────────────

/**
 * Run the cover pipeline: read gaps → generate tests → update manifest.
 *
 * For each module with coverage gaps, sends an AI agent with tool access
 * to write and test code autonomously. After all modules are processed,
 * rescans the project and updates coverit.json with new scores.
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

  // Step 2: Identify gaps
  const gaps = identifyGaps(manifest, options.modules);
  if (gaps.length === 0) {
    logger.debug("No gaps found — nothing to cover");
    return {
      scoreBefore,
      scoreAfter: scoreBefore,
      modulesProcessed: 0,
      testsGenerated: 0,
      testsPassed: 0,
      testsFailed: 0,
    };
  }

  // Sort: high complexity first, then by largest gap
  gaps.sort(
    (a, b) =>
      COMPLEXITY_ORDER[b.complexity] - COMPLEXITY_ORDER[a.complexity] ||
      b.totalGap - a.totalGap,
  );

  logger.debug(
    `Found ${gaps.length} modules with gaps (${gaps.reduce((s, g) => s + g.totalGap, 0)} total missing tests)`,
  );

  // Step 2b: Auto-incremental — only cover modules affected by recent changes
  if (!options.full && !options.modules && manifest.project.lastScanCommit) {
    const headCommit = await getHeadCommit(projectRoot);
    if (headCommit && headCommit === manifest.project.lastScanCommit) {
      // Exact same commit as last scan — nothing new to cover
      logger.info("Nothing changed since last scan — nothing to cover.");
      return {
        scoreBefore,
        scoreAfter: scoreBefore,
        modulesProcessed: 0,
        testsGenerated: 0,
        testsPassed: 0,
        testsFailed: 0,
      };
    }
    if (headCommit) {
      const changedFiles = await getFilesSinceCommit(manifest.project.lastScanCommit, projectRoot);
      if (changedFiles.length > 0) {
        const modulePaths = manifest.modules.map((m) => m.path);
        const { affectedModules } = mapFilesToModules(changedFiles, modulePaths);

        if (affectedModules.size > 0) {
          const beforeCount = gaps.length;
          const filtered = gaps.filter((g) => affectedModules.has(g.path));
          if (filtered.length < beforeCount) {
            gaps.length = 0;
            gaps.push(...filtered);
            logger.info(
              `Incremental: ${changedFiles.length} files changed → ${gaps.length} of ${beforeCount} modules with gaps affected`,
            );
          }
        }
        // If no modules matched changed files but gaps exist, fall through to full
      }
      // If changedFiles is empty (invalid hash), fall through to full
    }
    // If not a git repo, fall through to full
  }

  // Step 3: Resume support — skip modules completed in a previous session
  const resumeEnabled = options.resume !== false;
  let session: CoverSession | null = resumeEnabled
    ? await readCoverSession(projectRoot)
    : null;

  let skippedCount = 0;
  if (session && resumeEnabled) {
    const originalCount = gaps.length;
    const remaining = gaps.filter((g) => {
      const moduleSession = session!.modules[g.path];
      return !moduleSession || moduleSession.status !== "completed";
    });
    skippedCount = originalCount - remaining.length;
    if (skippedCount > 0) {
      logger.debug(`Resuming: skipping ${skippedCount} completed modules`);
      gaps.length = 0;
      gaps.push(...remaining);
    }
  }

  if (gaps.length === 0) {
    logger.debug("All modules already completed — nothing to cover");
    await deleteCoverSession(projectRoot);
    return {
      scoreBefore,
      scoreAfter: scoreBefore,
      modulesProcessed: skippedCount,
      testsGenerated: 0,
      testsPassed: 0,
      testsFailed: 0,
    };
  }

  // Initialize session for tracking
  if (!session) {
    session = { startedAt: new Date().toISOString(), modules: {} };
  }
  for (const gap of gaps) {
    if (!session.modules[gap.path]) {
      session.modules[gap.path] = { status: "pending", attempts: 0 };
    }
  }
  await writeCoverSession(projectRoot, session);

  // Step 4: Initialize AI provider
  const provider = options.aiProvider ?? (await createAIProvider());
  logger.debug(`Using AI provider: ${provider.name}`);

  // Step 5: Process modules in parallel (concurrency-limited)
  // After each module completes, coverit.json is updated incrementally
  // so progress is preserved even if the process is killed mid-way.
  const usageTracker = options.usageTracker ?? new UsageTracker();
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  logger.debug(`Processing modules with concurrency: ${concurrency}`);

  // Emit all modules as pending so the UI can show the full list
  for (const gap of gaps) {
    options.onProgress?.({ type: "module_status", name: gap.path, status: "pending" });
  }

  // Write lock — serializes manifest updates from parallel workers
  let writeQueue = Promise.resolve();

  const moduleResults = await processWithConcurrency(
    gaps,
    concurrency,
    async (gap) => {
      logger.debug(
        `Covering ${gap.path} (${gap.complexity}, ${gap.totalGap} gaps)`,
      );

      // Notify UI this module is now active
      options.onProgress?.({ type: "module_status", name: gap.path, status: "running" });

      // Wrap onProgress per-worker to prefix tool_use events with module path
      // so the multi-line display can route activity to the correct module line
      const moduleProgress = options.onProgress
        ? (event: AIProgressEvent): void => {
            if (event.type === "tool_use") {
              options.onProgress!({
                ...event,
                input: `${gap.path}: ${event.input ?? ""}`,
              });
            } else {
              options.onProgress!(event);
            }
          }
        : undefined;

      // Track module as in_progress
      const moduleSession = session!.modules[gap.path]!;
      moduleSession.status = "in_progress";
      moduleSession.attempts++;
      moduleSession.lastAttemptAt = new Date().toISOString();
      await writeCoverSession(projectRoot, session!);

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
          stats: { testsWritten: summary.testsWritten, testsPassed: summary.testsPassed, testsFailed: summary.testsFailed },
        });
      }

      // Save session + progress incrementally — even on failure the AI may have
      // written test files before timing out, so we capture them.
      const p = writeQueue.then(async () => {
        try {
          await writeCoverSession(projectRoot, session!);
          await rescanAndSaveManifest(projectRoot, manifest);
          logger.debug(`Saved progress after ${gap.path}`);
        } catch (err) {
          logger.debug(`Incremental save failed: ${err instanceof Error ? err.message : err}`);
        }
      });
      writeQueue = p;
      await p;

      // Keep UseAI session alive during long cover runs
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
  const modulesProcessed = gaps.length + skippedCount;

  // Step 6: Final rescan (consistency check — picks up any edge cases)
  logger.debug("Final rescan for consistency...");
  await rescanAndSaveManifest(projectRoot, manifest);

  // Clean up session file on successful completion
  await deleteCoverSession(projectRoot);

  const scoreAfter = manifest.score.overall;
  logger.debug(`Cover complete. Score: ${scoreBefore} → ${scoreAfter}`);

  return {
    scoreBefore,
    scoreAfter,
    modulesProcessed,
    testsGenerated: totalGenerated,
    testsPassed: totalPassed,
    testsFailed: totalFailed,
  };
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
  // Sync scores back to the live manifest
  manifest.score = rescored.score;
  await writeManifest(projectRoot, rescored);
}

// ─── Gap Identification ─────────────────────────────────────

/**
 * Extract modules with coverage gaps from the manifest.
 * A gap exists when expected > current for any test type.
 */
function identifyGaps(
  manifest: CoveritManifest,
  filterModules?: string[],
): ModuleGap[] {
  const result: ModuleGap[] = [];

  for (const mod of manifest.modules) {
    if (filterModules && filterModules.length > 0) {
      if (!filterModules.includes(mod.path)) continue;
    }

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
