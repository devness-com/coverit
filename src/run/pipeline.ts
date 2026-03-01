/**
 * Coverit Run — Run Existing Tests, Fix Failures, Update Manifest
 *
 * Unlike `cover` (which writes new tests for gaps), `run` assumes
 * tests already exist and just runs + fixes them via AI.
 *
 * Pipeline:
 *  1. Read manifest → collect all test files from modules
 *  2. Run them via project test runner
 *  3. If failures, send AI to fix
 *  4. Rescan → rescore → write manifest
 */

import type {
  CoveritManifest,
  FunctionalTestType,
} from "../schema/coverit-manifest.js";
import { readManifest, writeManifest } from "../scale/writer.js";
import { scanTests } from "../measure/scanner.js";
import { rescoreManifest } from "../measure/scorer.js";
import { createAIProvider } from "../ai/provider-factory.js";
import {
  buildRunFixPrompt,
  parseRunFixResponse,
} from "../ai/run-prompts.js";
import type { AIProvider, AIProgressEvent } from "../ai/types.js";
import { logger } from "../utils/logger.js";

// ─── Types ───────────────────────────────────────────────────

export interface RunOptions {
  projectRoot: string;
  /** Only run tests for specific modules (paths from coverit.json) */
  modules?: string[];
  /** Optional AI provider (auto-detected if not provided) */
  aiProvider?: AIProvider;
  /** Callback for streaming progress events */
  onProgress?: (event: AIProgressEvent) => void;
}

export interface RunResult {
  scoreBefore: number;
  scoreAfter: number;
  totalTests: number;
  passed: number;
  failed: number;
  fixed: number;
}

// ─── Constants ───────────────────────────────────────────────

/** Tools the AI can use during test fixing (no Write — only fixing) */
const ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Bash", "Edit"];

/** 10 minutes per fix attempt */
const FIX_TIMEOUT_MS = 600_000;

// ─── Core Pipeline ──────────────────────────────────────────

/**
 * Run existing tests, fix failures via AI, rescan and update manifest.
 */
export async function runTests(options: RunOptions): Promise<RunResult> {
  const { projectRoot } = options;

  // Step 1: Read manifest
  const manifest = await readManifest(projectRoot);
  if (!manifest) {
    throw new Error(
      "No coverit.json found. Run /coverit:scan first to scan and analyze the codebase.",
    );
  }

  const scoreBefore = manifest.score.overall;
  logger.debug(`Run starting. Current score: ${scoreBefore}/100`);

  // Step 2: Collect test files from modules
  const testFiles = collectTestFiles(manifest, options.modules);
  if (testFiles.length === 0) {
    logger.debug("No test files found — nothing to run");
    return {
      scoreBefore,
      scoreAfter: scoreBefore,
      totalTests: 0,
      passed: 0,
      failed: 0,
      fixed: 0,
    };
  }

  logger.debug(`Found ${testFiles.length} test files to run`);

  // Step 3: Run tests
  const testRunner = detectTestRunner(manifest);
  const runResult = await executeTests(projectRoot, testFiles, testRunner);

  logger.debug(
    `Test run: ${runResult.passed} passed, ${runResult.failed} failed out of ${runResult.total}`,
  );

  // Step 4: If failures, send AI to fix
  let fixed = 0;
  if (runResult.failed > 0 && runResult.failingFiles.length > 0) {
    logger.debug(
      `Sending ${runResult.failingFiles.length} failing files to AI for fixing...`,
    );

    const provider = options.aiProvider ?? (await createAIProvider());
    logger.debug(`Using AI provider: ${provider.name}`);

    const messages = buildRunFixPrompt(
      runResult.output,
      runResult.failingFiles,
      manifest.project,
    );

    try {
      const response = await provider.generate(messages, {
        allowedTools: ALLOWED_TOOLS,
        cwd: projectRoot,
        timeoutMs: FIX_TIMEOUT_MS,
        onProgress: options.onProgress,
      });

      const summary = parseRunFixResponse(response.content);
      fixed = summary.fixed;

      logger.debug(
        `AI fixed ${fixed} tests, modified ${summary.filesModified.length} files`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`AI fix attempt failed: ${message}`);
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
  logger.debug(`Run complete. Score: ${scoreBefore} → ${scoreAfter}`);

  // Re-run to get final counts after fixes
  const finalResult =
    fixed > 0
      ? await executeTests(projectRoot, testFiles, testRunner)
      : runResult;

  return {
    scoreBefore,
    scoreAfter,
    totalTests: finalResult.total,
    passed: finalResult.passed,
    failed: finalResult.failed,
    fixed,
  };
}

// ─── Helpers ────────────────────────────────────────────────

interface TestRunResult {
  total: number;
  passed: number;
  failed: number;
  failingFiles: string[];
  output: string;
}

/**
 * Collect all test file paths from manifest modules.
 */
function collectTestFiles(
  manifest: CoveritManifest,
  filterModules?: string[],
): string[] {
  const files: string[] = [];

  for (const mod of manifest.modules) {
    if (filterModules && filterModules.length > 0) {
      if (!filterModules.includes(mod.path)) continue;
    }

    for (const coverage of Object.values(mod.functionality.tests)) {
      const cov = coverage as { files: string[] };
      files.push(...cov.files);
    }
  }

  return [...new Set(files)];
}

/**
 * Detect the test runner command from the manifest project info.
 */
function detectTestRunner(manifest: CoveritManifest): string {
  const fw = manifest.project.testFramework;
  if (fw === "jest") return "npx jest";
  if (fw === "vitest") return "npx vitest run";
  if (fw === "playwright") return "npx playwright test";
  return `npx ${fw}`;
}

/**
 * Execute tests and parse the output for pass/fail counts.
 */
async function executeTests(
  projectRoot: string,
  testFiles: string[],
  testRunner: string,
): Promise<TestRunResult> {
  const { execSync } = await import("node:child_process");

  const fileArgs = testFiles.join(" ");
  const command = `${testRunner} ${fileArgs} --no-coverage 2>&1`;

  let output: string;
  let exitCode: number;

  try {
    output = execSync(command, {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 300_000, // 5 min max
      maxBuffer: 10 * 1024 * 1024,
    });
    exitCode = 0;
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; status?: number };
    output = (execErr.stdout ?? "") + (execErr.stderr ?? "");
    exitCode = execErr.status ?? 1;
  }

  // Parse output for counts
  const { total, passed, failed } = parseTestOutput(output, exitCode);

  // Extract failing file paths from output
  const failingFiles = extractFailingFiles(output, testFiles);

  return { total, passed, failed, failingFiles, output };
}

/**
 * Parse test runner output for pass/fail counts.
 * Handles both vitest and jest output formats.
 */
function parseTestOutput(
  output: string,
  exitCode: number,
): { total: number; passed: number; failed: number } {
  // Vitest format: "Tests  12 passed | 3 failed (15)"
  const vitestMatch = output.match(
    /Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+failed)?\s*\((\d+)\)/,
  );
  if (vitestMatch) {
    const passed = parseInt(vitestMatch[1]!, 10);
    const failed = vitestMatch[2] ? parseInt(vitestMatch[2], 10) : 0;
    const total = parseInt(vitestMatch[3]!, 10);
    return { total, passed, failed };
  }

  // Jest format: "Tests:       3 failed, 12 passed, 15 total"
  const jestMatch = output.match(
    /Tests:\s+(?:(\d+)\s+failed,\s+)?(\d+)\s+passed,\s+(\d+)\s+total/,
  );
  if (jestMatch) {
    const failed = jestMatch[1] ? parseInt(jestMatch[1], 10) : 0;
    const passed = parseInt(jestMatch[2]!, 10);
    const total = parseInt(jestMatch[3]!, 10);
    return { total, passed, failed };
  }

  // Fallback: if exit code 0, assume all passed
  if (exitCode === 0) {
    return { total: 1, passed: 1, failed: 0 };
  }
  return { total: 1, passed: 0, failed: 1 };
}

/**
 * Extract failing test file paths from test runner output.
 */
function extractFailingFiles(
  output: string,
  allFiles: string[],
): string[] {
  const failing: string[] = [];

  // Check each test file — if its name appears near "FAIL" in output
  for (const file of allFiles) {
    const basename = file.split("/").pop() ?? file;
    // vitest: "FAIL  src/foo.test.ts" or jest: "FAIL src/foo.test.ts"
    if (
      output.includes(`FAIL  ${file}`) ||
      output.includes(`FAIL ${file}`) ||
      output.includes(`FAIL  ${basename}`) ||
      output.includes(`FAIL ${basename}`) ||
      output.includes(`${file} >`) // vitest inline failure
    ) {
      failing.push(file);
    }
  }

  return failing;
}
