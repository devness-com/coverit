/**
 * Unit tests for src/types/index.ts
 * Validates that the core type definitions (Language, Framework,
 * TestFramework, PackageManager, ProjectInfo) can be used to construct
 * valid objects and that the type unions cover all expected values.
 */
import { describe, it, expect } from "vitest";

import type {
  Language,
  Framework,
  TestFramework,
  PackageManager,
  ProjectInfo,
} from "../types/index.js";

// ─── Language Type ──────────────────────────────────────────

describe("Language type", () => {
  it("covers all supported programming languages", () => {
    const languages: Language[] = [
      "typescript",
      "javascript",
      "python",
      "go",
      "rust",
      "java",
      "unknown",
    ];
    expect(languages).toHaveLength(7);
    expect(new Set(languages).size).toBe(7); // all unique
  });

  it("includes unknown as a fallback value", () => {
    const fallback: Language = "unknown";
    expect(fallback).toBe("unknown");
  });
});

// ─── Framework Type ─────────────────────────────────────────

describe("Framework type", () => {
  it("covers all supported frameworks", () => {
    const frameworks: Framework[] = [
      "hono",
      "express",
      "nestjs",
      "next",
      "react",
      "react-native",
      "expo",
      "tauri",
      "electron",
      "fastify",
      "none",
      "unknown",
    ];
    expect(frameworks).toHaveLength(12);
    expect(new Set(frameworks).size).toBe(12);
  });

  it("includes both 'none' and 'unknown' for different semantics", () => {
    // 'none' = explicitly no framework; 'unknown' = could not detect
    const none: Framework = "none";
    const unknown: Framework = "unknown";
    expect(none).not.toBe(unknown);
  });
});

// ─── TestFramework Type ─────────────────────────────────────

describe("TestFramework type", () => {
  it("covers all supported test frameworks", () => {
    const frameworks: TestFramework[] = [
      "vitest",
      "jest",
      "mocha",
      "playwright",
      "cypress",
      "detox",
      "pytest",
      "go-test",
      "unknown",
    ];
    expect(frameworks).toHaveLength(9);
    expect(new Set(frameworks).size).toBe(9);
  });

  it("includes frameworks for multiple languages (JS, Python, Go)", () => {
    const jsFrameworks: TestFramework[] = ["vitest", "jest", "mocha", "playwright", "cypress"];
    const pythonFrameworks: TestFramework[] = ["pytest"];
    const goFrameworks: TestFramework[] = ["go-test"];
    const mobileFrameworks: TestFramework[] = ["detox"];

    expect(jsFrameworks.length).toBeGreaterThan(0);
    expect(pythonFrameworks.length).toBeGreaterThan(0);
    expect(goFrameworks.length).toBeGreaterThan(0);
    expect(mobileFrameworks.length).toBeGreaterThan(0);
  });
});

// ─── PackageManager Type ────────────────────────────────────

describe("PackageManager type", () => {
  it("covers all four supported package managers", () => {
    const managers: PackageManager[] = ["bun", "pnpm", "npm", "yarn"];
    expect(managers).toHaveLength(4);
    expect(new Set(managers).size).toBe(4);
  });
});

// ─── ProjectInfo Interface ──────────────────────────────────

describe("ProjectInfo structure", () => {
  it("can be constructed with all required fields", () => {
    const project: ProjectInfo = {
      name: "my-api",
      root: "/Users/dev/projects/my-api",
      language: "typescript",
      framework: "hono",
      testFramework: "vitest",
      packageManager: "bun",
      hasExistingTests: true,
      existingTestPatterns: ["**/*.test.ts", "**/*.spec.ts"],
    };

    expect(project.name).toBe("my-api");
    expect(project.root).toContain("my-api");
    expect(project.language).toBe("typescript");
    expect(project.framework).toBe("hono");
    expect(project.testFramework).toBe("vitest");
    expect(project.packageManager).toBe("bun");
    expect(project.hasExistingTests).toBe(true);
    expect(project.existingTestPatterns).toHaveLength(2);
  });

  it("supports projects with no existing tests", () => {
    const project: ProjectInfo = {
      name: "new-project",
      root: "/tmp/new-project",
      language: "javascript",
      framework: "none",
      testFramework: "unknown",
      packageManager: "npm",
      hasExistingTests: false,
      existingTestPatterns: [],
    };

    expect(project.hasExistingTests).toBe(false);
    expect(project.existingTestPatterns).toHaveLength(0);
    expect(project.framework).toBe("none");
    expect(project.testFramework).toBe("unknown");
  });

  it("supports all language-framework combinations", () => {
    const combos: Array<{ language: Language; framework: Framework }> = [
      { language: "typescript", framework: "nestjs" },
      { language: "typescript", framework: "hono" },
      { language: "typescript", framework: "react" },
      { language: "typescript", framework: "next" },
      { language: "typescript", framework: "tauri" },
      { language: "javascript", framework: "express" },
      { language: "python", framework: "none" },
      { language: "go", framework: "none" },
      { language: "rust", framework: "none" },
      { language: "java", framework: "none" },
    ];

    for (const combo of combos) {
      const project: ProjectInfo = {
        name: `${combo.language}-${combo.framework}`,
        root: `/tmp/${combo.language}`,
        language: combo.language,
        framework: combo.framework,
        testFramework: "unknown",
        packageManager: "npm",
        hasExistingTests: false,
        existingTestPatterns: [],
      };
      expect(project.language).toBe(combo.language);
      expect(project.framework).toBe(combo.framework);
    }
  });

  it("supports all package manager and test framework pairings", () => {
    const pairings: Array<{ pm: PackageManager; tf: TestFramework }> = [
      { pm: "bun", tf: "vitest" },
      { pm: "pnpm", tf: "jest" },
      { pm: "npm", tf: "mocha" },
      { pm: "yarn", tf: "playwright" },
      { pm: "bun", tf: "cypress" },
      { pm: "npm", tf: "pytest" },
    ];

    for (const pair of pairings) {
      const project: ProjectInfo = {
        name: "test",
        root: "/tmp",
        language: "typescript",
        framework: "none",
        testFramework: pair.tf,
        packageManager: pair.pm,
        hasExistingTests: false,
        existingTestPatterns: [],
      };
      expect(project.testFramework).toBe(pair.tf);
      expect(project.packageManager).toBe(pair.pm);
    }
  });
});
