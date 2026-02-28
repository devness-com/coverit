/**
 * Unit tests for writer.ts
 * Tests readManifest and writeManifest with mocked filesystem.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { readFile, writeFile } from "node:fs/promises";
import { readManifest, writeManifest } from "../writer.js";
import type { CoveritManifest } from "../../schema/coverit-manifest.js";

// ─── Fixtures ────────────────────────────────────────────────

const sampleManifest: CoveritManifest = {
  version: 1,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-02T00:00:00.000Z",
  project: {
    name: "test-project",
    root: "/tmp/test-project",
    language: "typescript",
    framework: "nestjs",
    testFramework: "vitest",
    sourceFiles: 10,
    sourceLines: 1000,
  },
  dimensions: {
    functionality: {
      enabled: true,
      weight: 0.35,
      targets: {
        unit: { coverage: "critical-paths" },
        integration: { coverage: "all-boundaries" },
        api: { coverage: "all-endpoints" },
        e2e: { coverage: "critical-journeys" },
        contract: { coverage: "all-public-apis" },
      },
    },
    security: { enabled: true, weight: 0.25, checks: [] },
    stability: { enabled: true, weight: 0.15, checks: [] },
    conformance: { enabled: true, weight: 0.15, checks: [] },
    regression: { enabled: true, weight: 0.10, strategy: "all-existing-tests-pass" },
  },
  modules: [
    {
      path: "src/services",
      files: 5,
      lines: 500,
      complexity: "medium",
      functionality: {
        tests: {
          unit: { expected: 6, current: 2, files: ["test.ts"] },
        },
      },
      security: { issues: 0, resolved: 0, findings: [] },
      stability: { score: 80, gaps: [] },
      conformance: { score: 90, violations: [] },
    },
  ],
  journeys: [],
  contracts: [],
  score: {
    overall: 50,
    breakdown: { functionality: 50, security: 100, stability: 80, conformance: 90, regression: 100 },
    gaps: {
      total: 4,
      critical: 0,
      byDimension: {
        functionality: { missing: 4, priority: "medium" },
        security: { issues: 0, priority: "none" },
        stability: { gaps: 0, priority: "none" },
        conformance: { violations: 0, priority: "none" },
      },
    },
    history: [],
  },
};

// ─── readManifest ────────────────────────────────────────────

describe("readManifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns parsed manifest when file exists and is valid JSON", async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(sampleManifest));

    const result = await readManifest("/tmp/test-project");

    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(result!.project.name).toBe("test-project");
    expect(readFile).toHaveBeenCalledWith(
      "/tmp/test-project/coverit.json",
      "utf-8",
    );
  });

  it("returns null when file does not exist", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT: no such file"));

    const result = await readManifest("/tmp/nonexistent");

    expect(result).toBeNull();
  });

  it("returns null when file contains invalid JSON", async () => {
    vi.mocked(readFile).mockResolvedValue("not valid json {{{");

    const result = await readManifest("/tmp/test-project");

    expect(result).toBeNull();
  });
});

// ─── writeManifest ───────────────────────────────────────────

describe("writeManifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes formatted JSON with trailing newline", async () => {
    vi.mocked(writeFile).mockResolvedValue(undefined);

    await writeManifest("/tmp/test-project", sampleManifest);

    expect(writeFile).toHaveBeenCalledTimes(1);
    const [path, content, encoding] = vi.mocked(writeFile).mock.calls[0]!;
    expect(path).toBe("/tmp/test-project/coverit.json");
    expect(encoding).toBe("utf-8");

    // Verify it's formatted JSON with 2-space indentation ending in newline
    const written = content as string;
    expect(written).toMatch(/^\{/);
    expect(written).toMatch(/\n$/);
    expect(JSON.parse(written)).toEqual(sampleManifest);
    // Check 2-space indentation
    expect(written).toContain('  "version": 1');
  });

  it("writes to the correct file path using project root", async () => {
    vi.mocked(writeFile).mockResolvedValue(undefined);

    await writeManifest("/home/user/my-app", sampleManifest);

    expect(writeFile).toHaveBeenCalledWith(
      "/home/user/my-app/coverit.json",
      expect.any(String),
      "utf-8",
    );
  });

  it("propagates write errors to the caller", async () => {
    vi.mocked(writeFile).mockRejectedValue(new Error("EACCES: permission denied"));

    await expect(writeManifest("/readonly", sampleManifest)).rejects.toThrow(
      "EACCES: permission denied",
    );
  });
});
