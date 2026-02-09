/**
 * Local Runner — Executes generated tests on the local machine.
 *
 * Auto-detects the test framework from the GeneratedTest metadata and
 * spawns the appropriate CLI command. Parses JSON reporter output into
 * a normalized ExecutionResult with optional coverage.
 *
 * This is the primary executor — all other runners are specialized variants.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { BaseExecutor } from "./base-executor.js";
import type {
  GeneratedTest,
  ExecutionConfig,
  ExecutionResult,
  TestFailure,
  TestFramework,
} from "../types/index.js";

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class LocalRunner extends BaseExecutor {
  async execute(
    test: GeneratedTest,
    config: ExecutionConfig
  ): Promise<ExecutionResult> {
    const result = this.createBaseResult(test.planId);
    const start = Date.now();

    try {
      // Write the test file to disk so the runner can find it
      await this.ensureTestFile(test);

      const cmd = this.buildCommand(test, config);
      const cwd = this.resolveWorkingDir(test);

      const spawnResult = await this.withTimeout(
        this.withRetry(() => this.runProcess(cmd, cwd), config.retries),
        config.timeout
      );

      result.output = this.combineOutput(spawnResult);
      result.duration = Date.now() - start;

      // Parse framework-specific JSON output
      this.parseResult(test.framework, spawnResult, result);

      // Attempt to read coverage if requested
      if (config.collectCoverage) {
        const coverage = await this.readCoverageFromDisk(cwd);
        if (coverage) {
          result.coverage = this.parseCoverage(coverage);
        }
      }
    } catch (err) {
      result.duration = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes("timed out")) {
        result.status = "timeout";
      } else {
        result.status = "error";
      }

      result.output = message;
      result.failures.push({
        testName: "(execution)",
        message,
      });
    }

    return result;
  }

  // ── Command building ──────────────────────────────────────────

  private buildCommand(
    test: GeneratedTest,
    config: ExecutionConfig
  ): string[] {
    const file = test.filePath;
    const coverageFlag = config.collectCoverage;

    switch (test.framework) {
      case "vitest":
        return this.vitestCommand(file, coverageFlag);
      case "jest":
        return this.jestCommand(file, coverageFlag);
      case "playwright":
        return this.playwrightCommand(file);
      case "pytest":
        return this.pytestCommand(file);
      case "go-test":
        return this.goTestCommand(file);
      default:
        // Best-effort: try vitest for unknown TS/JS frameworks
        return this.vitestCommand(file, coverageFlag);
    }
  }

  private vitestCommand(file: string, coverage: boolean): string[] {
    const args = ["bunx", "vitest", "run", file, "--reporter=json"];
    if (coverage) args.push("--coverage", "--coverage.reporter=json");
    return args;
  }

  private jestCommand(file: string, coverage: boolean): string[] {
    const args = ["bunx", "jest", file, "--json", "--no-cache"];
    if (coverage) args.push("--coverage", "--coverageReporters=json-summary");
    return args;
  }

  private playwrightCommand(file: string): string[] {
    return ["bunx", "playwright", "test", file, "--reporter=json"];
  }

  private pytestCommand(file: string): string[] {
    return [
      "python",
      "-m",
      "pytest",
      file,
      "--tb=short",
      "-q",
      "--json-report",
      "--json-report-file=-",
    ];
  }

  private goTestCommand(file: string): string[] {
    // `file` is a package path for Go, e.g. ./pkg/auth
    return ["go", "test", "-json", "-count=1", file];
  }

  // ── Process execution ─────────────────────────────────────────

  private runProcess(cmd: string[], cwd: string): Promise<SpawnResult> {
    return new Promise<SpawnResult>((resolve, reject) => {
      let child: ChildProcess;

      try {
        child = spawn(cmd[0]!, cmd.slice(1), {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            // Force CI-friendly output in common frameworks
            CI: "true",
            FORCE_COLOR: "0",
            NODE_OPTIONS: "--experimental-vm-modules",
          } as Record<string, string>,
        });
      } catch (err) {
        reject(
          new Error(
            `Failed to spawn process: ${err instanceof Error ? err.message : String(err)}`
          )
        );
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      child.on("error", (err) => {
        reject(new Error(`Process error: ${err.message}`));
      });

      child.on("close", (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
          stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        });
      });
    });
  }

  // ── Result parsing ────────────────────────────────────────────

  private parseResult(
    framework: TestFramework,
    spawn: SpawnResult,
    result: ExecutionResult
  ): void {
    switch (framework) {
      case "vitest":
        this.parseVitestResult(spawn, result);
        break;
      case "jest":
        this.parseJestResult(spawn, result);
        break;
      case "playwright":
        this.parsePlaywrightResult(spawn, result);
        break;
      case "pytest":
        this.parsePytestResult(spawn, result);
        break;
      case "go-test":
        this.parseGoTestResult(spawn, result);
        break;
      default:
        this.parseFallbackResult(spawn, result);
        break;
    }
  }

  private parseVitestResult(spawn: SpawnResult, result: ExecutionResult): void {
    const json = this.parseJsonOutput(spawn.stdout);

    if (!json) {
      this.parseFallbackResult(spawn, result);
      return;
    }

    // Vitest JSON reporter: { numTotalTests, numPassedTests, numFailedTests, ... testResults[] }
    result.totalTests = json.numTotalTests ?? 0;
    result.passed = json.numPassedTests ?? 0;
    result.failed = json.numFailedTests ?? 0;
    result.skipped =
      (json.numPendingTests ?? 0) + (json.numTodoTests ?? 0);
    result.status = this.deriveStatus(spawn.exitCode, result.failed);

    // Extract failures
    if (Array.isArray(json.testResults)) {
      for (const suite of json.testResults) {
        if (!Array.isArray(suite.assertionResults)) continue;
        for (const test of suite.assertionResults) {
          if (test.status === "failed") {
            result.failures.push({
              testName: test.fullName ?? test.title ?? "unknown",
              message: Array.isArray(test.failureMessages)
                ? test.failureMessages.join("\n")
                : String(test.failureMessages ?? ""),
              stack: test.failureMessages?.[0] ?? undefined,
            });
          }
        }
      }
    }

    // Vitest may embed coverage in the JSON output
    if (json.coverageMap) {
      const cov = this.parseCoverage(json.coverageMap);
      if (cov) result.coverage = cov;
    }
  }

  private parseJestResult(spawn: SpawnResult, result: ExecutionResult): void {
    const json = this.parseJsonOutput(spawn.stdout);

    if (!json) {
      this.parseFallbackResult(spawn, result);
      return;
    }

    result.totalTests = json.numTotalTests ?? 0;
    result.passed = json.numPassedTests ?? 0;
    result.failed = json.numFailedTests ?? 0;
    result.skipped = json.numPendingTests ?? 0;
    result.status = this.deriveStatus(spawn.exitCode, result.failed);

    if (Array.isArray(json.testResults)) {
      for (const suite of json.testResults) {
        if (!Array.isArray(suite.testResults)) continue;
        for (const test of suite.testResults) {
          if (test.status === "failed") {
            result.failures.push({
              testName: test.fullName ?? test.title ?? "unknown",
              message: Array.isArray(test.failureMessages)
                ? test.failureMessages.join("\n")
                : String(test.failureMessages ?? ""),
            });
          }
        }
      }
    }
  }

  private parsePlaywrightResult(
    spawn: SpawnResult,
    result: ExecutionResult
  ): void {
    const json = this.parseJsonOutput(spawn.stdout);

    if (!json) {
      this.parseFallbackResult(spawn, result);
      return;
    }

    // Playwright JSON reporter: { stats: { expected, unexpected, skipped, ... }, suites[] }
    const stats = json.stats ?? {};
    result.passed = stats.expected ?? 0;
    result.failed = stats.unexpected ?? 0;
    result.skipped = stats.skipped ?? 0;
    result.totalTests = result.passed + result.failed + result.skipped;
    result.status = this.deriveStatus(spawn.exitCode, result.failed);

    // Walk suites for failure details
    this.extractPlaywrightFailures(json.suites ?? [], result.failures);
  }

  private extractPlaywrightFailures(
    suites: any[],
    failures: TestFailure[]
  ): void {
    for (const suite of suites) {
      if (Array.isArray(suite.specs)) {
        for (const spec of suite.specs) {
          if (!Array.isArray(spec.tests)) continue;
          for (const test of spec.tests) {
            if (!Array.isArray(test.results)) continue;
            for (const run of test.results) {
              if (run.status === "unexpected" || run.status === "failed") {
                failures.push({
                  testName: spec.title ?? "unknown",
                  message:
                    run.error?.message ?? run.error?.snippet ?? "Test failed",
                  stack: run.error?.stack ?? undefined,
                });
              }
            }
          }
        }
      }

      // Recurse into nested suites
      if (Array.isArray(suite.suites)) {
        this.extractPlaywrightFailures(suite.suites, failures);
      }
    }
  }

  private parsePytestResult(spawn: SpawnResult, result: ExecutionResult): void {
    const json = this.parseJsonOutput(spawn.stdout);

    if (!json) {
      this.parseFallbackResult(spawn, result);
      return;
    }

    // pytest-json-report format: { summary: { passed, failed, ... }, tests: [...] }
    const summary = json.summary ?? {};
    result.passed = summary.passed ?? 0;
    result.failed = summary.failed ?? 0;
    result.skipped = summary.skipped ?? 0;
    result.totalTests = summary.total ?? result.passed + result.failed + result.skipped;
    result.status = this.deriveStatus(spawn.exitCode, result.failed);

    if (Array.isArray(json.tests)) {
      for (const test of json.tests) {
        if (test.outcome === "failed") {
          result.failures.push({
            testName: test.nodeid ?? "unknown",
            message: test.call?.longrepr ?? test.call?.crash?.message ?? "Failed",
          });
        }
      }
    }
  }

  private parseGoTestResult(spawn: SpawnResult, result: ExecutionResult): void {
    // Go test -json emits newline-delimited JSON events
    const lines = spawn.stdout.split("\n").filter(Boolean);
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.Action === "pass" && event.Test) passed++;
        else if (event.Action === "fail" && event.Test) {
          failed++;
          result.failures.push({
            testName: event.Test,
            message: event.Output ?? "Test failed",
          });
        } else if (event.Action === "skip" && event.Test) skipped++;
      } catch {
        // Non-JSON line, ignore
      }
    }

    result.passed = passed;
    result.failed = failed;
    result.skipped = skipped;
    result.totalTests = passed + failed + skipped;
    result.status = this.deriveStatus(spawn.exitCode, failed);
  }

  /**
   * Fallback when we cannot parse structured output.
   * Derive pass/fail from the exit code alone.
   */
  private parseFallbackResult(
    spawn: SpawnResult,
    result: ExecutionResult
  ): void {
    result.status = spawn.exitCode === 0 ? "passed" : "failed";
    if (spawn.exitCode !== 0 && spawn.stderr) {
      result.failures.push({
        testName: "(runner)",
        message: spawn.stderr.slice(0, 2000),
      });
    }
  }

  // ── Coverage ──────────────────────────────────────────────────

  /** Try to read coverage-summary.json from common output locations. */
  private async readCoverageFromDisk(cwd: string): Promise<any | null> {
    const candidates = [
      join(cwd, "coverage", "coverage-summary.json"),
      join(cwd, "coverage", "coverage-final.json"),
      join(cwd, ".coverage", "coverage-summary.json"),
    ];

    for (const path of candidates) {
      try {
        if (existsSync(path)) {
          const raw = await readFile(path, "utf-8");
          return JSON.parse(raw);
        }
      } catch {
        // Continue to next candidate
      }
    }

    return null;
  }

  // ── Helpers ───────────────────────────────────────────────────

  private resolveWorkingDir(test: GeneratedTest): string {
    // Walk up from the test file to find the nearest package.json
    let dir = dirname(resolve(test.filePath));
    while (dir !== "/" && dir !== ".") {
      if (existsSync(join(dir, "package.json"))) return dir;
      dir = dirname(dir);
    }
    return dirname(resolve(test.filePath));
  }

  private async ensureTestFile(test: GeneratedTest): Promise<void> {
    const fullPath = resolve(test.filePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, test.content, "utf-8");
  }

  private combineOutput(spawn: SpawnResult): string {
    const parts: string[] = [];
    if (spawn.stdout) parts.push(spawn.stdout);
    if (spawn.stderr) parts.push(`[stderr]\n${spawn.stderr}`);
    return parts.join("\n").slice(0, 50_000); // Cap at 50KB
  }

  private deriveStatus(
    exitCode: number,
    failedCount: number
  ): ExecutionResult["status"] {
    if (exitCode === 0 && failedCount === 0) return "passed";
    if (failedCount > 0) return "failed";
    return "error";
  }
}
