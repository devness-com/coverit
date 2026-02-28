/**
 * Integration tests for src/mcp/server.ts
 *
 * Tests tool handlers with real filesystem operations (temp directories)
 * while mocking only the AI-dependent operations (scanCodebase, cover).
 *
 * Focus: coverit_clear, coverit_backup, coverit_restore, coverit_status
 * — the tools that do real file I/O.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Type for captured tool handler ──────────────────────────
type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

// ─── Capture tool registrations ──────────────────────────────
const toolHandlers = new Map<string, ToolHandler>();

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    tool: vi.fn(
      (
        name: string,
        _description: string,
        _schema: unknown,
        handler: ToolHandler,
      ) => {
        toolHandlers.set(name, handler);
      },
    ),
    connect: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));

// Mock ONLY AI-dependent modules — let writer (fs) be real
const mockAnalyzeCodebase = vi.fn();
const mockCover = vi.fn();

vi.mock("../../scale/analyzer.js", () => ({
  scanCodebase: (...args: unknown[]) => mockAnalyzeCodebase(...args),
}));

vi.mock("../../cover/pipeline.js", () => ({
  cover: (...args: unknown[]) => mockCover(...args),
}));

vi.mock("../../run/pipeline.js", () => ({
  runTests: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// ─── Import the module ───────────────────────────────────────
beforeEach(async () => {
  toolHandlers.clear();
  vi.resetModules();
  await import("../server.js");
});

// ─── Temp directory management ───────────────────────────────
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "coverit-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Fixtures ────────────────────────────────────────────────
const sampleManifest = {
  version: 1,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
  project: {
    name: "integration-test",
    root: "/tmp/test",
    language: "typescript",
    framework: "none",
    testFramework: "vitest",
    sourceFiles: 10,
    sourceLines: 500,
  },
  modules: [
    {
      path: "src/utils",
      files: 3,
      lines: 150,
      complexity: "low",
      functionality: {
        tests: {
          unit: { expected: 5, current: 2, files: ["utils.test.ts"] },
        },
      },
    },
    {
      path: "src/services",
      files: 8,
      lines: 600,
      complexity: "high",
      functionality: {
        tests: {
          unit: { expected: 12, current: 4, files: ["auth.test.ts"] },
          integration: { expected: 8, current: 3, files: [] },
        },
      },
    },
  ],
  journeys: [],
  contracts: [],
  score: {
    overall: 35,
    breakdown: {
      functionality: 35,
      security: 0,
      stability: 0,
      conformance: 0,
      regression: 0,
    },
    gaps: {
      total: 16,
      critical: 5,
      byDimension: {
        functionality: { missing: 16, priority: "high" },
        security: { issues: 0, priority: "none" },
        stability: { gaps: 0, priority: "none" },
        conformance: { violations: 0, priority: "none" },
      },
    },
    history: [],
  },
};

// ─── coverit_clear integration tests ─────────────────────────

describe("coverit_clear — real filesystem", () => {
  it("deletes coverit.json when it exists", async () => {
    const manifestPath = join(tmpDir, "coverit.json");
    writeFileSync(manifestPath, JSON.stringify(sampleManifest));
    expect(existsSync(manifestPath)).toBe(true);

    const handler = toolHandlers.get("coverit_clear")!;
    const result = await handler({ projectRoot: tmpDir });

    expect(existsSync(manifestPath)).toBe(false);
    expect(result.content[0]!.text).toContain("coverit.json");
  });

  it("deletes .coverit/ directory along with coverit.json", async () => {
    const manifestPath = join(tmpDir, "coverit.json");
    const coveritDir = join(tmpDir, ".coverit");
    writeFileSync(manifestPath, JSON.stringify(sampleManifest));
    mkdirSync(coveritDir, { recursive: true });
    writeFileSync(join(coveritDir, "data.json"), "{}");

    const handler = toolHandlers.get("coverit_clear")!;
    const result = await handler({ projectRoot: tmpDir });

    expect(existsSync(manifestPath)).toBe(false);
    expect(existsSync(coveritDir)).toBe(false);
    expect(result.content[0]!.text).toContain("coverit.json");
    expect(result.content[0]!.text).toContain(".coverit/");
  });

  it("keeps .coverit/ when manifestOnly is true", async () => {
    const manifestPath = join(tmpDir, "coverit.json");
    const coveritDir = join(tmpDir, ".coverit");
    writeFileSync(manifestPath, JSON.stringify(sampleManifest));
    mkdirSync(coveritDir, { recursive: true });
    writeFileSync(join(coveritDir, "cache.json"), "{}");

    const handler = toolHandlers.get("coverit_clear")!;
    const result = await handler({ projectRoot: tmpDir, manifestOnly: true });

    expect(existsSync(manifestPath)).toBe(false);
    expect(existsSync(coveritDir)).toBe(true);
    expect(result.content[0]!.text).toContain("coverit.json");
    expect(result.content[0]!.text).not.toContain(".coverit/");
  });

  it("reports nothing to clear when files do not exist", async () => {
    const handler = toolHandlers.get("coverit_clear")!;
    const result = await handler({ projectRoot: tmpDir });

    expect(result.content[0]!.text).toContain("Nothing to clear");
  });
});

// ─── coverit_status integration tests ────────────────────────

describe("coverit_status — real filesystem", () => {
  it("reads and returns manifest from real coverit.json file", async () => {
    const manifestPath = join(tmpDir, "coverit.json");
    writeFileSync(manifestPath, JSON.stringify(sampleManifest, null, 2));

    const handler = toolHandlers.get("coverit_status")!;
    const result = await handler({ projectRoot: tmpDir });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.project.name).toBe("integration-test");
    expect(parsed.score.overall).toBe(35);
    expect(parsed.moduleCount).toBe(2);
  });

  it("returns guidance when no coverit.json exists on disk", async () => {
    const handler = toolHandlers.get("coverit_status")!;
    const result = await handler({ projectRoot: tmpDir });

    expect(result.content[0]!.text).toContain("No coverit.json found");
  });
});

// ─── coverit_backup integration tests ────────────────────────

describe("coverit_backup — real filesystem", () => {
  it("reads real coverit.json and returns backup payload", async () => {
    const manifestPath = join(tmpDir, "coverit.json");
    writeFileSync(manifestPath, JSON.stringify(sampleManifest, null, 2));

    const handler = toolHandlers.get("coverit_backup")!;
    const result = await handler({ projectRoot: tmpDir });

    expect(result.isError).toBeUndefined();
    const backup = JSON.parse(result.content[0]!.text);
    expect(backup.version).toBe(1);
    expect(backup.exported_at).toBeDefined();
    expect(backup.manifest.project.name).toBe("integration-test");
    expect(backup.manifest.modules).toHaveLength(2);
  });

  it("returns error when no coverit.json exists on disk for backup", async () => {
    const handler = toolHandlers.get("coverit_backup")!;
    const result = await handler({ projectRoot: tmpDir });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Nothing to backup");
  });
});

// ─── coverit_restore integration tests ───────────────────────

describe("coverit_restore — real filesystem", () => {
  it("writes coverit.json from valid backup JSON", async () => {
    const backupPayload = JSON.stringify({
      version: 1,
      exported_at: "2025-06-01T00:00:00Z",
      manifest: sampleManifest,
    });

    const handler = toolHandlers.get("coverit_restore")!;
    const result = await handler({
      projectRoot: tmpDir,
      backup_json: backupPayload,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("Restored");

    // Verify the file was actually written
    const manifestPath = join(tmpDir, "coverit.json");
    expect(existsSync(manifestPath)).toBe(true);
    const written = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(written.project.name).toBe("integration-test");
  });

  it("returns error when backup JSON has no manifest field", async () => {
    const handler = toolHandlers.get("coverit_restore")!;
    const result = await handler({
      projectRoot: tmpDir,
      backup_json: JSON.stringify({ version: 1 }),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Invalid backup");
  });

  it("returns error when backup_json is not valid JSON", async () => {
    const handler = toolHandlers.get("coverit_restore")!;
    const result = await handler({
      projectRoot: tmpDir,
      backup_json: "not valid json {{",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Error:");
  });
});
