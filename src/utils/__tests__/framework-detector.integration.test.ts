import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectFramework,
  detectTestFramework,
  detectTestFrameworkForFile,
  detectPackageManager,
  detectProjectInfo,
} from "../framework-detector.js";

describe("framework-detector (integration)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "coverit-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writePackageJson(
    deps: Record<string, string> = {},
    devDeps: Record<string, string> = {},
    name = "test-project",
    dir = tempDir,
  ) {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name,
        dependencies: deps,
        devDependencies: devDeps,
      }),
    );
  }

  describe("detectFramework with real filesystem", () => {
    it("should return 'unknown' for an empty directory", async () => {
      const result = await detectFramework(tempDir);
      expect(result).toBe("unknown");
    });

    it("should detect NestJS from a real package.json", async () => {
      await writePackageJson({ "@nestjs/core": "^10.0.0", express: "^4.18.0" });
      const result = await detectFramework(tempDir);
      expect(result).toBe("nestjs");
    });

    it("should detect Hono from a real package.json", async () => {
      await writePackageJson({ hono: "^4.0.0" });
      const result = await detectFramework(tempDir);
      expect(result).toBe("hono");
    });

    it("should return 'none' for a package.json with no known frameworks", async () => {
      await writePackageJson({ zod: "^3.0.0" });
      const result = await detectFramework(tempDir);
      expect(result).toBe("none");
    });
  });

  describe("detectTestFramework with real filesystem", () => {
    it("should detect vitest from a real vitest.config.ts file", async () => {
      await writeFile(
        join(tempDir, "vitest.config.ts"),
        'import { defineConfig } from "vitest/config";\nexport default defineConfig({});',
      );
      const result = await detectTestFramework(tempDir);
      expect(result).toBe("vitest");
    });

    it("should detect jest from a real jest.config.js file", async () => {
      await writeFile(
        join(tempDir, "jest.config.js"),
        "module.exports = {};",
      );
      const result = await detectTestFramework(tempDir);
      expect(result).toBe("jest");
    });

    it("should fall back to package.json deps when no config file present", async () => {
      await writePackageJson({}, { mocha: "^10.0.0" });
      const result = await detectTestFramework(tempDir);
      expect(result).toBe("mocha");
    });

    it("should return 'unknown' for an empty directory", async () => {
      const result = await detectTestFramework(tempDir);
      expect(result).toBe("unknown");
    });
  });

  describe("detectTestFrameworkForFile with real filesystem", () => {
    it("should detect vitest from config in the file's ancestor directory", async () => {
      // Create a nested directory structure
      const subDir = join(tempDir, "packages", "api", "src");
      await mkdir(subDir, { recursive: true });
      // Place vitest config in packages/api
      await writeFile(
        join(tempDir, "packages", "api", "vitest.config.ts"),
        'export default {};',
      );
      const result = await detectTestFrameworkForFile(
        tempDir,
        "packages/api/src/service.test.ts",
      );
      expect(result).toBe("vitest");
    });

    it("should detect jest from a package.json in a parent directory", async () => {
      const subDir = join(tempDir, "packages", "core", "src");
      await mkdir(subDir, { recursive: true });
      await writePackageJson({}, { jest: "^29.0.0" }, "core", join(tempDir, "packages", "core"));
      const result = await detectTestFrameworkForFile(
        tempDir,
        "packages/core/src/util.test.ts",
      );
      expect(result).toBe("jest");
    });

    it("should fall back to root-level detection when nothing found in ancestors", async () => {
      const subDir = join(tempDir, "deep", "nested", "dir");
      await mkdir(subDir, { recursive: true });
      // Put vitest config only at root
      await writeFile(
        join(tempDir, "vitest.config.ts"),
        'export default {};',
      );
      const result = await detectTestFrameworkForFile(
        tempDir,
        "deep/nested/dir/file.test.ts",
      );
      expect(result).toBe("vitest");
    });
  });

  describe("detectPackageManager with real filesystem", () => {
    it("should detect bun from bun.lockb file", async () => {
      await writeFile(join(tempDir, "bun.lockb"), "");
      const result = await detectPackageManager(tempDir);
      expect(result).toBe("bun");
    });

    it("should detect pnpm from pnpm-lock.yaml file", async () => {
      await writeFile(join(tempDir, "pnpm-lock.yaml"), "lockfileVersion: 9.0");
      const result = await detectPackageManager(tempDir);
      expect(result).toBe("pnpm");
    });

    it("should detect npm from package-lock.json file", async () => {
      await writeFile(join(tempDir, "package-lock.json"), "{}");
      const result = await detectPackageManager(tempDir);
      expect(result).toBe("npm");
    });

    it("should default to npm when no lock files exist", async () => {
      const result = await detectPackageManager(tempDir);
      expect(result).toBe("npm");
    });

    it("should prefer bun over npm when both lock files exist", async () => {
      await writeFile(join(tempDir, "bun.lockb"), "");
      await writeFile(join(tempDir, "package-lock.json"), "{}");
      const result = await detectPackageManager(tempDir);
      expect(result).toBe("bun");
    });
  });

  describe("detectProjectInfo with real filesystem", () => {
    it("should aggregate all detections into a ProjectInfo object", async () => {
      await writePackageJson(
        { "@nestjs/core": "^10.0.0" },
        { jest: "^29.0.0" },
        "my-api",
      );
      await writeFile(join(tempDir, "yarn.lock"), "");
      await writeFile(join(tempDir, "tsconfig.json"), "{}");

      const result = await detectProjectInfo(tempDir);
      expect(result).toEqual(
        expect.objectContaining({
          name: "my-api",
          root: tempDir,
          language: "typescript",
          framework: "nestjs",
          testFramework: "jest",
          packageManager: "yarn",
          hasExistingTests: false,
          existingTestPatterns: [],
        }),
      );
    });

    it("should detect existing test files and patterns", async () => {
      await writePackageJson({ react: "^18.0.0" }, { vitest: "^1.0.0" });
      await writeFile(join(tempDir, "tsconfig.json"), "{}");

      // Create test files in various patterns
      await mkdir(join(tempDir, "src", "__tests__"), { recursive: true });
      await writeFile(join(tempDir, "src", "app.test.ts"), "test('a', () => {})");
      await writeFile(
        join(tempDir, "src", "__tests__", "util.test.ts"),
        "test('b', () => {})",
      );

      const result = await detectProjectInfo(tempDir);
      expect(result.hasExistingTests).toBe(true);
      expect(result.existingTestPatterns).toContain("*.test.*");
      expect(result.existingTestPatterns).toContain("__tests__/");
    });

    it("should detect JavaScript language when tsconfig is absent", async () => {
      await writePackageJson({ express: "^4.18.0" });
      const result = await detectProjectInfo(tempDir);
      expect(result.language).toBe("javascript");
      expect(result.framework).toBe("express");
    });

    it("should return 'unknown' name when package.json has no name field", async () => {
      await writeFile(join(tempDir, "package.json"), JSON.stringify({ dependencies: { hono: "^4.0.0" } }));
      const result = await detectProjectInfo(tempDir);
      expect(result.name).toBe("unknown");
      expect(result.framework).toBe("hono");
    });
  });
});
