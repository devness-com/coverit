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
  private packageManager: string = "npx";
  private projectRoot: string = "";

  /** Set the package manager runner (npx, bunx, pnpm exec, yarn) */
  setPackageManager(pm: string): void {
    switch (pm) {
      case "bun": this.packageManager = "bunx"; break;
      case "pnpm": this.packageManager = "pnpm exec"; break;
      case "yarn": this.packageManager = "yarn"; break;
      default: this.packageManager = "npx"; break;
    }
  }

  /** Set the project root so the runner can resolve binary paths in workspaces */
  setProjectRoot(root: string): void {
    this.projectRoot = root;
  }

  async preflight(
    projectRoot: string,
    framework: string
  ): Promise<{ ok: boolean; error?: string }> {
    // "unknown" is common in monorepos where detection at root finds nothing;
    // per-plan detection will handle it, so pass preflight.
    if (framework === "unknown") return { ok: true };

    const binMap: Record<string, string> = {
      jest: "node_modules/.bin/jest",
      vitest: "node_modules/.bin/vitest",
      playwright: "node_modules/.bin/playwright",
    };

    const bin = binMap[framework];
    if (!bin) return { ok: true };

    const fullPath = join(projectRoot, bin);
    if (!existsSync(fullPath)) {
      return {
        ok: false,
        error: `${framework} binary not found at ${fullPath}. Run "npm install" (or your package manager's install command) in ${projectRoot} first.`,
      };
    }

    return { ok: true };
  }

  async execute(
    test: GeneratedTest,
    config: ExecutionConfig
  ): Promise<ExecutionResult> {
    const result = this.createBaseResult(test.planId);
    const start = Date.now();

    try {
      // Write the test file to disk so the runner can find it
      const absTestFile = await this.ensureTestFile(test);

      // In monorepos, find the sub-package that owns the test binary
      const tool = this.frameworkTool(test.framework);
      const packageRoot = this.findPackageRootForTest(absTestFile, tool);

      const cmd = this.buildCommand(test, config, absTestFile, packageRoot);
      const cwd = packageRoot;

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
    config: ExecutionConfig,
    absTestFile: string,
    packageRoot: string
  ): string[] {
    const file = absTestFile;
    const coverageFlag = config.collectCoverage;

    switch (test.framework) {
      case "vitest":
        return this.vitestCommand(file, coverageFlag, packageRoot);
      case "jest":
        return this.jestCommand(file, coverageFlag, packageRoot);
      case "playwright":
        return this.playwrightCommand(file, packageRoot);
      case "pytest":
        return this.pytestCommand(file);
      case "go-test":
        return this.goTestCommand(file);
      default:
        // Best-effort: try vitest for unknown TS/JS frameworks
        return this.vitestCommand(file, coverageFlag, packageRoot);
    }
  }

  /** Map TestFramework to CLI binary name */
  private frameworkTool(framework: TestFramework): string {
    const map: Record<string, string> = {
      jest: "jest",
      vitest: "vitest",
      playwright: "playwright",
      mocha: "mocha",
      cypress: "cypress",
    };
    return map[framework] ?? framework;
  }

  /**
   * Walk up from the test file's directory to projectRoot, checking each level
   * for node_modules/.bin/<tool>. Returns the nearest directory that has the
   * binary, or projectRoot as fallback. This handles pnpm monorepos where
   * binaries live in sub-package node_modules, not at the root.
   */
  private findPackageRootForTest(absTestFile: string, tool: string): string {
    if (!this.projectRoot) return dirname(absTestFile);
    const root = resolve(this.projectRoot);
    let dir = dirname(absTestFile);
    while (dir.length >= root.length) {
      if (existsSync(join(dir, "node_modules", ".bin", tool))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return this.projectRoot;
  }

  /**
   * Resolve the runner binary. Checks sub-package first (monorepo),
   * then project root, then falls back to package manager exec.
   */
  private resolveBin(tool: string, packageRoot?: string): string[] {
    // 1. Sub-package binary (monorepo — e.g. pnpm with per-package deps)
    if (packageRoot && packageRoot !== this.projectRoot) {
      const subBin = join(packageRoot, "node_modules", ".bin", tool);
      if (existsSync(subBin)) return [subBin];
    }
    // 2. Project root binary
    if (this.projectRoot) {
      const rootBin = join(this.projectRoot, "node_modules", ".bin", tool);
      if (existsSync(rootBin)) return [rootBin];
    }
    // 3. Package manager exec fallback
    return [...this.packageManager.split(" "), tool];
  }

  private vitestCommand(file: string, coverage: boolean, packageRoot?: string): string[] {
    const args = [...this.resolveBin("vitest", packageRoot), "run", file, "--reporter=json"];
    if (coverage) args.push("--coverage", "--coverage.reporter=json");
    return args;
  }

  private jestCommand(file: string, coverage: boolean, packageRoot?: string): string[] {
    const args = [...this.resolveBin("jest", packageRoot), file, "--json", "--no-cache"];
    // Pass project jest config so ts-jest and moduleNameMapper are applied
    const jestConfig = this.findJestConfig(packageRoot);
    if (jestConfig) {
      args.push("--config", jestConfig);
    }
    // Accept both .test.ts and .spec.ts files
    args.push("--testRegex", ".*\\.(test|spec)\\.[jt]sx?$");
    if (coverage) args.push("--coverage", "--coverageReporters=json-summary");
    return args;
  }

  private playwrightCommand(file: string, packageRoot?: string): string[] {
    return [...this.resolveBin("playwright", packageRoot), "test", file, "--reporter=json"];
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
            NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --experimental-vm-modules --max-old-space-size=2048`.trim(),
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
    let json = this.parseJsonOutput(spawn.stdout);
    if (!json) json = this.parseJsonOutput(spawn.stderr);

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
    let json = this.parseJsonOutput(spawn.stdout);
    if (!json) json = this.parseJsonOutput(spawn.stderr);

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
   * Derive pass/fail from the exit code, and try to extract test counts
   * from human-readable summary lines.
   */
  private parseFallbackResult(
    spawn: SpawnResult,
    result: ExecutionResult
  ): void {
    // Check both stderr and stdout — some tools (pnpm) write errors to stdout
    const combined = `${spawn.stderr}\n${spawn.stdout}`;

    if (spawn.exitCode === 0) {
      result.status = "passed";
    } else if (isOOMError(spawn, combined)) {
      result.status = "error";
      result.failures.push({
        testName: "(runner)",
        message: `Out of memory: the test process ran out of heap space (exit code ${spawn.exitCode}). The source file may be too large — consider mocking heavy dependency trees at the module level.`,
      });
      return;
    } else if (this.isInfrastructureError(combined)) {
      result.status = "error";
    } else {
      result.status = "failed";
    }

    // Try to extract test counts from text output (vitest/jest summary lines)
    const counts = this.extractTestCountsFromText(combined);
    if (counts) {
      result.totalTests = counts.total;
      result.passed = counts.passed;
      result.failed = counts.failed;
    }

    if (spawn.exitCode !== 0) {
      const errorOutput = spawn.stderr || spawn.stdout;
      if (errorOutput) {
        result.failures.push({
          testName: "(runner)",
          message: errorOutput.slice(0, 2000),
        });
      }
    }
  }

  /**
   * Extract test counts from human-readable summary lines in test runner output.
   * Handles vitest and jest summary formats.
   */
  private extractTestCountsFromText(
    output: string
  ): { total: number; passed: number; failed: number } | null {
    // Vitest: "Tests  42 passed (42)" or "Tests  3 failed | 39 passed (42)"
    let match = output.match(
      /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed\s*\((\d+)\)/
    );
    if (match) {
      return {
        failed: parseInt(match[1] ?? "0", 10),
        passed: parseInt(match[2]!, 10),
        total: parseInt(match[3]!, 10),
      };
    }

    // Jest: "Tests:       3 failed, 39 passed, 42 total" or "Tests:       42 passed, 42 total"
    match = output.match(
      /Tests:\s+(?:(\d+)\s+failed,\s*)?(\d+)\s+passed,\s*(\d+)\s+total/
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

  /** Find the nearest jest config file, checking sub-package first then project root. */
  private findJestConfig(packageRoot?: string): string | null {
    const configNames = [
      "jest.config.ts",
      "jest.config.js",
      "jest.config.cjs",
      "jest.config.mjs",
      "jest.config.json",
    ];
    // Check sub-package first (monorepo)
    if (packageRoot) {
      for (const name of configNames) {
        const candidate = join(packageRoot, name);
        if (existsSync(candidate)) return candidate;
      }
    }
    // Then project root if different
    if (this.projectRoot && this.projectRoot !== packageRoot) {
      for (const name of configNames) {
        const candidate = join(this.projectRoot, name);
        if (existsSync(candidate)) return candidate;
      }
    }
    return null;
  }

  private isInfrastructureError(output: string): boolean {
    return (
      /Command.*not found/i.test(output) ||
      output.includes("ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL") ||
      /ENOENT.*(jest|vitest|playwright)/i.test(output) ||
      /Cannot find module.*(jest|vitest|playwright)/i.test(output)
    );
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

  private async ensureTestFile(test: GeneratedTest): Promise<string> {
    // Use projectRoot to resolve relative file paths, not process.cwd()
    const fullPath = this.projectRoot
      ? join(this.projectRoot, test.filePath)
      : resolve(test.filePath);
    if (!existsSync(fullPath)) {
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, test.content, "utf-8");
    }
    return fullPath;
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

function isOOMError(spawn: SpawnResult, combined: string): boolean {
  // Exit codes 137 (SIGKILL) and 134 (SIGABRT) are common OOM signals
  if (spawn.exitCode === 137 || spawn.exitCode === 134) return true;
  return /heap\s*(out\s*of\s*memory|allocation\s*failed)|JavaScript\s*heap|FATAL\s*ERROR.*MarkCompact|allocation\s*failed.*growing/i.test(combined);
}
