import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";

// Mock fs/promises
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  access: vi.fn(),
}));

// Mock fast-glob
vi.mock("fast-glob", () => ({
  default: vi.fn(),
}));

import { readFile, access } from "node:fs/promises";
import fg from "fast-glob";
import {
  detectFramework,
  detectTestFramework,
  detectPackageManager,
  detectProjectInfo,
  detectTestFrameworkForFile,
} from "../framework-detector.js";

const mockReadFile = vi.mocked(readFile);
const mockAccess = vi.mocked(access);
const mockFg = vi.mocked(fg);

function mockPackageJson(deps: Record<string, string> = {}, devDeps: Record<string, string> = {}, name = "test-project") {
  mockReadFile.mockImplementation(async (filePath: any) => {
    if (String(filePath).endsWith("package.json")) {
      return JSON.stringify({
        name,
        dependencies: deps,
        devDependencies: devDeps,
      });
    }
    throw new Error("ENOENT");
  });
}

describe("framework-detector (unit)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFg.mockResolvedValue([]);
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
  });

  describe("detectFramework", () => {
    it("should return 'unknown' when no package.json exists", async () => {
      const result = await detectFramework("/fake/project");
      expect(result).toBe("unknown");
    });

    it("should detect NestJS from @nestjs/core dependency", async () => {
      mockPackageJson({ "@nestjs/core": "^10.0.0" });
      const result = await detectFramework("/fake/project");
      expect(result).toBe("nestjs");
    });

    it("should detect Hono from hono dependency", async () => {
      mockPackageJson({ hono: "^4.0.0" });
      const result = await detectFramework("/fake/project");
      expect(result).toBe("hono");
    });

    it("should detect Express from express dependency", async () => {
      mockPackageJson({ express: "^4.18.0" });
      const result = await detectFramework("/fake/project");
      expect(result).toBe("express");
    });

    it("should detect React from react dependency", async () => {
      mockPackageJson({ react: "^18.0.0" });
      const result = await detectFramework("/fake/project");
      expect(result).toBe("react");
    });

    it("should return 'none' when package.json exists but no known framework", async () => {
      mockPackageJson({ lodash: "^4.0.0" });
      const result = await detectFramework("/fake/project");
      expect(result).toBe("none");
    });

    it("should prioritize NestJS over Express when both are present", async () => {
      mockPackageJson({ "@nestjs/core": "^10.0.0", express: "^4.18.0" });
      const result = await detectFramework("/fake/project");
      expect(result).toBe("nestjs");
    });

    it("should detect from devDependencies as well", async () => {
      mockPackageJson({}, { fastify: "^4.0.0" });
      const result = await detectFramework("/fake/project");
      expect(result).toBe("fastify");
    });
  });

  describe("detectTestFramework", () => {
    it("should return 'unknown' when no config files or package.json found", async () => {
      const result = await detectTestFramework("/fake/project");
      expect(result).toBe("unknown");
    });

    it("should detect vitest from config file", async () => {
      mockFg.mockImplementation(async (pattern: any) => {
        if (String(pattern).includes("vitest")) return ["vitest.config.ts"];
        return [];
      });
      const result = await detectTestFramework("/fake/project");
      expect(result).toBe("vitest");
    });

    it("should detect jest from config file", async () => {
      mockFg.mockImplementation(async (pattern: any) => {
        if (String(pattern).includes("jest")) return ["jest.config.js"];
        return [];
      });
      const result = await detectTestFramework("/fake/project");
      expect(result).toBe("jest");
    });

    it("should fall back to package.json deps when no config files", async () => {
      mockFg.mockResolvedValue([]);
      mockPackageJson({}, { vitest: "^1.0.0" });
      const result = await detectTestFramework("/fake/project");
      expect(result).toBe("vitest");
    });

    it("should detect jest from package.json deps as fallback", async () => {
      mockFg.mockResolvedValue([]);
      mockPackageJson({}, { jest: "^29.0.0" });
      const result = await detectTestFramework("/fake/project");
      expect(result).toBe("jest");
    });
  });

  describe("detectPackageManager", () => {
    it("should detect bun from bun.lockb", async () => {
      mockAccess.mockImplementation(async (filePath: any) => {
        if (String(filePath).endsWith("bun.lockb")) return undefined;
        throw new Error("ENOENT");
      });
      const result = await detectPackageManager("/fake/project");
      expect(result).toBe("bun");
    });

    it("should detect pnpm from pnpm-lock.yaml", async () => {
      mockAccess.mockImplementation(async (filePath: any) => {
        if (String(filePath).endsWith("pnpm-lock.yaml")) return undefined;
        throw new Error("ENOENT");
      });
      const result = await detectPackageManager("/fake/project");
      expect(result).toBe("pnpm");
    });

    it("should detect yarn from yarn.lock", async () => {
      mockAccess.mockImplementation(async (filePath: any) => {
        if (String(filePath).endsWith("yarn.lock")) return undefined;
        throw new Error("ENOENT");
      });
      const result = await detectPackageManager("/fake/project");
      expect(result).toBe("yarn");
    });

    it("should default to npm when no lock file found", async () => {
      const result = await detectPackageManager("/fake/project");
      expect(result).toBe("npm");
    });
  });
});
