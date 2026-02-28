/**
 * Integration tests for writer.ts
 * Tests readManifest and writeManifest against the real filesystem.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readManifest, writeManifest } from "../writer.js";
import type { CoveritManifest } from "../../schema/coverit-manifest.js";
import { DEFAULT_DIMENSIONS } from "../../schema/defaults.js";

// ─── Fixtures ────────────────────────────────────────────────

function createTestManifest(overrides?: Partial<CoveritManifest>): CoveritManifest {
  return {
    version: 1,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T00:00:00.000Z",
    project: {
      name: "integration-test",
      root: "/tmp/test",
      language: "typescript",
      framework: "nestjs",
      testFramework: "vitest",
      sourceFiles: 25,
      sourceLines: 3500,
    },
    dimensions: DEFAULT_DIMENSIONS,
    modules: [
      {
        path: "src/services",
        files: 10,
        lines: 2000,
        complexity: "high",
        functionality: {
          tests: {
            unit: { expected: 12, current: 8, files: ["unit.test.ts"] },
            integration: { expected: 20, current: 10, files: ["int.test.ts"] },
            api: { expected: 8, current: 3, files: [] },
          },
        },
        security: { issues: 1, resolved: 0, findings: ["injection:service.ts:42"] },
        stability: { score: 75, gaps: ["No timeout handling"] },
        conformance: { score: 85, violations: [] },
      },
      {
        path: "src/utils",
        files: 3,
        lines: 200,
        complexity: "low",
        functionality: {
          tests: {
            unit: { expected: 3, current: 3, files: ["utils.test.ts"] },
          },
        },
        security: { issues: 0, resolved: 0, findings: [] },
        stability: { score: 90, gaps: [] },
        conformance: { score: 95, violations: [] },
      },
    ],
    journeys: [
      {
        id: "j1",
        name: "User registration",
        steps: ["Open form", "Fill fields", "Submit", "Verify email"],
        covered: false,
        testFile: null,
      },
    ],
    contracts: [
      {
        endpoint: "POST /api/users",
        method: "POST",
        requestSchema: "CreateUserDto",
        responseSchema: "UserResponse",
        covered: true,
        testFile: "contract.test.ts",
      },
    ],
    score: {
      overall: 65,
      breakdown: {
        functionality: 55,
        security: 75,
        stability: 80,
        conformance: 85,
        regression: 100,
      },
      gaps: {
        total: 12,
        critical: 0,
        byDimension: {
          functionality: { missing: 9, priority: "high" },
          security: { issues: 1, priority: "medium" },
          stability: { gaps: 1, priority: "low" },
          conformance: { violations: 0, priority: "none" },
        },
      },
      history: [
        { date: "2024-01-01", score: 50, scope: "first-time" },
        { date: "2024-01-02", score: 65, scope: "re-analysis" },
      ],
    },
    ...overrides,
  };
}

// ─── Test Suite ──────────────────────────────────────────────

describe("writer integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "coverit-writer-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("writeManifest + readManifest round-trip", () => {
    it("writes and reads back an identical manifest", async () => {
      const manifest = createTestManifest();

      await writeManifest(tempDir, manifest);
      const loaded = await readManifest(tempDir);

      expect(loaded).not.toBeNull();
      expect(loaded).toEqual(manifest);
    });

    it("writes manifest as formatted JSON with 2-space indentation", async () => {
      const manifest = createTestManifest();

      await writeManifest(tempDir, manifest);

      const raw = await readFile(join(tempDir, "coverit.json"), "utf-8");
      // Check formatting: 2-space indentation
      expect(raw).toContain('  "version": 1');
      // Trailing newline
      expect(raw).toMatch(/\n$/);
    });

    it("overwrites existing manifest file on second write", async () => {
      const manifest1 = createTestManifest({ createdAt: "2024-01-01" });
      const manifest2 = createTestManifest({ createdAt: "2024-06-01" });

      await writeManifest(tempDir, manifest1);
      await writeManifest(tempDir, manifest2);

      const loaded = await readManifest(tempDir);
      expect(loaded!.createdAt).toBe("2024-06-01");
    });

    it("preserves all module data through round-trip", async () => {
      const manifest = createTestManifest();

      await writeManifest(tempDir, manifest);
      const loaded = await readManifest(tempDir);

      // Verify complex nested structures survive serialization
      const mod = loaded!.modules[0]!;
      expect(mod.path).toBe("src/services");
      expect(mod.complexity).toBe("high");
      expect(mod.functionality.tests.unit).toEqual({
        expected: 12,
        current: 8,
        files: ["unit.test.ts"],
      });
      expect(mod.security.findings).toEqual(["injection:service.ts:42"]);
      expect(mod.stability.gaps).toEqual(["No timeout handling"]);
    });

    it("preserves journeys and contracts through round-trip", async () => {
      const manifest = createTestManifest();

      await writeManifest(tempDir, manifest);
      const loaded = await readManifest(tempDir);

      expect(loaded!.journeys).toHaveLength(1);
      expect(loaded!.journeys[0]!.steps).toEqual(["Open form", "Fill fields", "Submit", "Verify email"]);

      expect(loaded!.contracts).toHaveLength(1);
      expect(loaded!.contracts[0]!.method).toBe("POST");
      expect(loaded!.contracts[0]!.requestSchema).toBe("CreateUserDto");
    });

    it("preserves score history through round-trip", async () => {
      const manifest = createTestManifest();

      await writeManifest(tempDir, manifest);
      const loaded = await readManifest(tempDir);

      expect(loaded!.score.history).toHaveLength(2);
      expect(loaded!.score.history[0]!.scope).toBe("first-time");
      expect(loaded!.score.history[1]!.scope).toBe("re-analysis");
    });
  });

  describe("readManifest edge cases", () => {
    it("returns null for a directory with no coverit.json", async () => {
      const result = await readManifest(tempDir);
      expect(result).toBeNull();
    });

    it("returns null for a non-existent directory", async () => {
      const result = await readManifest("/tmp/definitely-does-not-exist-12345");
      expect(result).toBeNull();
    });
  });

  describe("manifest with empty collections", () => {
    it("handles manifest with no modules, journeys, or contracts", async () => {
      const manifest = createTestManifest({
        modules: [],
        journeys: [],
        contracts: [],
      });

      await writeManifest(tempDir, manifest);
      const loaded = await readManifest(tempDir);

      expect(loaded!.modules).toEqual([]);
      expect(loaded!.journeys).toEqual([]);
      expect(loaded!.contracts).toEqual([]);
    });
  });

  describe("manifest with special characters", () => {
    it("handles project names with special characters", async () => {
      const manifest = createTestManifest();
      manifest.project.name = "@scope/my-project";

      await writeManifest(tempDir, manifest);
      const loaded = await readManifest(tempDir);

      expect(loaded!.project.name).toBe("@scope/my-project");
    });
  });
});
