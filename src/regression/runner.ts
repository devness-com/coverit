/**
 * Regression Runner — Discovers and runs ALL existing tests in the project.
 *
 * Unlike the LocalRunner (which executes individual generated test files),
 * this runner performs a full project-wide test suite execution to detect
 * regressions: tests that were passing before but are now failing.
 *
 * Design decision: We reuse framework detection from the existing detector
 * but build test commands independently because the LocalRunner is designed
 * for single-file execution, not full-suite runs.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import fg from "fast-glob";
import {
  detectTestFramework,
  detectPackageManager,
} from "../utils/framework-detector.js";
import type { TestFramework, PackageManager } from "../types/index.js";

// ─── Public Types ───────────────────────────────────────────

export interface RegressionResult {
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  failures: RegressionFailure[];
  testFiles: string[];
}

export interface RegressionFailure {
  testFile: string;
  testName: string;
  message: string;
  stack?: string;
}

// ─── Internal Types ─────────────────────────────────────────

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// ─── Constants ──────────────────────────────────────────────

/** Maximum time to wait for the full test suite (5 minutes) */
const SUITE_TIMEOUT_MS = 5 * 60 * 1000;

/** Test file glob patterns for discovery */
const TEST_FILE_PATTERNS = [
  "**/*.test.ts",
  "**/*.spec.ts",
  "**/*.test.tsx",
  "**/*.spec.tsx",
  "**/*.test.js",
  "**/*.spec.js",
  "**/*.test.jsx",
  "**/*.spec.jsx",
];

const IGNORE_PATTERNS = [
  "node_modules/**",
  "dist/**",
  ".coverit/**",
  "coverage/**",
  ".next/**",
  ".nuxt/**",
  "build/**",
];

// ─── Public API ─────────────────────────────────────────────

/**
 * Run the entire existing test suite for a project and return structured results.
 *
 * Steps:
 *   1. Detect test framework and package manager
 *   2. Discover all test files (for metadata, not for execution)
 *   3. Build the appropriate full-suite command with JSON output
 *   4. Execute and parse structured results
 *
 * If no test framework is detected or no test files exist, returns
 * a zero-count result rather than throwing — the comparator handles
 * the "no baseline" case gracefully.
 */
export async function runExistingTests(
  projectRoot: string,
): Promise<RegressionResult> {
  const absRoot = resolve(projectRoot);
  const start = Date.now();

  // Detect project setup
  const [testFramework, packageManager] = await Promise.all([
    detectTestFramework(absRoot),
    detectPackageManager(absRoot),
  ]);

  // Discover test files for metadata
  const testFiles = await discoverTestFiles(absRoot);

  if (testFramework === "unknown" || testFiles.length === 0) {
    return {
      totalTests: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: Date.now() - start,
      failures: [],
      testFiles,
    };
  }

  // Build and run the full-suite command
  const cmd = buildSuiteCommand(testFramework, packageManager, absRoot);
  const spawnResult = await runWithTimeout(cmd, absRoot, SUITE_TIMEOUT_MS);
  const duration = Date.now() - start;

  // Parse structured output from the runner
  const result = parseRunnerOutput(testFramework, spawnResult);

  return {
    ...result,
    duration,
    testFiles,
  };
}

// ─── Test File Discovery ────────────────────────────────────

/**
 * Find all test files in the project. This is separate from framework
 * execution — we use it to populate the `testFiles` field in results
 * and to short-circuit when no tests exist.
 */
async function discoverTestFiles(projectRoot: string): Promise<string[]> {
  return fg(TEST_FILE_PATTERNS, {
    cwd: projectRoot,
    ignore: IGNORE_PATTERNS,
    dot: false,
    absolute: false,
  });
}

// ─── Command Building ───────────────────────────────────────

/**
 * Build the shell command for a full test suite run with JSON output.
 *
 * Each framework has a different incantation for JSON reporter output.
 * We resolve binaries from node_modules/.bin first (monorepo-safe),
 * falling back to the package manager exec command.
 */
function buildSuiteCommand(
  framework: TestFramework,
  packageManager: PackageManager,
  projectRoot: string,
): string[] {
  const bin = resolveBin(framework, packageManager, projectRoot);

  switch (framework) {
    case "vitest":
      return [...bin, "run", "--reporter=json"];
    case "jest":
      return [...bin, "--json", "--no-cache"];
    case "playwright":
      return [...bin, "test", "--reporter=json"];
    case "mocha":
      return [...bin, "--reporter=json"];
    case "pytest":
      return [
        "python", "-m", "pytest",
        "--tb=short", "-q",
        "--json-report", "--json-report-file=-",
      ];
    case "go-test":
      return ["go", "test", "-json", "-count=1", "./..."];
    default:
      // Best-effort: run whatever binary we found
      return [...bin, "run", "--reporter=json"];
  }
}

/**
 * Resolve the test runner binary. Prefers local node_modules/.bin
 * for deterministic execution, falls back to package manager exec.
 */
function resolveBin(
  framework: TestFramework,
  packageManager: PackageManager,
  projectRoot: string,
): string[] {
  // Non-node frameworks don't use node_modules
  if (framework === "pytest" || framework === "go-test") {
    return [];
  }

  const toolName = frameworkToTool(framework);
  const localBin = join(projectRoot, "node_modules", ".bin", toolName);

  if (existsSync(localBin)) {
    return [localBin];
  }

  // Fall back to package manager exec
  return packageManagerExec(packageManager, toolName);
}

function frameworkToTool(framework: TestFramework): string {
  const map: Partial<Record<TestFramework, string>> = {
    jest: "jest",
    vitest: "vitest",
    playwright: "playwright",
    mocha: "mocha",
    cypress: "cypress",
  };
  return map[framework] ?? framework;
}

function packageManagerExec(pm: PackageManager, tool: string): string[] {
  switch (pm) {
    case "bun": return ["bunx", tool];
    case "pnpm": return ["pnpm", "exec", tool];
    case "yarn": return ["yarn", tool];
    default: return ["npx", tool];
  }
}

// ─── Process Execution ──────────────────────────────────────

function runWithTimeout(
  cmd: string[],
  cwd: string,
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolvePromise, reject) => {
    const [command, ...args] = cmd;
    if (!command) {
      reject(new Error("Empty command array"));
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CI: "true",
          FORCE_COLOR: "0",
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --experimental-vm-modules --max-old-space-size=2048`.trim(),
        } as Record<string, string>,
      });
    } catch (err) {
      reject(new Error(
        `Failed to spawn test process: ${err instanceof Error ? err.message : String(err)}`,
      ));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Test suite timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Process error: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
      });
    });
  });
}

// ─── Result Parsing ─────────────────────────────────────────

/**
 * Parse framework-specific JSON output into a normalized result.
 * Falls back to exit-code-based heuristics when JSON parsing fails.
 */
function parseRunnerOutput(
  framework: TestFramework,
  spawnResult: SpawnResult,
): Omit<RegressionResult, "duration" | "testFiles"> {
  switch (framework) {
    case "vitest":
    case "jest":
      return parseJestVitestOutput(spawnResult);
    case "playwright":
      return parsePlaywrightOutput(spawnResult);
    case "mocha":
      return parseMochaOutput(spawnResult);
    case "pytest":
      return parsePytestOutput(spawnResult);
    case "go-test":
      return parseGoTestOutput(spawnResult);
    default:
      return parseJestVitestOutput(spawnResult);
  }
}

/**
 * Parse Jest/Vitest JSON output. Both use the same top-level structure
 * with numTotalTests, numPassedTests, etc.
 */
function parseJestVitestOutput(
  spawnResult: SpawnResult,
): Omit<RegressionResult, "duration" | "testFiles"> {
  const json = extractJson(spawnResult.stdout) ?? extractJson(spawnResult.stderr);

  if (!json) {
    return fallbackFromExitCode(spawnResult);
  }

  const totalTests = (json.numTotalTests as number | undefined) ?? 0;
  const passed = (json.numPassedTests as number | undefined) ?? 0;
  const failed = (json.numFailedTests as number | undefined) ?? 0;
  const skipped =
    ((json.numPendingTests as number | undefined) ?? 0) +
    ((json.numTodoTests as number | undefined) ?? 0);

  const failures: RegressionFailure[] = [];

  // Jest uses testResults[].testResults[], Vitest uses testResults[].assertionResults[]
  if (Array.isArray(json.testResults)) {
    for (const suite of json.testResults) {
      const suiteName = (suite.testFilePath as string | undefined) ??
                         (suite.name as string | undefined) ?? "unknown";

      // Jest structure
      const innerTests = (suite.testResults as unknown[]) ??
                         (suite.assertionResults as unknown[]) ?? [];
      if (!Array.isArray(innerTests)) continue;

      for (const test of innerTests) {
        const t = test as Record<string, unknown>;
        if (t.status === "failed") {
          const failureMessages = t.failureMessages;
          const message = Array.isArray(failureMessages)
            ? failureMessages.join("\n")
            : String(failureMessages ?? "");

          failures.push({
            testFile: suiteName,
            testName: (t.fullName as string | undefined) ??
                      (t.title as string | undefined) ?? "unknown",
            message,
            stack: Array.isArray(failureMessages)
              ? (failureMessages[0] as string | undefined)
              : undefined,
          });
        }
      }
    }
  }

  return { totalTests, passed, failed, skipped, failures };
}

function parsePlaywrightOutput(
  spawnResult: SpawnResult,
): Omit<RegressionResult, "duration" | "testFiles"> {
  const json = extractJson(spawnResult.stdout);

  if (!json) {
    return fallbackFromExitCode(spawnResult);
  }

  const stats = (json.stats ?? {}) as Record<string, number>;
  const passed = stats.expected ?? 0;
  const failed = stats.unexpected ?? 0;
  const skipped = stats.skipped ?? 0;
  const totalTests = passed + failed + skipped;

  const failures: RegressionFailure[] = [];
  extractPlaywrightFailures(
    (json.suites as unknown[]) ?? [],
    failures,
  );

  return { totalTests, passed, failed, skipped, failures };
}

function extractPlaywrightFailures(
  suites: unknown[],
  failures: RegressionFailure[],
): void {
  for (const rawSuite of suites) {
    const suite = rawSuite as Record<string, unknown>;
    const suiteName = (suite.title as string | undefined) ?? "unknown";

    if (Array.isArray(suite.specs)) {
      for (const rawSpec of suite.specs) {
        const spec = rawSpec as Record<string, unknown>;
        if (!Array.isArray(spec.tests)) continue;
        for (const rawTest of spec.tests) {
          const test = rawTest as Record<string, unknown>;
          if (!Array.isArray(test.results)) continue;
          for (const rawRun of test.results) {
            const run = rawRun as Record<string, unknown>;
            if (run.status === "unexpected" || run.status === "failed") {
              const error = (run.error ?? {}) as Record<string, unknown>;
              failures.push({
                testFile: suiteName,
                testName: (spec.title as string | undefined) ?? "unknown",
                message: (error.message as string | undefined) ??
                         (error.snippet as string | undefined) ?? "Test failed",
                stack: (error.stack as string | undefined) ?? undefined,
              });
            }
          }
        }
      }
    }

    // Recurse into nested suites
    if (Array.isArray(suite.suites)) {
      extractPlaywrightFailures(suite.suites, failures);
    }
  }
}

function parseMochaOutput(
  spawnResult: SpawnResult,
): Omit<RegressionResult, "duration" | "testFiles"> {
  const json = extractJson(spawnResult.stdout);

  if (!json) {
    return fallbackFromExitCode(spawnResult);
  }

  const stats = (json.stats ?? {}) as Record<string, number>;
  const passed = stats.passes ?? 0;
  const failed = stats.failures ?? 0;
  const skipped = stats.pending ?? 0;
  const totalTests = passed + failed + skipped;

  const failures: RegressionFailure[] = [];
  if (Array.isArray(json.failures)) {
    for (const rawFail of json.failures) {
      const f = rawFail as Record<string, unknown>;
      failures.push({
        testFile: (f.file as string | undefined) ?? "unknown",
        testName: (f.fullTitle as string | undefined) ??
                  (f.title as string | undefined) ?? "unknown",
        message: (f.err as Record<string, unknown>)?.message as string ?? "Test failed",
        stack: (f.err as Record<string, unknown>)?.stack as string | undefined,
      });
    }
  }

  return { totalTests, passed, failed, skipped, failures };
}

function parsePytestOutput(
  spawnResult: SpawnResult,
): Omit<RegressionResult, "duration" | "testFiles"> {
  const json = extractJson(spawnResult.stdout);

  if (!json) {
    return fallbackFromExitCode(spawnResult);
  }

  const summary = (json.summary ?? {}) as Record<string, number>;
  const passed = summary.passed ?? 0;
  const failed = summary.failed ?? 0;
  const skipped = summary.skipped ?? 0;
  const totalTests = summary.total ?? (passed + failed + skipped);

  const failures: RegressionFailure[] = [];
  if (Array.isArray(json.tests)) {
    for (const rawTest of json.tests) {
      const t = rawTest as Record<string, unknown>;
      if (t.outcome === "failed") {
        const call = (t.call ?? {}) as Record<string, unknown>;
        const crash = (call.crash ?? {}) as Record<string, unknown>;
        failures.push({
          testFile: (t.nodeid as string | undefined) ?? "unknown",
          testName: (t.nodeid as string | undefined) ?? "unknown",
          message: (call.longrepr as string | undefined) ??
                   (crash.message as string | undefined) ?? "Failed",
        });
      }
    }
  }

  return { totalTests, passed, failed, skipped, failures };
}

function parseGoTestOutput(
  spawnResult: SpawnResult,
): Omit<RegressionResult, "duration" | "testFiles"> {
  const lines = spawnResult.stdout.split("\n").filter(Boolean);
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures: RegressionFailure[] = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const testName = event.Test as string | undefined;
      if (!testName) continue;

      if (event.Action === "pass") passed++;
      else if (event.Action === "fail") {
        failed++;
        failures.push({
          testFile: (event.Package as string | undefined) ?? "unknown",
          testName,
          message: (event.Output as string | undefined) ?? "Test failed",
        });
      } else if (event.Action === "skip") skipped++;
    } catch {
      // Non-JSON line, ignore
    }
  }

  const totalTests = passed + failed + skipped;
  return { totalTests, passed, failed, skipped, failures };
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Extract the first valid JSON object from a string that may contain
 * non-JSON preamble (log lines, warnings, etc.).
 */
function extractJson(raw: string): Record<string, unknown> | null {
  // Fast path: entire string is valid JSON
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Fall through
  }

  // Slow path: find the first `{` or `[` and try to match braces
  const startIdx = raw.search(/[{[]/);
  if (startIdx === -1) return null;

  const openChar = raw[startIdx]!;
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;

  for (let i = startIdx; i < raw.length; i++) {
    if (raw[i] === openChar) depth++;
    else if (raw[i] === closeChar) depth--;

    if (depth === 0) {
      try {
        return JSON.parse(raw.slice(startIdx, i + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }

  return null;
}

/**
 * When JSON parsing fails, derive minimal results from the exit code
 * and attempt to extract counts from human-readable summary lines.
 */
function fallbackFromExitCode(
  spawnResult: SpawnResult,
): Omit<RegressionResult, "duration" | "testFiles"> {
  const combined = `${spawnResult.stderr}\n${spawnResult.stdout}`;
  const counts = extractTestCountsFromText(combined);
  const failures: RegressionFailure[] = [];

  if (spawnResult.exitCode !== 0) {
    const errorOutput = spawnResult.stderr || spawnResult.stdout;
    if (errorOutput) {
      failures.push({
        testFile: "(runner)",
        testName: "(execution)",
        message: errorOutput.slice(0, 2000),
      });
    }
  }

  return {
    totalTests: counts?.total ?? 0,
    passed: counts?.passed ?? 0,
    failed: counts?.failed ?? 0,
    skipped: 0,
    failures,
  };
}

/**
 * Extract test counts from human-readable summary lines.
 * Handles both Vitest and Jest summary formats.
 */
function extractTestCountsFromText(
  output: string,
): { total: number; passed: number; failed: number } | null {
  // Vitest: "Tests  42 passed (42)" or "Tests  3 failed | 39 passed (42)"
  let match = output.match(
    /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed\s*\((\d+)\)/,
  );
  if (match) {
    return {
      failed: parseInt(match[1] ?? "0", 10),
      passed: parseInt(match[2]!, 10),
      total: parseInt(match[3]!, 10),
    };
  }

  // Jest: "Tests:       3 failed, 39 passed, 42 total"
  match = output.match(
    /Tests:\s+(?:(\d+)\s+failed,\s*)?(\d+)\s+passed,\s*(\d+)\s+total/,
  );
  if (match) {
    return {
      failed: parseInt(match[1] ?? "0", 10),
      passed: parseInt(match[2]!, 10),
      total: parseInt(match[3]!, 10),
    };
  }

  return null;
}
