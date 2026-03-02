/**
 * Coverit — MCP Server
 *
 * 4-command architecture:
 *   coverit_scan    — AI explores codebase → creates coverit.json
 *   coverit_cover   — AI reads gaps → generates + runs + fixes tests → updates coverit.json
 *   coverit_run     — Run existing tests → fix failures → update coverit.json
 *   coverit_status  — Shows dashboard from coverit.json (instant, no AI)
 *
 * Plus utility tools: clear, backup, restore.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scanCodebase, type ScanDimension } from "../scale/analyzer.js";
import { readManifest, writeManifest } from "../scale/writer.js";
import { cover } from "../cover/pipeline.js";
import { runTests } from "../run/pipeline.js";
import { logger } from "../utils/logger.js";
import { useaiStart, useaiEnd } from "../integrations/useai.js";
import { UsageTracker } from "../utils/usage-tracker.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8")
);

const server = new McpServer({
  name: "coverit",
  version: pkg.version,
});

// ─── coverit_scan ───────────────────────────────────────────
// AI scans and analyzes codebase → creates coverit.json quality manifest.

server.tool(
  "coverit_scan",
  "Scan and analyze the full codebase using AI and generate coverit.json quality manifest. AI explores the project with tool access to detect modules, map existing tests, classify complexity, identify journeys and contracts, and compute baseline scores.",
  {
    projectRoot: z.string().describe("Absolute path to the project root"),
    full: z.boolean().optional().describe("Force a full codebase scan, ignoring incremental cache (default: false)"),
    dimensions: z
      .array(z.enum(["functionality", "security", "stability", "conformance", "regression"]))
      .optional()
      .describe("Only scan specific dimensions (default: all 5). When functionality is omitted, modules are loaded from existing coverit.json."),
    timeoutSeconds: z.number().optional().describe("Timeout per dimension in seconds (default: 1200)"),
  },
  async ({ projectRoot, full, dimensions, timeoutSeconds }) => {
    let session: Awaited<ReturnType<typeof useaiStart>> = null;
    try {
      session = await useaiStart("scan", projectRoot);
      const timeoutMs = timeoutSeconds ? timeoutSeconds * 1000 : undefined;
      const usageTracker = new UsageTracker();

      const manifest = await scanCodebase(projectRoot, {
        timeoutMs,
        dimensions: dimensions as ScanDimension[] | undefined,
        forceFullScan: full,
        usageTracker,
      });
      await writeManifest(projectRoot, manifest);

      await useaiEnd(session, {
        modules: manifest.modules.length,
        score: manifest.score.overall,
        language: manifest.project.language,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              project: manifest.project,
              moduleCount: manifest.modules.length,
              journeyCount: manifest.journeys.length,
              contractCount: manifest.contracts.length,
              score: manifest.score,
              modules: manifest.modules.map((m) => ({
                path: m.path,
                complexity: m.complexity,
                files: m.files,
                lines: m.lines,
                tests: m.functionality.tests,
              })),
              journeys: manifest.journeys,
              contracts: manifest.contracts,
              ...(usageTracker.hasUsage ? { usage: usageTracker.toJSON() } : {}),
            }, null, 2),
          },
        ],
      };
    } catch (err) {
      await useaiEnd(session, {});
      const message = err instanceof Error ? err.message : String(err);
      logger.error("coverit_scan failed:", message);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

// ─── coverit_cover ──────────────────────────────────────────
// AI reads gaps from coverit.json → generates tests → runs → fixes → updates score.

server.tool(
  "coverit_cover",
  "Generate tests to fill coverage gaps in coverit.json. AI reads the manifest, writes test files for each module with gaps, runs them, fixes failures, and updates the quality score.",
  {
    projectRoot: z.string().describe("Absolute path to the project root"),
    modules: z
      .array(z.string())
      .optional()
      .describe("Only cover specific modules (paths from coverit.json, e.g. ['src/services', 'src/utils'])"),
    parallel: z
      .number()
      .optional()
      .describe("Max modules to process in parallel (default: 3)"),
    timeoutSeconds: z
      .number()
      .optional()
      .describe("Timeout per module in seconds (default: 600)"),
  },
  async ({ projectRoot, modules, parallel, timeoutSeconds }) => {
    let session: Awaited<ReturnType<typeof useaiStart>> = null;
    try {
      session = await useaiStart("cover", projectRoot);
      const usageTracker = new UsageTracker();
      const result = await cover({
        projectRoot,
        modules,
        concurrency: parallel,
        timeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : undefined,
        usageTracker,
      });

      await useaiEnd(session, {
        scoreBefore: result.scoreBefore,
        scoreAfter: result.scoreAfter,
        testsGenerated: result.testsGenerated,
        testsPassed: result.testsPassed,
        testsFailed: result.testsFailed,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ...result,
              ...(usageTracker.hasUsage ? { usage: usageTracker.toJSON() } : {}),
            }, null, 2),
          },
        ],
      };
    } catch (err) {
      await useaiEnd(session, {});
      const message = err instanceof Error ? err.message : String(err);
      logger.error("coverit_cover failed:", message);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

// ─── coverit_run ────────────────────────────────────────────
// Run existing tests → fix failures via AI → rescan → update score.

server.tool(
  "coverit_run",
  "Run existing tests, fix failures via AI, rescan and update coverit.json. Unlike cover (which writes new tests), run assumes tests exist and just runs + fixes them.",
  {
    projectRoot: z.string().describe("Absolute path to the project root"),
    modules: z
      .array(z.string())
      .optional()
      .describe("Only run tests for specific modules (paths from coverit.json, e.g. ['src/services', 'src/utils'])"),
  },
  async ({ projectRoot, modules }) => {
    let session: Awaited<ReturnType<typeof useaiStart>> = null;
    try {
      session = await useaiStart("run", projectRoot);
      const usageTracker = new UsageTracker();
      const result = await runTests({
        projectRoot,
        modules,
        usageTracker,
      });

      await useaiEnd(session, {
        scoreBefore: result.scoreBefore,
        scoreAfter: result.scoreAfter,
        totalTests: result.totalTests,
        passed: result.passed,
        failed: result.failed,
        fixed: result.fixed,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ...result,
              ...(usageTracker.hasUsage ? { usage: usageTracker.toJSON() } : {}),
            }, null, 2),
          },
        ],
      };
    } catch (err) {
      await useaiEnd(session, {});
      const message = err instanceof Error ? err.message : String(err);
      logger.error("coverit_run failed:", message);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

// ─── coverit_status ──────────────────────────────────────────
// Show current quality score from coverit.json (instant, no AI).

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
          content: [{ type: "text" as const, text: "No coverit.json found. Run coverit_scan first to scan and analyze the codebase." }],
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
              journeys: manifest.journeys,
              contracts: manifest.contracts,
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

// ─── coverit_clear ──────────────────────────────────────────
// Delete coverit.json and .coverit/ directory for a fresh start.

server.tool(
  "coverit_clear",
  "Delete coverit.json and the .coverit/ directory. Use this to reset and start fresh.",
  {
    projectRoot: z.string().describe("Absolute path to the project root"),
    manifestOnly: z.boolean().optional().describe("Only delete coverit.json, keep .coverit/ directory"),
  },
  async ({ projectRoot, manifestOnly }) => {
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");

      const deleted: string[] = [];

      // Delete coverit.json
      const manifestPath = path.join(projectRoot, "coverit.json");
      if (fs.existsSync(manifestPath)) {
        fs.unlinkSync(manifestPath);
        deleted.push("coverit.json");
      }

      // Delete .coverit/ directory (unless manifestOnly)
      if (!manifestOnly) {
        const coveritDir = path.join(projectRoot, ".coverit");
        if (fs.existsSync(coveritDir)) {
          fs.rmSync(coveritDir, { recursive: true });
          deleted.push(".coverit/");
        }
      }

      const summary = deleted.length > 0
        ? `Deleted: ${deleted.join(", ")}`
        : "Nothing to clear — no coverit.json or .coverit/ found.";

      return {
        content: [{ type: "text" as const, text: summary }],
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

// ─── coverit_backup ──────────────────────────────────────────
// Export coverit.json as JSON for portability.

server.tool(
  "coverit_backup",
  "Export the coverit.json manifest as a JSON backup string.",
  {
    projectRoot: z.string().describe("Absolute path to project root"),
  },
  async ({ projectRoot }) => {
    try {
      const manifest = await readManifest(projectRoot);
      if (!manifest) {
        return {
          content: [{ type: "text" as const, text: "No coverit.json found. Nothing to backup." }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              version: 1,
              exported_at: new Date().toISOString(),
              manifest,
            }),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("coverit_backup failed:", message);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

// ─── coverit_restore ─────────────────────────────────────────
// Import coverit.json from a previously exported backup.

server.tool(
  "coverit_restore",
  "Restore coverit.json from a JSON backup string (from a previous coverit_backup export).",
  {
    projectRoot: z.string().describe("Absolute path to project root"),
    backup_json: z.string().describe("JSON string from a previous coverit_backup export"),
  },
  async ({ projectRoot, backup_json }) => {
    try {
      const backup = JSON.parse(backup_json) as {
        manifest?: Record<string, unknown>;
      };

      if (!backup.manifest) {
        return {
          content: [{ type: "text" as const, text: "Error: Invalid backup — no manifest found." }],
          isError: true,
        };
      }

      await writeManifest(projectRoot, backup.manifest as never);

      return {
        content: [{ type: "text" as const, text: "Restored coverit.json from backup." }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("coverit_restore failed:", message);
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
