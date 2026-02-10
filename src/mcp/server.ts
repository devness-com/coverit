/**
 * Coverit — MCP Server
 *
 * Exposes coverit capabilities as MCP tools for Claude Code integration.
 * Each tool maps to a pipeline operation: analyze, generate, run, or full pipeline.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { orchestrate } from "../agents/orchestrator.js";
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
    ...diffSourceSchema,
  },
  async ({ projectRoot, baseBranch, commit, pr, files, staged }) => {
    try {
      const config: CoveritConfig = {
        projectRoot,
        diffSource: parseDiffSource({ baseBranch, commit, pr, files, staged }),
        generateOnly: true,
        skipExecution: true,
      };

      const report = await orchestrate(config);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(report.strategy, null, 2),
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
