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
import type { AIProvider } from "../ai/types.js";
import { logger } from "../utils/logger.js";

// ─── Types ───────────────────────────────────────────────────

export interface CoverOptions {
  projectRoot: string;
  /** Only cover specific modules (paths from coverit.json) */
  modules?: string[];
  /** Optional AI provider (auto-detected if not provided) */
  aiProvider?: AIProvider;
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

  // Step 3: Initialize AI provider
  const provider = options.aiProvider ?? (await createAIProvider());
  logger.debug(`Using AI provider: ${provider.name}`);

  // Step 4: Process each module
  let totalGenerated = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  let modulesProcessed = 0;

  for (const gap of gaps) {
    logger.debug(
      `Covering ${gap.path} (${gap.complexity}, ${gap.totalGap} gaps)`,
    );

    try {
      const messages = buildCoverPrompt(gap, manifest.project);
      const response = await provider.generate(messages, {
        allowedTools: ALLOWED_TOOLS,
        cwd: projectRoot,
        timeoutMs: PER_MODULE_TIMEOUT_MS,
      });

      const summary = parseCoverResponse(response.content);
      totalGenerated += summary.testsWritten;
      totalPassed += summary.testsPassed;
      totalFailed += summary.testsFailed;
      modulesProcessed++;

      logger.debug(
        `${gap.path}: ${summary.testsWritten} written, ${summary.testsPassed} passed, ${summary.testsFailed} failed`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to cover ${gap.path}: ${message}`);
      modulesProcessed++;
    }
  }

  // Step 5: Rescan and update manifest
  logger.debug("Rescanning test files and updating manifest...");

  const currentManifest = (await readManifest(projectRoot)) ?? manifest;
  const scanResult = await scanTests(projectRoot, currentManifest.modules);

  for (const mod of currentManifest.modules) {
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

  const rescored = rescoreManifest(currentManifest);
  await writeManifest(projectRoot, rescored);

  const scoreAfter = rescored.score.overall;
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
