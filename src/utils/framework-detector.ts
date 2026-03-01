/**
 * Coverit — Framework Detector
 *
 * Inspects package.json, lock files, and config files to determine
 * the project's framework, test runner, package manager, and
 * existing test infrastructure.
 */

import { readFile, access } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
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

  // Monorepo fallback: scan sub-packages for test frameworks
  const monoResult = await detectTestFrameworkFromSubPackages(projectRoot);
  if (monoResult !== "unknown") return monoResult;

  return "unknown";
}

/**
 * Scans monorepo sub-packages (packages/*, apps/*) for test frameworks.
 * Returns the most common test framework found across all sub-packages.
 */
async function detectTestFrameworkFromSubPackages(
  projectRoot: string,
): Promise<TestFramework> {
  // Find sub-package package.json files in common monorepo directories
  const subPkgFiles = await fg(
    [
      "packages/*/package.json",
      "apps/*/package.json",
    ],
    { cwd: projectRoot },
  );

  if (subPkgFiles.length === 0) return "unknown";

  const counts = new Map<TestFramework, number>();

  for (const pkgPath of subPkgFiles) {
    const subPkg = await readJson<PackageJson>(join(projectRoot, pkgPath));
    if (!subPkg) continue;

    const subDir = dirname(join(projectRoot, pkgPath));
    const allDeps = { ...subPkg.dependencies, ...subPkg.devDependencies };

    // Check for config files in the sub-package directory
    let found: TestFramework | null = null;
    const configChecks: [string, TestFramework][] = [
      ["vitest.config.*", "vitest"],
      ["jest.config.*", "jest"],
      ["playwright.config.*", "playwright"],
      ["cypress.config.*", "cypress"],
    ];

    for (const [pattern, fw] of configChecks) {
      const matches = await fg(pattern, { cwd: subDir, dot: true });
      if (matches.length > 0) {
        found = fw;
        break;
      }
    }

    // Fallback to dependency checks
    if (!found) {
      if ("vitest" in allDeps) found = "vitest";
      else if ("jest" in allDeps) found = "jest";
      else if ("@playwright/test" in allDeps) found = "playwright";
      else if ("cypress" in allDeps) found = "cypress";
      else if ("mocha" in allDeps) found = "mocha";
    }

    if (found) {
      counts.set(found, (counts.get(found) ?? 0) + 1);
    }
  }

  if (counts.size === 0) return "unknown";

  // Return the most common test framework
  let best: TestFramework = "unknown";
  let bestCount = 0;
  for (const [fw, count] of counts) {
    if (count > bestCount) {
      best = fw;
      bestCount = count;
    }
  }

  return best;
}

/**
 * Detects the test framework for a specific file by walking up from its
 * directory to the project root, checking each ancestor for config files
 * and package.json dependencies. Falls back to root-level detection.
 */
export async function detectTestFrameworkForFile(
  projectRoot: string,
  filePath: string,
): Promise<TestFramework> {
  const absRoot = resolve(projectRoot);
  let dir = dirname(resolve(projectRoot, filePath));

  // Walk up from the file's directory to the project root (inclusive)
  while (dir.length >= absRoot.length) {
    // Check config files (exact file checks, no glob)
    const configChecks: [string, TestFramework][] = [
      ["vitest.config.ts", "vitest"],
      ["vitest.config.js", "vitest"],
      ["vitest.config.mjs", "vitest"],
      ["vitest.config.mts", "vitest"],
      ["jest.config.ts", "jest"],
      ["jest.config.js", "jest"],
      ["jest.config.cjs", "jest"],
      ["jest.config.mjs", "jest"],
      ["jest.config.json", "jest"],
    ];

    for (const [filename, framework] of configChecks) {
      if (await fileExists(join(dir, filename))) return framework;
    }

    // Check package.json dependencies at this level
    const pkg = await readJson<PackageJson>(join(dir, "package.json"));
    if (pkg) {
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if ("vitest" in allDeps) return "vitest";
      if ("jest" in allDeps) return "jest";
      if ("@playwright/test" in allDeps) return "playwright";
      if ("cypress" in allDeps) return "cypress";
      if ("mocha" in allDeps) return "mocha";
    }

    // Move up one level
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  // Nothing found in any ancestor — fall back to root-level glob detection
  return detectTestFramework(projectRoot);
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
