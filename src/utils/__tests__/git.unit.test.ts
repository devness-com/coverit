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

import { getChangedFiles, mapFilesToModules, detectDefaultBranch } from "../git.js";
import type { ModuleEntry } from "../../schema/coverit-manifest.js";

describe("detectDefaultBranch", () => {
  it("returns main when main exists", async () => {
    const { simpleGit } = await import("simple-git");
    const git = simpleGit() as any;
    git.branch.mockResolvedValue({ all: ["main", "develop"] });
    const result = await detectDefaultBranch("/project");
    expect(result).toBe("main");
  });

  it("falls back to master", async () => {
    const { simpleGit } = await import("simple-git");
    const git = simpleGit() as any;
    git.branch.mockResolvedValue({ all: ["master", "develop"] });
    const result = await detectDefaultBranch("/project");
    expect(result).toBe("master");
  });
});

describe("getChangedFiles", () => {
  it("returns uncommitted files for 'changed' mode", async () => {
    const { simpleGit } = await import("simple-git");
    const git = simpleGit() as any;
    git.diff
      .mockResolvedValueOnce("src/a.ts\nsrc/b.ts\n") // unstaged
      .mockResolvedValueOnce("src/c.ts\n"); // staged
    const files = await getChangedFiles("changed", "/project");
    expect(files).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("deduplicates files", async () => {
    const { simpleGit } = await import("simple-git");
    const git = simpleGit() as any;
    git.diff.mockResolvedValueOnce("src/a.ts\n").mockResolvedValueOnce("src/a.ts\n");
    const files = await getChangedFiles("changed", "/project");
    expect(files).toEqual(["src/a.ts"]);
  });
});

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
