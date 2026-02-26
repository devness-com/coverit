/**
 * Coverit Scale — Test Mapper
 *
 * Finds existing test files and maps them to source modules.
 * Classifies each test by type (unit, integration, api, e2e, contract)
 * based on file naming conventions and content heuristics.
 *
 * This is a pure filesystem operation — no AI involved.
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import fg from "fast-glob";
import type { FunctionalTestType } from "../schema/coverit-manifest.js";
import type { RawModule } from "./module-detector.js";

// ─── Types ───────────────────────────────────────────────────

export interface TestMapping {
  /** Path to the test file, relative to project root */
  testFile: string;
  /** Module path this test maps to (e.g., "src/services") */
  modulePath: string;
  /** Classified test type */
  testType: FunctionalTestType;
  /** Approximate number of test cases (count of `it(` / `test(` calls) */
  testCount: number;
}

// ─── Constants ───────────────────────────────────────────────

const TEST_GLOBS = [
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
  "**/*.integration.test.ts",
  "**/*.integration.spec.ts",
  "**/*.api.test.ts",
  "**/*.api.spec.ts",
  "**/*.contract.test.ts",
  "**/*.contract.spec.ts",
  "**/__tests__/**/*.ts",
  "**/__tests__/**/*.tsx",
  "**/__tests__/**/*.js",
  "**/__tests__/**/*.jsx",
  "**/test/**/*.ts",
  "**/test/**/*.tsx",
  "**/tests/**/*.ts",
  "**/tests/**/*.tsx",
  "**/e2e/**/*.ts",
  "**/e2e/**/*.tsx",
];

const IGNORED_DIRS = [
  "node_modules/**",
  "dist/**",
  "build/**",
  ".coverit/**",
  ".git/**",
  "coverage/**",
];

// ─── File Name → Test Type Classification ────────────────────

/**
 * Patterns checked in order. First match wins.
 * More specific patterns are checked before generic ones.
 */
const FILE_NAME_PATTERNS: Array<{
  pattern: RegExp;
  type: FunctionalTestType;
}> = [
  { pattern: /\.e2e[-.]spec\./, type: "e2e" },
  { pattern: /\.e2e[-.]test\./, type: "e2e" },
  { pattern: /\.e2e\./, type: "e2e" },
  { pattern: /\.integration[-.]test\./, type: "integration" },
  { pattern: /\.integration[-.]spec\./, type: "integration" },
  { pattern: /\.integration\./, type: "integration" },
  { pattern: /\.api[-.]test\./, type: "api" },
  { pattern: /\.api[-.]spec\./, type: "api" },
  { pattern: /\.api\./, type: "api" },
  { pattern: /\.contract[-.]test\./, type: "contract" },
  { pattern: /\.contract[-.]spec\./, type: "contract" },
  { pattern: /\.contract\./, type: "contract" },
];

/**
 * Directory names that signal a specific test type.
 */
const DIR_TYPE_SIGNALS: Array<{
  dirPattern: RegExp;
  type: FunctionalTestType;
}> = [
  { dirPattern: /\/e2e\//, type: "e2e" },
  { dirPattern: /\/integration\//, type: "integration" },
  { dirPattern: /\/api[-_]tests?\//, type: "api" },
  { dirPattern: /\/contract[-_]tests?\//, type: "contract" },
];

// ─── Core Logic ──────────────────────────────────────────────

/**
 * Discovers all test files in the project and maps them to source modules.
 *
 * Mapping strategy:
 *  1. If a test file is colocated with source (same directory), map directly
 *  2. If in __tests__/, map to the parent directory
 *  3. If in test/ or tests/ at root, attempt to match by path similarity
 *  4. Fallback: map to the closest matching module by path
 */
export async function mapExistingTests(
  projectRoot: string,
  modules: RawModule[],
): Promise<TestMapping[]> {
  const testFiles = await fg(TEST_GLOBS, {
    cwd: projectRoot,
    ignore: IGNORED_DIRS,
    dot: false,
    unique: true,
  });

  if (testFiles.length === 0) return [];

  // Read test files in parallel to classify type and count tests
  const BATCH_SIZE = 50;
  const mappings: TestMapping[] = [];

  for (let i = 0; i < testFiles.length; i += BATCH_SIZE) {
    const batch = testFiles.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (testFile) => {
        const content = await safeReadFile(projectRoot, testFile);
        const testType = classifyTestType(testFile, content);
        const testCount = countTestCases(content);
        const modulePath = resolveModuleForTest(testFile, modules);
        return { testFile, modulePath, testType, testCount } satisfies TestMapping;
      }),
    );
    mappings.push(...batchResults);
  }

  return mappings;
}

/**
 * Classifies a test file's type from its name and content.
 *
 * Priority:
 *  1. File name patterns (most explicit signal)
 *  2. Directory name signals
 *  3. Content heuristics (supertest → api, playwright → e2e, etc.)
 *  4. Default: unit
 */
function classifyTestType(
  testFile: string,
  content: string,
): FunctionalTestType {
  // 1. File name patterns
  for (const { pattern, type } of FILE_NAME_PATTERNS) {
    if (pattern.test(testFile)) return type;
  }

  // 2. Directory signals
  const normalizedPath = `/${testFile}`;
  for (const { dirPattern, type } of DIR_TYPE_SIGNALS) {
    if (dirPattern.test(normalizedPath)) return type;
  }

  // 3. Content heuristics — check imports and function calls
  if (content) {
    if (hasContentSignal(content, ["supertest", "request(app)", "httpService"])) {
      return "api";
    }
    if (hasContentSignal(content, ["playwright", "page.goto", "browser.newPage"])) {
      return "e2e";
    }
    if (hasContentSignal(content, ["cypress"])) {
      return "e2e";
    }
    if (hasContentSignal(content, ["pactum", "contract", "schema validation"])) {
      return "contract";
    }
    // Integration signals: database/service layer testing
    if (
      hasContentSignal(content, [
        "createTestingModule",
        "TestingModule",
        "getRepository",
        "dataSource",
        "PrismaClient",
        "drizzle",
      ])
    ) {
      return "integration";
    }
  }

  // 4. Default
  return "unit";
}

/**
 * Checks if content contains any of the given signal strings.
 * Case-sensitive to avoid false positives.
 */
function hasContentSignal(content: string, signals: string[]): boolean {
  return signals.some((signal) => content.includes(signal));
}

/**
 * Counts approximate test cases in a file by matching `it(`, `test(`,
 * and `it.each(` / `test.each(` patterns.
 */
function countTestCases(content: string): number {
  if (!content) return 0;

  // Match standalone it(, test(, it.each(, test.each( calls
  // Negative lookbehind avoids matching "commit(" or "digit("
  const testPattern = /(?:^|[^.\w])(?:it|test)(?:\.each)?\s*\(/gm;
  const matches = content.match(testPattern);
  return matches?.length ?? 0;
}

/**
 * Resolves which module a test file belongs to.
 *
 * Uses a scoring heuristic:
 *  - Colocated tests (same dir as source) score highest
 *  - __tests__ in a module directory scores high
 *  - Path prefix overlap gives partial score
 *  - Falls back to closest module by directory depth
 */
function resolveModuleForTest(
  testFile: string,
  modules: RawModule[],
): string {
  if (modules.length === 0) return ".";

  const testDir = dirname(testFile);

  // Strip __tests__ from path for matching purposes
  const normalizedTestDir = testDir
    .replace(/__tests__\/?/, "")
    .replace(/\/tests?\/?/, "/")
    .replace(/\/e2e\/?/, "/")
    .replace(/\/$/, "");

  let bestMatch = modules[0]!.path;
  let bestScore = -1;

  for (const mod of modules) {
    const score = computeMatchScore(normalizedTestDir, testFile, mod);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = mod.path;
    }
  }

  return bestMatch;
}

/**
 * Scores how well a test file matches a module.
 * Higher score = better match.
 */
function computeMatchScore(
  normalizedTestDir: string,
  _testFile: string,
  mod: RawModule,
): number {
  let score = 0;

  // Exact directory match (colocated test)
  if (normalizedTestDir === mod.path) {
    score += 100;
  }

  // Test directory starts with module path
  if (normalizedTestDir.startsWith(mod.path)) {
    score += 50;
  }

  // Module path starts with test directory (test at higher level)
  if (mod.path.startsWith(normalizedTestDir)) {
    score += 30;
  }

  // Common path segments give partial credit
  const testParts = normalizedTestDir.split("/");
  const modParts = mod.path.split("/");
  let commonPrefix = 0;
  for (let i = 0; i < Math.min(testParts.length, modParts.length); i++) {
    if (testParts[i] === modParts[i]) {
      commonPrefix++;
    } else {
      break;
    }
  }
  score += commonPrefix * 10;

  return score;
}

async function safeReadFile(
  projectRoot: string,
  filePath: string,
): Promise<string> {
  try {
    return await readFile(join(projectRoot, filePath), "utf-8");
  } catch {
    return "";
  }
}
