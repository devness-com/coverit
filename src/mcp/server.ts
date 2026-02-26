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
import { analyzeCodebase } from "../scale/analyzer.js";
import { readManifest, writeManifest } from "../scale/writer.js";
import { scanTests } from "../measure/scanner.js";
import { rescoreManifest } from "../measure/scorer.js";
import { logger } from "../utils/logger.js";
import type { TestType, DiffSource, CoveritConfig } from "../types/index.js";
import type { FunctionalTestType } from "../schema/coverit-manifest.js";

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
  all: z
    .boolean()
    .optional()
    .describe("Scan all source files in the project (full coverage audit, ignores git diff)"),
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
  all?: boolean;
}): DiffSource | undefined {
  if (params.staged) return { mode: "staged" };
  if (params.commit) return { mode: "commit", ref: params.commit };
  if (params.pr !== undefined) return { mode: "pr", number: params.pr };
  if (params.files && params.files.length > 0) return { mode: "files", patterns: params.files };
  if (params.all) return { mode: "all" };
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
    priorFailures: z
      .array(
        z.object({
          planId: z.string(),
          description: z.string(),
          testFile: z.string(),
          failureMessages: z.array(z.string()),
          priorTestCode: z.string().optional(),
        }),
      )
      .optional()
      .describe("Failure data from a prior SGR cycle for re-scanning with different approach"),
  },
  async ({ projectRoot, testTypes, baseBranch, commit, pr, files, staged, all, priorFailures }) => {
    try {
      const config: CoveritConfig = {
        projectRoot,
        testTypes: parseTestTypes(testTypes),
        diffSource: parseDiffSource({ baseBranch, commit, pr, files, staged, all }),
        analyzeOnly: true,
        priorFailures,
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
  async ({ projectRoot, testTypes, baseBranch, commit, pr, files, staged, all }) => {
    try {
      const config: CoveritConfig = {
        projectRoot,
        testTypes: parseTestTypes(testTypes),
        diffSource: parseDiffSource({ baseBranch, commit, pr, files, staged, all }),
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
  async ({ projectRoot, testTypes, environment, coverage, baseBranch, commit, pr, files, staged, all }) => {
    try {
      const config: CoveritConfig = {
        projectRoot,
        testTypes: parseTestTypes(testTypes),
        diffSource: parseDiffSource({ baseBranch, commit, pr, files, staged, all }),
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
    generateOnly: z
      .boolean()
      .optional()
      .describe("Generate test files without executing them (defaults to false)"),
    ...diffSourceSchema,
  },
  async ({ projectRoot, planIds, runId, environment, coverage, generateOnly, baseBranch, commit, pr, files, staged, all }) => {
    try {
      const config: CoveritConfig = {
        projectRoot,
        planIds,
        runId,
        useCache: true,
        diffSource: parseDiffSource({ baseBranch, commit, pr, files, staged, all }),
        environment: environment ?? "local",
        coverageThreshold: coverage ? 0 : undefined,
        generateOnly: generateOnly ?? false,
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
  async ({ projectRoot, testTypes, environment, coverage, baseBranch, commit, pr, files, staged, all }) => {
    try {
      const config: CoveritConfig = {
        projectRoot,
        testTypes: parseTestTypes(testTypes),
        diffSource: parseDiffSource({ baseBranch, commit, pr, files, staged, all }),
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
// Show current quality score from coverit.json (instant, no scanning).

server.tool(
  "coverit_status",
  "Show current quality score from coverit.json. Returns the manifest score breakdown, module summary, and gap analysis. Instant — no scanning or AI.",
  {
    projectRoot: z.string().describe("Absolute path to the project root"),
  },
  async ({ projectRoot }) => {
    try {
      const manifest = await readManifest(projectRoot);
      if (!manifest) {
        return {
          content: [{ type: "text" as const, text: "No coverit.json found. Run coverit_scale first to analyze the codebase." }],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              project: manifest.project,
              score: manifest.score,
              moduleCount: manifest.modules.length,
              modules: manifest.modules.map((m) => ({
                path: m.path,
                complexity: m.complexity,
                files: m.files,
                lines: m.lines,
                tests: m.functionality.tests,
              })),
            }, null, 2),
          },
        ],
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

// ─── coverit_run_status ─────────────────────────────────────
// Show details for a specific coverit run.

server.tool(
  "coverit_run_status",
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
      logger.error("coverit_run_status failed:", message);
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

// ─── coverit_scale ───────────────────────────────────────────
// Full codebase analysis — produces coverit.json.

server.tool(
  "coverit_scale",
  "Analyze the full codebase and generate coverit.json quality manifest. Detects modules, maps existing tests, classifies complexity, and computes baseline scores. No AI — pure filesystem analysis.",
  {
    projectRoot: z.string().describe("Absolute path to the project root"),
  },
  async ({ projectRoot }) => {
    try {
      const manifest = await analyzeCodebase(projectRoot);
      await writeManifest(projectRoot, manifest);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              project: manifest.project,
              moduleCount: manifest.modules.length,
              score: manifest.score,
              modules: manifest.modules.map((m) => ({
                path: m.path,
                complexity: m.complexity,
                files: m.files,
                lines: m.lines,
                tests: m.functionality.tests,
              })),
            }, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("coverit_scale failed:", message);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

// ─── coverit_measure ────────────────────────────────────────
// Rescan test files and recalculate quality score (no AI, fast).

server.tool(
  "coverit_measure",
  "Rescan the project for test files and recalculate quality scores from coverit.json. Updates test counts and rescores all dimensions. No AI — filesystem scan only.",
  {
    projectRoot: z.string().describe("Absolute path to the project root"),
  },
  async ({ projectRoot }) => {
    try {
      const manifest = await readManifest(projectRoot);
      if (!manifest) {
        return {
          content: [{ type: "text" as const, text: "No coverit.json found. Run coverit_scale first." }],
          isError: true,
        };
      }

      // Scan filesystem for current test counts
      const scanResult = await scanTests(projectRoot, manifest.modules);

      // Update module test counts from scan results
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

      // Rescore and write
      const rescored = rescoreManifest(manifest);
      await writeManifest(projectRoot, rescored);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              totalTestFiles: scanResult.totalTestFiles,
              totalTestCount: scanResult.totalTestCount,
              score: rescored.score,
              modules: rescored.modules.map((m) => ({
                path: m.path,
                complexity: m.complexity,
                tests: m.functionality.tests,
              })),
            }, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("coverit_measure failed:", message);
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
