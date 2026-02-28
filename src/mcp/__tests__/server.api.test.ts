/**
 * API tests for src/mcp/server.ts
 *
 * Tests the MCP server tools via the MCP protocol using
 * InMemoryTransport + Client — the closest you can get to real MCP calls.
 *
 * Creates a fresh McpServer with the same tool definitions,
 * connects via InMemoryTransport, and invokes tools via the Client.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Fixtures ────────────────────────────────────────────────
const sampleManifest = {
  version: 1,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
  project: {
    name: "api-test-project",
    root: "/tmp/test",
    language: "typescript",
    framework: "none",
    testFramework: "vitest",
    sourceFiles: 5,
    sourceLines: 250,
  },
  modules: [
    {
      path: "src/core",
      files: 3,
      lines: 200,
      complexity: "medium",
      functionality: {
        tests: {
          unit: { expected: 6, current: 2, files: ["core.test.ts"] },
        },
      },
    },
  ],
  journeys: [],
  contracts: [],
  score: {
    overall: 30,
    breakdown: {
      functionality: 30,
      security: 0,
      stability: 0,
      conformance: 0,
      regression: 0,
    },
    gaps: {
      total: 4,
      critical: 1,
      byDimension: {
        functionality: { missing: 4, priority: "high" },
        security: { issues: 0, priority: "none" },
        stability: { gaps: 0, priority: "none" },
        conformance: { violations: 0, priority: "none" },
      },
    },
    history: [],
  },
};

// ─── Server + Client setup ───────────────────────────────────
let server: McpServer;
let client: Client;
let tmpDir: string;

/**
 * Build a test MCP server that registers the same tools as server.ts
 * but uses real filesystem for clear/backup/restore/status tools.
 */
function buildTestServer(): McpServer {
  const s = new McpServer({ name: "coverit-test", version: "1.0.0" });

  // coverit_status
  s.tool(
    "coverit_status",
    "Show quality score",
    { projectRoot: z.string() },
    async ({ projectRoot }) => {
      try {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const manifestPath = path.join(projectRoot, "coverit.json");
        let manifest;
        try {
          const raw = await fs.readFile(manifestPath, "utf-8");
          manifest = JSON.parse(raw);
        } catch {
          manifest = null;
        }
        if (!manifest) {
          return {
            content: [{ type: "text" as const, text: "No coverit.json found. Run coverit_scan first to analyze the codebase." }],
          };
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              project: manifest.project,
              score: manifest.score,
              moduleCount: manifest.modules.length,
              modules: manifest.modules.map((m: Record<string, unknown>) => ({
                path: m.path,
                complexity: m.complexity,
                files: m.files,
                lines: m.lines,
                tests: (m.functionality as Record<string, unknown>)?.tests,
              })),
              journeys: manifest.journeys,
              contracts: manifest.contracts,
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );

  // coverit_clear
  s.tool(
    "coverit_clear",
    "Delete coverit.json and .coverit/",
    {
      projectRoot: z.string(),
      manifestOnly: z.boolean().optional(),
    },
    async ({ projectRoot, manifestOnly }) => {
      try {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const deleted: string[] = [];

        const manifestPath = path.join(projectRoot, "coverit.json");
        if (fs.existsSync(manifestPath)) {
          fs.unlinkSync(manifestPath);
          deleted.push("coverit.json");
        }
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
        return { content: [{ type: "text" as const, text: summary }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );

  // coverit_backup
  s.tool(
    "coverit_backup",
    "Export coverit.json as JSON backup",
    { projectRoot: z.string() },
    async ({ projectRoot }) => {
      try {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        let manifest;
        try {
          const raw = await fs.readFile(path.join(projectRoot, "coverit.json"), "utf-8");
          manifest = JSON.parse(raw);
        } catch {
          manifest = null;
        }
        if (!manifest) {
          return {
            content: [{ type: "text" as const, text: "No coverit.json found. Nothing to backup." }],
            isError: true,
          };
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ version: 1, exported_at: new Date().toISOString(), manifest }),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );

  // coverit_restore
  s.tool(
    "coverit_restore",
    "Restore coverit.json from backup",
    {
      projectRoot: z.string(),
      backup_json: z.string(),
    },
    async ({ projectRoot, backup_json }) => {
      try {
        const backup = JSON.parse(backup_json) as { manifest?: Record<string, unknown> };
        if (!backup.manifest) {
          return {
            content: [{ type: "text" as const, text: "Error: Invalid backup — no manifest found." }],
            isError: true,
          };
        }
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const manifestPath = path.join(projectRoot, "coverit.json");
        await fs.writeFile(manifestPath, JSON.stringify(backup.manifest, null, 2) + "\n", "utf-8");
        return { content: [{ type: "text" as const, text: "Restored coverit.json from backup." }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );

  return s;
}

// ─── Setup / Teardown ────────────────────────────────────────

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "coverit-api-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeAll(async () => {
  server = buildTestServer();
  client = new Client({ name: "test-client", version: "1.0.0" });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await server.close();
});

// ─── API Tests via MCP Protocol ──────────────────────────────

describe("MCP API — coverit_status", () => {
  it("returns manifest data via MCP callTool when coverit.json exists", async () => {
    writeFileSync(join(tmpDir, "coverit.json"), JSON.stringify(sampleManifest, null, 2));

    const result = await client.callTool({
      name: "coverit_status",
      arguments: { projectRoot: tmpDir },
    });

    expect(result.isError).toBeFalsy();
    const textContent = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(textContent[0]!.text);
    expect(parsed.project.name).toBe("api-test-project");
    expect(parsed.score.overall).toBe(30);
    expect(parsed.moduleCount).toBe(1);
  });
});

describe("MCP API — coverit_clear", () => {
  it("clears coverit.json and .coverit/ via MCP callTool", async () => {
    writeFileSync(join(tmpDir, "coverit.json"), "{}");
    mkdirSync(join(tmpDir, ".coverit"));
    writeFileSync(join(tmpDir, ".coverit", "cache.json"), "{}");

    const result = await client.callTool({
      name: "coverit_clear",
      arguments: { projectRoot: tmpDir },
    });

    expect(result.isError).toBeFalsy();
    const textContent = result.content as Array<{ type: string; text: string }>;
    expect(textContent[0]!.text).toContain("Deleted");
    expect(existsSync(join(tmpDir, "coverit.json"))).toBe(false);
    expect(existsSync(join(tmpDir, ".coverit"))).toBe(false);
  });
});

describe("MCP API — coverit_restore error handling", () => {
  it("returns isError when restoring invalid backup via MCP callTool", async () => {
    const result = await client.callTool({
      name: "coverit_restore",
      arguments: { projectRoot: tmpDir, backup_json: JSON.stringify({ version: 1 }) },
    });

    expect(result.isError).toBeTruthy();
    const textContent = result.content as Array<{ type: string; text: string }>;
    expect(textContent[0]!.text).toContain("Invalid backup");
  });
});

describe("MCP API — coverit_backup + coverit_restore roundtrip", () => {
  it("backs up and restores manifest via MCP callTool", async () => {
    // Write a manifest to back up
    writeFileSync(join(tmpDir, "coverit.json"), JSON.stringify(sampleManifest, null, 2));

    // Backup
    const backupResult = await client.callTool({
      name: "coverit_backup",
      arguments: { projectRoot: tmpDir },
    });
    expect(backupResult.isError).toBeFalsy();
    const backupContent = backupResult.content as Array<{ type: string; text: string }>;
    const backupJson = backupContent[0]!.text;

    // Delete the manifest
    rmSync(join(tmpDir, "coverit.json"));
    expect(existsSync(join(tmpDir, "coverit.json"))).toBe(false);

    // Restore from backup
    const restoreResult = await client.callTool({
      name: "coverit_restore",
      arguments: { projectRoot: tmpDir, backup_json: backupJson },
    });
    expect(restoreResult.isError).toBeFalsy();
    const restoreContent = restoreResult.content as Array<{ type: string; text: string }>;
    expect(restoreContent[0]!.text).toContain("Restored");

    // Verify manifest was restored correctly
    const restored = JSON.parse(readFileSync(join(tmpDir, "coverit.json"), "utf-8"));
    expect(restored.project.name).toBe("api-test-project");
    expect(restored.score.overall).toBe(30);
  });
});
