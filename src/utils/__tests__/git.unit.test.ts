import { describe, it, expect, vi, beforeEach } from "vitest";

// We'll mock simple-git
vi.mock("simple-git", () => {
  const mockGit = {
    diff: vi.fn(),
    revparse: vi.fn(),
    branch: vi.fn(),
  };
  return { default: vi.fn(() => mockGit), simpleGit: vi.fn(() => mockGit) };
});

import {
  mapFilesToModules,
  getHeadCommit,
  getFilesSinceCommit,
} from "../git.js";
import type { ModuleEntry } from "../../schema/coverit-manifest.js";

describe("mapFilesToModules", () => {
  const modules: Pick<ModuleEntry, "path">[] = [
    { path: "src/services" },
    { path: "src/utils" },
    { path: "packages/api" },
  ];

  it("maps files to their parent module", () => {
    const result = mapFilesToModules(
      ["src/services/auth.ts", "src/utils/logger.ts"],
      modules.map((m) => m.path),
    );
    expect(result.affectedModules).toEqual(new Set(["src/services", "src/utils"]));
    expect(result.unmappedFiles).toEqual([]);
  });

  it("handles monorepo packages", () => {
    const result = mapFilesToModules(
      ["packages/api/src/users/user.service.ts"],
      modules.map((m) => m.path),
    );
    expect(result.affectedModules).toEqual(new Set(["packages/api"]));
  });

  it("collects unmapped files", () => {
    const result = mapFilesToModules(
      ["src/unknown/foo.ts"],
      modules.map((m) => m.path),
    );
    expect(result.affectedModules).toEqual(new Set());
    expect(result.unmappedFiles).toEqual(["src/unknown/foo.ts"]);
  });

  it("ignores non-source files", () => {
    const result = mapFilesToModules(
      ["README.md", ".gitignore", "package.json"],
      modules.map((m) => m.path),
    );
    expect(result.affectedModules).toEqual(new Set());
    expect(result.unmappedFiles).toEqual([]);
  });
});

describe("getHeadCommit", () => {
  it("returns current HEAD SHA", async () => {
    const { simpleGit } = await import("simple-git");
    const git = simpleGit() as any;
    git.revparse.mockResolvedValue("abc123def456\n");
    const result = await getHeadCommit("/project");
    expect(result).toBe("abc123def456");
  });

  it("returns null on error", async () => {
    const { simpleGit } = await import("simple-git");
    const git = simpleGit() as any;
    git.revparse.mockRejectedValue(new Error("not a git repo"));
    const result = await getHeadCommit("/project");
    expect(result).toBeNull();
  });
});

describe("getFilesSinceCommit", () => {
  it("returns files changed since a specific commit", async () => {
    const { simpleGit } = await import("simple-git");
    const git = simpleGit() as any;
    git.diff.mockResolvedValue("src/a.ts\nsrc/b.ts\n");
    const files = await getFilesSinceCommit("abc123", "/project");
    expect(files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(git.diff).toHaveBeenCalledWith(["--name-only", "abc123...HEAD"]);
  });

  it("returns empty array on error (invalid hash)", async () => {
    const { simpleGit } = await import("simple-git");
    const git = simpleGit() as any;
    git.diff.mockRejectedValue(new Error("unknown revision"));
    const files = await getFilesSinceCommit("invalid", "/project");
    expect(files).toEqual([]);
  });

  it("deduplicates results", async () => {
    const { simpleGit } = await import("simple-git");
    const git = simpleGit() as any;
    git.diff.mockResolvedValue("src/a.ts\nsrc/a.ts\n");
    const files = await getFilesSinceCommit("abc123", "/project");
    expect(files).toEqual(["src/a.ts"]);
  });
});
