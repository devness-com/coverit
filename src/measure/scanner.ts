/**
 * Test Scanner — Discovers existing test files and counts tests per module
 *
 * Walks the project filesystem for test files (*.test.ts, *.spec.ts, etc.),
 * counts individual test cases by matching `it(` and `test(` calls,
 * classifies each file by test type from its filename, and maps
 * each test file to the nearest module by path proximity.
 *
 * No AI involved — pure filesystem analysis.
 */

import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type {
  ModuleEntry,
  FunctionalTestType,
} from "../schema/coverit-manifest.js";

// ─── Public Types ───────────────────────────────────────────

export interface ModuleTestData {
  tests: Partial<
    Record<FunctionalTestType, { current: number; files: string[] }>
  >;
}

export interface ScanResult {
  totalTestFiles: number;
  totalTestCount: number;
  byModule: Map<string, ModuleTestData>;
}

// ─── Test File Discovery Patterns ───────────────────────────

const TEST_GLOB_PATTERNS = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test.js",
  "**/*.test.jsx",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/*.spec.js",
  "**/*.spec.jsx",
  "**/*.e2e-spec.ts",
  "**/*.e2e-spec.js",
  "**/__tests__/**/*.ts",
  "**/__tests__/**/*.tsx",
  "**/__tests__/**/*.js",
  "**/__tests__/**/*.jsx",
  "**/test/**/*.ts",
  "**/test/**/*.tsx",
  "**/test/**/*.js",
  "**/test/**/*.jsx",
];

const IGNORED_DIRS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.coverit/**",
  "**/coverage/**",
];

// ─── Public API ─────────────────────────────────────────────

/**
 * Scan the project for test files, count tests, and map them to modules.
 *
 * @param projectRoot - Absolute path to the project root
 * @param modules - Module entries from the manifest
 * @returns Aggregated test data per module
 */
export async function scanTests(
  projectRoot: string,
  modules: ModuleEntry[],
): Promise<ScanResult> {
  const testFiles = await discoverTestFiles(projectRoot);

  let totalTestFiles = 0;
  let totalTestCount = 0;
  const byModule = new Map<string, ModuleTestData>();

  // Pre-initialize every module in the map
  for (const mod of modules) {
    byModule.set(mod.path, { tests: {} });
  }

  for (const absolutePath of testFiles) {
    const relativePath = path.relative(projectRoot, absolutePath);
    const content = await fs.readFile(absolutePath, "utf-8");

    const testCount = countTests(content);
    if (testCount === 0) continue;

    const testType = classifyTestType(relativePath, content);
    const modulePath = findNearestModule(relativePath, modules);

    totalTestFiles++;
    totalTestCount += testCount;

    if (!modulePath) continue;

    let moduleData = byModule.get(modulePath);
    if (!moduleData) {
      moduleData = { tests: {} };
      byModule.set(modulePath, moduleData);
    }

    const existing = moduleData.tests[testType];
    if (existing) {
      existing.current += testCount;
      existing.files.push(relativePath);
    } else {
      moduleData.tests[testType] = {
        current: testCount,
        files: [relativePath],
      };
    }
  }

  return { totalTestFiles, totalTestCount, byModule };
}

// ─── Internal Helpers ───────────────────────────────────────

/**
 * Discover all test files in the project using glob patterns.
 * Returns absolute paths, deduplicated (since multiple patterns
 * can match the same file, e.g. `__tests__/foo.test.ts`).
 */
async function discoverTestFiles(projectRoot: string): Promise<string[]> {
  const results = await fg(TEST_GLOB_PATTERNS, {
    cwd: projectRoot,
    absolute: true,
    ignore: IGNORED_DIRS,
    onlyFiles: true,
  });

  // Deduplicate — multiple patterns can match the same file
  return [...new Set(results)];
}

/**
 * Count test cases in a file by matching `it(` and `test(` calls.
 * Ignores `describe(`, `beforeEach(`, etc.
 *
 * Uses a simple regex that matches the standard test runner patterns:
 *   it('description', ...)
 *   it("description", ...)
 *   it(`description`, ...)
 *   test('description', ...)
 *   test.each(...)('description', ...)
 *
 * Does NOT count commented-out tests (lines starting with // or *).
 */
function countTests(content: string): number {
  let count = 0;
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comments
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    // Match: it(', it(", it(`, test(', test(", test(`
    // Also matches it.each(...)(...) and test.each(...)(...)
    // Word boundary via (?:^|[^.\w]) prevents matching `imit(` or `retest(`
    const matches = trimmed.match(
      /(?:^|[^.\w])(?:it|test)\s*(?:\.(?:each|only|skip|todo)\s*(?:\([^)]*\)\s*)?)?\s*\(/g,
    );
    if (matches) {
      count += matches.length;
    }
  }

  return count;
}

/**
 * Classify the test type from the filename/path and content.
 *
 * Priority order (first match wins):
 *   1. File name patterns (most explicit signal)
 *   2. Directory name signals
 *   3. Content heuristics (supertest → api, playwright → e2e, etc.)
 *   4. Default: unit
 */
function classifyTestType(relativePath: string, content: string): FunctionalTestType {
  const lower = relativePath.toLowerCase();

  // 1. File name patterns
  if (lower.includes(".e2e") || lower.includes("/e2e/")) return "e2e";
  if (lower.includes(".integration") || lower.includes("/integration/"))
    return "integration";
  if (lower.includes(".api") || lower.includes("/api-tests/")) return "api";
  if (lower.includes(".contract") || lower.includes("/contracts/"))
    return "contract";

  // 2. Content heuristics — check imports and framework usage
  if (content) {
    if (hasContentSignal(content, ["supertest", "request(app)", "httpService"]))
      return "api";
    if (hasContentSignal(content, ["playwright", "page.goto", "browser.newPage", "cypress"]))
      return "e2e";
    if (hasContentSignal(content, ["pactum", "schema validation"]))
      return "contract";
    // Integration signals: database/service layer testing with DI
    if (hasContentSignal(content, [
      "createTestingModule",
      "TestingModule",
      "getRepository",
      "dataSource",
      "PrismaClient",
      "drizzle",
    ]))
      return "integration";
  }

  return "unit";
}

/**
 * Checks if content contains any of the given signal strings.
 */
function hasContentSignal(content: string, signals: string[]): boolean {
  return signals.some((signal) => content.includes(signal));
}

/**
 * Map a test file to the nearest module by path proximity.
 *
 * Strategy:
 *   1. Strip test-specific path segments (__tests__, test/, etc.)
 *   2. Find the module whose path is the longest prefix of the
 *      normalized test path (longest match = most specific module)
 *
 * Example:
 *   Test: src/services/__tests__/booking.test.ts
 *   Normalized: src/services/booking.test.ts
 *   Matches module: src/services (longest prefix)
 */
function findNearestModule(
  testRelativePath: string,
  modules: ModuleEntry[],
): string | null {
  // Normalize: strip __tests__/ and test/ segments
  const normalized = testRelativePath
    .replace(/__tests__\//g, "")
    .replace(/\/test\//g, "/");

  let bestMatch: string | null = null;
  let bestLength = 0;

  for (const mod of modules) {
    // Module path must be a prefix of the normalized test path
    const modPrefix = mod.path.endsWith("/") ? mod.path : `${mod.path}/`;

    if (normalized.startsWith(modPrefix) || normalized.startsWith(mod.path)) {
      if (mod.path.length > bestLength) {
        bestLength = mod.path.length;
        bestMatch = mod.path;
      }
    }
  }

  return bestMatch;
}
