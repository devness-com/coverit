/**
 * Coverit — Framework Detector
 *
 * Inspects package.json, lock files, and config files to determine
 * the project's framework, test runner, package manager, and
 * existing test infrastructure.
 */

import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import fg from "fast-glob";
import type {
  Framework,
  TestFramework,
  PackageManager,
  ProjectInfo,
  Language,
} from "../types/index.js";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * Detects the primary application framework from package.json dependencies.
 * Checks in specificity order — more specific frameworks first.
 */
export async function detectFramework(projectRoot: string): Promise<Framework> {
  const pkg = await readJson<PackageJson>(join(projectRoot, "package.json"));
  if (!pkg) return "unknown";

  const allDeps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  };

  // Order matters: check more specific frameworks before generic ones
  const frameworkMap: [string, Framework][] = [
    ["@nestjs/core", "nestjs"],
    ["hono", "hono"],
    ["fastify", "fastify"],
    ["express", "express"],
    ["next", "next"],
    ["expo", "expo"],
    ["react-native", "react-native"],
    ["@tauri-apps/api", "tauri"],
    ["electron", "electron"],
    ["react", "react"],
  ];

  for (const [dep, framework] of frameworkMap) {
    if (dep in allDeps) return framework;
  }

  return "none";
}

/**
 * Detects the test framework by looking for known config files,
 * then falling back to package.json dependencies.
 */
export async function detectTestFramework(
  projectRoot: string,
): Promise<TestFramework> {
  // Config-file detection is more reliable than dependency checks
  const configChecks: [string, TestFramework][] = [
    ["vitest.config.*", "vitest"],
    ["jest.config.*", "jest"],
    ["playwright.config.*", "playwright"],
    ["cypress.config.*", "cypress"],
    [".mocharc.*", "mocha"],
    ["pytest.ini", "pytest"],
    ["pyproject.toml", "pytest"],
  ];

  for (const [pattern, framework] of configChecks) {
    const matches = await fg(pattern, { cwd: projectRoot, dot: true });
    if (matches.length > 0) return framework;
  }

  // Fallback: check package.json deps
  const pkg = await readJson<PackageJson>(join(projectRoot, "package.json"));
  if (!pkg) return "unknown";

  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  if ("vitest" in allDeps) return "vitest";
  if ("jest" in allDeps) return "jest";
  if ("@playwright/test" in allDeps) return "playwright";
  if ("cypress" in allDeps) return "cypress";
  if ("mocha" in allDeps) return "mocha";

  return "unknown";
}

/**
 * Detects the package manager by checking for lock files.
 */
export async function detectPackageManager(
  projectRoot: string,
): Promise<PackageManager> {
  const lockChecks: [string, PackageManager][] = [
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ];

  for (const [file, pm] of lockChecks) {
    if (await fileExists(join(projectRoot, file))) return pm;
  }

  return "npm";
}

/**
 * Detects the primary language. For now, defaults to TypeScript for
 * projects with a tsconfig, JavaScript otherwise.
 */
async function detectLanguage(projectRoot: string): Promise<Language> {
  if (await fileExists(join(projectRoot, "tsconfig.json"))) return "typescript";
  if (await fileExists(join(projectRoot, "package.json"))) return "javascript";
  if (await fileExists(join(projectRoot, "go.mod"))) return "go";
  if (await fileExists(join(projectRoot, "Cargo.toml"))) return "rust";
  if (await fileExists(join(projectRoot, "pyproject.toml"))) return "python";
  if (await fileExists(join(projectRoot, "pom.xml"))) return "java";
  return "unknown";
}

/**
 * Aggregates all detection results into a single ProjectInfo object.
 * Also scans for existing test directories and patterns.
 */
export async function detectProjectInfo(
  projectRoot: string,
): Promise<ProjectInfo> {
  const [framework, testFramework, packageManager, language] =
    await Promise.all([
      detectFramework(projectRoot),
      detectTestFramework(projectRoot),
      detectPackageManager(projectRoot),
      detectLanguage(projectRoot),
    ]);

  const pkg = await readJson<PackageJson>(join(projectRoot, "package.json"));
  const name = pkg?.name ?? "unknown";

  // Scan for existing test files
  const testPatterns = [
    "**/*.test.ts",
    "**/*.spec.ts",
    "**/*.test.tsx",
    "**/*.spec.tsx",
    "**/*.test.js",
    "**/*.spec.js",
    "**/__tests__/**",
    "**/tests/**",
    "**/test/**",
  ];

  const existingTests = await fg(testPatterns, {
    cwd: projectRoot,
    ignore: ["node_modules/**", "dist/**", ".coverit/**"],
    dot: false,
  });

  // Deduce pattern types from what we found
  const existingTestPatterns: string[] = [];
  if (existingTests.some((f) => f.includes(".test.")))
    existingTestPatterns.push("*.test.*");
  if (existingTests.some((f) => f.includes(".spec.")))
    existingTestPatterns.push("*.spec.*");
  if (existingTests.some((f) => f.includes("__tests__")))
    existingTestPatterns.push("__tests__/");
  if (existingTests.some((f) => /^tests?\//.test(f)))
    existingTestPatterns.push("tests/");

  return {
    name,
    root: projectRoot,
    language,
    framework,
    testFramework,
    packageManager,
    hasExistingTests: existingTests.length > 0,
    existingTestPatterns,
  };
}
