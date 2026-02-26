/**
 * Coverit — MCP Server
 *
 * 3-command architecture:
 *   coverit_analyze — AI explores codebase → creates coverit.json
 *   coverit_cover   — AI reads gaps → generates + runs + fixes tests → updates coverit.json
 *   coverit_status  — Shows dashboard from coverit.json (instant, no AI)
 *
 * Plus utility tools: clear, backup, restore.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { analyzeCodebase } from "../scale/analyzer.js";
import { readManifest, writeManifest } from "../scale/writer.js";
import { cover } from "../cover/pipeline.js";
import { logger } from "../utils/logger.js";

const server = new McpServer({
  name: "coverit",
  version: "1.0.0",
});

// ─── coverit_analyze ─────────────────────────────────────────
// AI explores codebase → creates coverit.json quality manifest.

server.tool(
  "coverit_analyze",
  "Analyze the full codebase using AI and generate coverit.json quality manifest. AI explores the project with tool access to detect modules, map existing tests, classify complexity, identify journeys and contracts, and compute baseline scores.",
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
  },
  async ({ projectRoot, modules }) => {
    try {
      const result = await cover({
        projectRoot,
        modules,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("coverit_cover failed:", message);
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
          content: [{ type: "text" as const, text: "No coverit.json found. Run coverit_analyze first to analyze the codebase." }],
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
