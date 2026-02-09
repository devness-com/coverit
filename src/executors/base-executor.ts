/**
 * Base Executor — Abstract foundation for all test execution strategies.
 *
 * Provides shared utilities: timeout wrapping, retry logic, JSON parsing,
 * coverage normalization, and result scaffolding. Concrete executors only
 * need to implement `execute()`.
 */

import type {
  GeneratedTest,
  ExecutionConfig,
  ExecutionResult,
  CoverageResult,
  CoverageMetric,
} from "../types/index.js";

export abstract class BaseExecutor {
  abstract execute(
    test: GeneratedTest,
    config: ExecutionConfig
  ): Promise<ExecutionResult>;

  /**
   * Extract the first valid JSON object or array from mixed stdout.
   * Test runners often emit logs before/after the JSON payload.
   */
  protected parseJsonOutput(stdout: string): any {
    // Try parsing the entire string first (fast path)
    try {
      return JSON.parse(stdout);
    } catch {
      // Fall through to bracket-matching
    }

    // Scan for the outermost JSON object or array
    const startIdx = stdout.search(/[{\[]/);
    if (startIdx === -1) return null;

    const openChar = stdout[startIdx];
    const closeChar = openChar === "{" ? "}" : "]";
    let depth = 0;

    for (let i = startIdx; i < stdout.length; i++) {
      if (stdout[i] === openChar) depth++;
      else if (stdout[i] === closeChar) depth--;

      if (depth === 0) {
        try {
          return JSON.parse(stdout.slice(startIdx, i + 1));
        } catch {
          return null;
        }
      }
    }

    return null;
  }

  /**
   * Race a promise against a timeout. Rejects with a descriptive error
   * so callers can map it to status: "timeout".
   */
  protected withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Execution timed out after ${ms}ms`)),
        ms
      );

      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  /**
   * Retry a function up to `retries` times. Only retries on thrown errors,
   * not on logical failures inside the returned value.
   */
  protected async withRetry<T>(
    fn: () => Promise<T>,
    retries: number
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < retries) {
          // Exponential back-off: 200ms, 400ms, 800ms...
          await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
        }
      }
    }

    throw lastError!;
  }

  /** Scaffold an ExecutionResult with safe defaults. */
  protected createBaseResult(planId: string): ExecutionResult {
    return {
      planId,
      status: "error",
      totalTests: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
      coverage: null,
      failures: [],
      output: "",
    };
  }

  /**
   * Normalize Istanbul / v8 coverage JSON into our CoverageResult shape.
   * Accepts the parsed `coverageMap` or `total` object that both Istanbul
   * reporters and c8/v8-to-istanbul produce.
   */
  protected parseCoverage(coverageJson: any): CoverageResult | null {
    if (!coverageJson) return null;

    try {
      // Istanbul summary format: { total: { lines: { total, covered, pct }, ... } }
      const summary = coverageJson.total ?? coverageJson;

      const metric = (key: string): CoverageMetric => {
        const raw = summary[key];
        if (!raw || typeof raw.total !== "number") {
          return { total: 0, covered: 0, percentage: 0 };
        }
        return {
          total: raw.total,
          covered: raw.covered ?? 0,
          percentage:
            typeof raw.pct === "number"
              ? raw.pct
              : raw.total > 0
                ? (raw.covered / raw.total) * 100
                : 0,
        };
      };

      const result: CoverageResult = {
        lines: metric("lines"),
        branches: metric("branches"),
        functions: metric("functions"),
        statements: metric("statements"),
      };

      // Only return if we actually found data
      const hasData = result.lines.total > 0 || result.statements.total > 0;
      return hasData ? result : null;
    } catch {
      return null;
    }
  }
}
