/**
 * Coverit — MCP Server
 *
 * Exposes coverit capabilities as MCP tools for Claude Code integration.
 * Each tool maps to a pipeline operation: analyze, generate, run, or full pipeline.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { orchestrate, fixFailingTests, recheckTests, verifyExistingTests } from "../agents/orchestrator.js";
import { listRuns, resolveRunId, getRunStatus, deleteRun, clearRuns } from "../utils/run-manager.js";
import { logger } from "../utils/logger.js";
import type { TestType, DiffSource, CoveritConfig } from "../types/index.js";

const VALID_TEST_TYPES: TestType[] = [
  "unit",
  "integration",
  "api",
  "e2e-browser",
  "e2e-mobile",
  "e2e-desktop",
  "snapshot",
  "performance",
];

function parseTestTypes(raw?: string[]): TestType[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.filter((t): t is TestType =>
    VALID_TEST_TYPES.includes(t as TestType),
  );
}

/**
 * Shared Zod schemas for diff source parameters used across all tools.
 */
const diffSourceSchema = {
  baseBranch: z
    .string()
    .optional()
    .describe("Diff against a specific base branch (e.g. 'main')"),
  commit: z
    .string()
    .optional()
    .describe("Diff for a specific commit or range (e.g. 'HEAD~1', 'abc..def')"),
  pr: z
    .number()
    .optional()
    .describe("Diff for a pull request by number (auto-detects base branch)"),
  files: z
    .array(z.string())
    .optional()
    .describe("Target specific files by glob patterns (e.g. ['src/ai/**'])"),
  staged: z
    .boolean()
    .optional()
    .describe("Only analyze staged (git index) changes"),
};

/**
 * Parse MCP tool params into a DiffSource.
 * Priority: staged > commit > pr > files > baseBranch > auto
 */
function parseDiffSource(params: {
  baseBranch?: string;
  commit?: string;
  pr?: number;
  files?: string[];
  staged?: boolean;
}): DiffSource | undefined {
  if (params.staged) return { mode: "staged" };
  if (params.commit) return { mode: "commit", ref: params.commit };
  if (params.pr !== undefined) return { mode: "pr", number: params.pr };
  if (params.files && params.files.length > 0) return { mode: "files", patterns: params.files };
  if (params.baseBranch) return { mode: "base", branch: params.baseBranch };
  return undefined;
}

const server = new McpServer({
  name: "coverit",
  version: "0.1.0",
});

// ─── coverit_analyze ─────────────────────────────────────────
// Analyze codebase and return a test strategy without generating or running tests.

server.tool(
  "coverit_analyze",
  "Analyze a codebase and return a test strategy including detected framework, changed files, and proposed test plans.",
  {
    projectRoot: z.string().describe("Absolute path to the project root"),
    testTypes: z
      .array(z.string())
      .optional()
      .describe(
        "Types of tests to include in the strategy (unit, api, e2e-browser, etc.). Omit for all.",
      ),
    ...diffSourceSchema,
  },
  async ({ projectRoot, testTypes, baseBranch, commit, pr, files, staged }) => {
    try {
      const config: CoveritConfig = {
        projectRoot,
        testTypes: parseTestTypes(testTypes),
        diffSource: parseDiffSource({ baseBranch, commit, pr, files, staged }),
        analyzeOnly: true,
      };

      const report = await orchestrate(config);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              runId: report.runId,
              strategy: report.strategy,
              skipped: report.triageSkipped,
            }, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("coverit_analyze failed:", message);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

// ─── coverit_generate ────────────────────────────────────────
// Generate test files based on analysis, without running them.

server.tool(
  "coverit_generate",
  "Generate test files for a project. Returns the list of generated file paths.",
  {
    projectRoot: z.string().describe("Absolute path to the project root"),
    testTypes: z
      .array(z.string())
      .optional()
      .describe(
        "Types of tests to generate (unit, api, e2e-browser, etc.). Omit for all.",
      ),
    ...diffSourceSchema,
  },
  async ({ projectRoot, testTypes, baseBranch, commit, pr, files, staged }) => {
    try {
      const config: CoveritConfig = {
        projectRoot,
        testTypes: parseTestTypes(testTypes),
        diffSource: parseDiffSource({ baseBranch, commit, pr, files, staged }),
        generateOnly: true,
      };

      const report = await orchestrate(config);

      const generatedFiles = report.results.map((r) => ({
        planId: r.planId,
        status: r.status,
        testCount: r.totalTests,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                runId: report.runId,
                generated: generatedFiles,
                strategy: report.strategy,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("coverit_generate failed:", message);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

// ─── coverit_run ─────────────────────────────────────────────
// Run previously generated tests (or generate + run).

server.tool(
  "coverit_run",
  "Run generated tests and return execution results with optional coverage.",
  {
    projectRoot: z.string().describe("Absolute path to the project root"),
    testTypes: z
      .array(z.string())
      .optional()
      .describe("Types of tests to run. Omit for all."),
    environment: z
      .enum(["local", "cloud-sandbox", "browser", "mobile-simulator", "desktop-app"])
      .optional()
      .describe("Execution environment (defaults to local)"),
    coverage: z
      .boolean()
      .optional()
      .describe("Collect coverage data (defaults to false)"),
    ...diffSourceSchema,
  },
  async ({ projectRoot, testTypes, environment, coverage, baseBranch, commit, pr, files, staged }) => {
    try {
      const config: CoveritConfig = {
        projectRoot,
        testTypes: parseTestTypes(testTypes),
        diffSource: parseDiffSource({ baseBranch, commit, pr, files, staged }),
        environment: environment ?? "local",
        coverageThreshold: coverage ? 0 : undefined,
      };

      const report = await orchestrate(config);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                runId: report.runId,
                summary: report.summary,
                results: report.results,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("coverit_run failed:", message);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

// ─── coverit_execute_batch ───────────────────────────────────
// Execute a specific batch of test plans by ID.

server.tool(
  "coverit_execute_batch",
  "Execute a specific batch of test plans by ID. Use after coverit_analyze to run a subset of plans.",
  {
    projectRoot: z.string().describe("Absolute path to the project root"),
    planIds: z
      .array(z.string())
      .describe("Plan IDs to execute (from coverit_analyze output)"),
    runId: z
      .string()
      .optional()
      .describe("Run ID from a prior coverit_analyze call. Defaults to latest run."),
    environment: z
      .enum(["local", "cloud-sandbox", "browser", "mobile-simulator", "desktop-app"])
      .optional()
      .describe("Execution environment (defaults to local)"),
    coverage: z
      .boolean()
      .optional()
      .describe("Collect coverage data (defaults to false)"),
    ...diffSourceSchema,
  },
  async ({ projectRoot, planIds, runId, environment, coverage, baseBranch, commit, pr, files, staged }) => {
    try {
      const config: CoveritConfig = {
        projectRoot,
        planIds,
        runId,
        useCache: true,
        diffSource: parseDiffSource({ baseBranch, commit, pr, files, staged }),
        environment: environment ?? "local",
        coverageThreshold: coverage ? 0 : undefined,
      };

      const report = await orchestrate(config);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                runId: report.runId,
                summary: report.summary,
                results: report.results,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("coverit_execute_batch failed:", message);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

// ─── coverit_fix ─────────────────────────────────────────────
// Fix failing tests from the last coverit run using AI refinement.

server.tool(
  "coverit_fix",
  "Fix failing tests from the last coverit run using AI refinement. Reads failure details, fixes test code, and re-executes.",
  {
    projectRoot: z.string().describe("Absolute path to the project root"),
    planIds: z
      .array(z.string())
      .optional()
      .describe("Specific plan IDs to fix. Omit to fix all failed plans."),
    runId: z
      .string()
      .optional()
      .describe("Target a specific run ID. Defaults to latest run."),
    maxRetries: z
      .number()
      .optional()
      .describe("Max fix attempts per plan (default: 2)"),
  },
  async ({ projectRoot, planIds, runId, maxRetries }) => {
    try {
      const report = await fixFailingTests({ projectRoot, planIds, runId, maxRetries });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                runId: report.runId,
                summary: report.summary,
                results: report.results,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("coverit_fix failed:", message);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

// ─── coverit_recheck ─────────────────────────────────────────
// Re-run existing test files and update status without AI refinement.

server.tool(
  "coverit_recheck",
  "Re-run existing test files from a prior coverit run and update status. Use after manually fixing tests outside the pipeline.",
  {
    projectRoot: z.string().describe("Absolute path to the project root"),
    planIds: z
      .array(z.string())
      .optional()
      .describe("Specific plan IDs to recheck. Omit to recheck all plans with test files."),
    runId: z
      .string()
      .optional()
      .describe("Target a specific run ID. Defaults to latest run."),
  },
  async ({ projectRoot, planIds, runId }) => {
    try {
      const report = await recheckTests({ projectRoot, planIds, runId });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                runId: report.runId,
                summary: report.summary,
                results: report.results,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("coverit_recheck failed:", message);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

// ─── coverit_verify ──────────────────────────────────────────
// Run existing test files from a prior scan to verify they pass.

server.tool(
  "coverit_verify",
  "Run existing test files identified by a prior coverit scan to verify they pass. Use after /coverit:scan shows all changes are covered.",
  {
    projectRoot: z.string().describe("Absolute path to the project root"),
    runId: z
      .string()
      .optional()
      .describe("Target a specific run ID from a prior scan. Defaults to latest run."),
  },
  async ({ projectRoot, runId }) => {
    try {
      const report = await verifyExistingTests({ projectRoot, runId });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                runId: report.runId,
                summary: report.summary,
                results: report.results.map((r) => ({
                  planId: r.planId,
                  status: r.status,
                  passed: r.passed,
                  failed: r.failed,
                  duration: r.duration,
                  failures: r.failures.length > 0 ? r.failures.slice(0, 3) : undefined,
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("coverit_verify failed:", message);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

// ─── coverit_full ────────────────────────────────────────────
// Full pipeline: analyze, generate, run, and report.

server.tool(
  "coverit_full",
  "Run the full coverit pipeline: analyze the codebase, generate tests, execute them, and return a comprehensive report.",
  {
    projectRoot: z.string().describe("Absolute path to the project root"),
    testTypes: z
      .array(z.string())
      .optional()
      .describe("Types of tests to include. Omit for all."),
    environment: z
      .enum(["local", "cloud-sandbox", "browser", "mobile-simulator", "desktop-app"])
      .optional()
      .describe("Execution environment (defaults to local)"),
    coverage: z
      .boolean()
      .optional()
      .describe("Collect coverage data (defaults to false)"),
    ...diffSourceSchema,
  },
  async ({ projectRoot, testTypes, environment, coverage, baseBranch, commit, pr, files, staged }) => {
    try {
      const config: CoveritConfig = {
        projectRoot,
        testTypes: parseTestTypes(testTypes),
        diffSource: parseDiffSource({ baseBranch, commit, pr, files, staged }),
        environment: environment ?? "local",
        coverageThreshold: coverage ? 0 : undefined,
      };

      const report = await orchestrate(config);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(report, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("coverit_full failed:", message);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

// ─── coverit_runs ────────────────────────────────────────────
// List all coverit runs with metadata.

server.tool(
  "coverit_runs",
  "List all coverit test runs with metadata. Filter by scope (e.g. 'pr-99', 'staged').",
  {
    projectRoot: z.string().describe("Absolute path to the project root"),
    scope: z.string().optional().describe("Filter by scope (e.g. 'pr-99', 'staged')"),
  },
  async ({ projectRoot, scope }) => {
    try {
      const runs = await listRuns(projectRoot, scope);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(runs, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("coverit_runs failed:", message);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

// ─── coverit_status ──────────────────────────────────────────
// Show details for a specific coverit run.

server.tool(
  "coverit_status",
  "Show details for a specific coverit run including per-plan breakdown.",
  {
    projectRoot: z.string().describe("Absolute path to the project root"),
    runId: z.string().optional().describe("Run ID. Defaults to latest run."),
  },
  async ({ projectRoot, runId }) => {
    try {
      const id = runId ?? (await resolveRunId(projectRoot, {}));
      const status = await getRunStatus(projectRoot, id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("coverit_status failed:", message);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

// ─── coverit_clear ────────────────────────────────────────────
// Delete runs and optionally their generated test files.

server.tool(
  "coverit_clear",
  "Delete coverit runs and optionally clean up generated test files. Can target a specific run, a scope (e.g. 'pr-99'), or all runs.",
  {
    projectRoot: z.string().describe("Absolute path to the project root"),
    runId: z.string().optional().describe("Delete a specific run by ID"),
    scope: z.string().optional().describe("Delete all runs matching scope (e.g. 'pr-99', 'staged')"),
    all: z.boolean().optional().describe("Delete all runs"),
    cleanTestFiles: z.boolean().optional().describe("Also delete generated test files from the project"),
  },
  async ({ projectRoot, runId, scope, all, cleanTestFiles }) => {
    try {
      let deletedCount = 0;
      let testFiles: string[] = [];

      if (runId) {
        const result = await deleteRun(projectRoot, runId);
        deletedCount = 1;
        testFiles = result.testFiles;
      } else if (all) {
        const result = await clearRuns(projectRoot);
        deletedCount = result.deletedCount;
        testFiles = result.testFiles;
      } else if (scope) {
        const result = await clearRuns(projectRoot, scope);
        deletedCount = result.deletedCount;
        testFiles = result.testFiles;
      } else {
        return {
          content: [{ type: "text" as const, text: "Error: Specify --run <id>, --scope <scope>, or --all" }],
          isError: true,
        };
      }

      // Optionally delete generated test files from the project
      let cleanedFiles = 0;
      if (cleanTestFiles && testFiles.length > 0) {
        const { existsSync } = await import("node:fs");
        const { unlink } = await import("node:fs/promises");
        for (const tf of testFiles) {
          const absPath = tf.startsWith("/") ? tf : (await import("node:path")).join(projectRoot, tf);
          if (existsSync(absPath)) {
            try {
              await unlink(absPath);
              cleanedFiles++;
            } catch {
              // File may be locked or already deleted
            }
          }
        }
      }

      const summary = {
        deletedRuns: deletedCount,
        testFilesFound: testFiles.length,
        testFilesDeleted: cleanedFiles,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("coverit_clear failed:", message);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

// ─── Start Server ────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.debug("MCP server connected via stdio");
}

main().catch((err) => {
  logger.error("Failed to start MCP server:", err);
  process.exit(1);
});
