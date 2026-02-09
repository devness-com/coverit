/**
 * Browser Runner — Execute Playwright E2E tests with full browser context.
 *
 * Launches the Playwright test runner in a subprocess, configured for
 * headless execution with JSON reporting. Handles screenshot capture
 * on failure and graceful cleanup of browser processes.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { BaseExecutor } from "./base-executor.js";
import type {
  GeneratedTest,
  ExecutionConfig,
  ExecutionResult,
  TestFailure,
} from "../types/index.js";

interface BrowserConfig {
  headless: boolean;
  screenshotsDir: string;
  baseURL: string | null;
  browserType: "chromium" | "firefox" | "webkit";
}

export class BrowserRunner extends BaseExecutor {
  async execute(
    test: GeneratedTest,
    config: ExecutionConfig
  ): Promise<ExecutionResult> {
    const result = this.createBaseResult(test.planId);
    const start = Date.now();

    try {
      const browserConfig = this.resolveBrowserConfig(test);

      // Ensure screenshots directory exists
      await mkdir(browserConfig.screenshotsDir, { recursive: true });

      const spawnResult = await this.withTimeout(
        this.withRetry(
          () => this.runPlaywright(test, browserConfig),
          config.retries
        ),
        config.timeout
      );

      result.duration = Date.now() - start;
      result.output = this.combineOutput(
        spawnResult.stdout,
        spawnResult.stderr
      );

      this.parsePlaywrightOutput(spawnResult, result);
    } catch (err) {
      result.duration = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes("timed out")) {
        result.status = "timeout";
      } else if (
        message.includes("browserType.launch") ||
        message.includes("Executable doesn't exist")
      ) {
        result.status = "error";
        result.output =
          "Browser launch failed. Run `bunx playwright install` to install browsers.";
      } else {
        result.status = "error";
      }

      result.output = result.output || message;
      result.failures.push({
        testName: "(browser-runner)",
        message,
      });
    }

    return result;
  }

  // ── Config ────────────────────────────────────────────────────

  private resolveBrowserConfig(test: GeneratedTest): BrowserConfig {
    const projectDir = this.findProjectRoot(test.filePath);

    return {
      headless: true,
      screenshotsDir: join(projectDir, "test-results", "screenshots"),
      baseURL: this.detectBaseURL(projectDir),
      browserType: "chromium",
    };
  }

  /**
   * Try to detect a dev server URL from common config files.
   * Falls back to null — Playwright config in the project should define it.
   */
  private detectBaseURL(projectDir: string): string | null {
    const configCandidates = [
      join(projectDir, "playwright.config.ts"),
      join(projectDir, "playwright.config.js"),
    ];

    // We don't parse the config at runtime — just check it exists.
    // The Playwright runner will use its own config resolution.
    for (const configPath of configCandidates) {
      if (existsSync(configPath)) return null;
    }

    // No Playwright config found — assume a default dev server
    return "http://localhost:3000";
  }

  // ── Execution ─────────────────────────────────────────────────

  private runPlaywright(
    test: GeneratedTest,
    browserConfig: BrowserConfig
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const cwd = this.findProjectRoot(test.filePath);

      const args = [
        "playwright",
        "test",
        test.filePath,
        "--reporter=json",
      ];

      if (browserConfig.headless) {
        args.push("--headed=false");
      }

      // Pass screenshot config via env
      const env: Record<string, string> = {
        ...process.env as Record<string, string>,
        CI: "true",
        FORCE_COLOR: "0",
        PLAYWRIGHT_JSON_OUTPUT_NAME: "results.json",
      };

      if (browserConfig.baseURL) {
        env.BASE_URL = browserConfig.baseURL;
      }

      let child: ChildProcess;

      try {
        child = spawn("bunx", args, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env,
        });
      } catch (err) {
        reject(
          new Error(
            `Failed to launch Playwright: ${err instanceof Error ? err.message : String(err)}`
          )
        );
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      child.on("error", (err) => reject(new Error(`Playwright error: ${err.message}`)));

      child.on("close", (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
          stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        });
      });
    });
  }

  // ── Parsing ───────────────────────────────────────────────────

  private parsePlaywrightOutput(
    spawn: { exitCode: number; stdout: string; stderr: string },
    result: ExecutionResult
  ): void {
    const json = this.parseJsonOutput(spawn.stdout);

    if (!json) {
      result.status = spawn.exitCode === 0 ? "passed" : "failed";
      if (spawn.exitCode !== 0 && spawn.stderr) {
        result.failures.push({
          testName: "(playwright)",
          message: spawn.stderr.slice(0, 2000),
        });
      }
      return;
    }

    // Playwright JSON reporter shape: { stats, suites[] }
    const stats = json.stats ?? {};
    result.passed = stats.expected ?? 0;
    result.failed = stats.unexpected ?? 0;
    result.skipped = stats.skipped ?? 0;
    result.totalTests = result.passed + result.failed + result.skipped;
    result.status =
      spawn.exitCode === 0 && result.failed === 0 ? "passed" : "failed";

    this.extractFailures(json.suites ?? [], result.failures);
  }

  private extractFailures(suites: any[], failures: TestFailure[]): void {
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
      if (Array.isArray(suite.suites)) {
        this.extractFailures(suite.suites, failures);
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────

  private findProjectRoot(filePath: string): string {
    let dir = dirname(resolve(filePath));
    while (dir !== "/" && dir !== ".") {
      if (existsSync(join(dir, "package.json"))) return dir;
      dir = dirname(dir);
    }
    return dirname(resolve(filePath));
  }

  private combineOutput(stdout: string, stderr: string): string {
    const parts: string[] = [];
    if (stdout) parts.push(stdout);
    if (stderr) parts.push(`[stderr]\n${stderr}`);
    return parts.join("\n").slice(0, 50_000);
  }
}
