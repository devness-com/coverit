/**
 * Coverit Scale — Module Detector
 *
 * Discovers module boundaries from directory structure.
 * Each directory under src/ that contains source files is treated as a module.
 * Recursively aggregates nested directories into their parent module.
 *
 * This is a pure filesystem operation — no AI involved.
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import fg from "fast-glob";

// ─── Intermediate Types ──────────────────────────────────────

export interface RawModule {
  /** Directory path relative to project root (e.g., "src/services") */
  path: string;
  /** Source files in this module (relative to project root) */
  files: string[];
  /** Total lines of code across all source files */
  lines: number;
  /** Test files associated with this module (populated later by test-mapper) */
  testFiles: string[];
}

// ─── Constants ───────────────────────────────────────────────

const SOURCE_EXTENSIONS = ["ts", "tsx", "js", "jsx", "mjs", "mts"];

/** Directories that should never be treated as modules */
const IGNORED_DIRS = [
  "node_modules",
  "dist",
  "build",
  ".coverit",
  ".git",
  ".next",
  ".nuxt",
  "coverage",
  "__mocks__",
  "__fixtures__",
];

/** Glob patterns for test files — excluded from source file counts */
const TEST_FILE_PATTERNS = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*.e2e-spec.*",
  "**/*.integration.*",
  "**/__tests__/**",
];

/** Directories at the top level that are test-only (no source code) */
const TEST_ONLY_DIRS = new Set(["test", "tests", "e2e", "__tests__"]);

/** Config files that should not count as source (for root module filtering) */
const CONFIG_FILE_PATTERNS = [
  /^jest\.config\./,
  /^vitest\.config\./,
  /^tsconfig/,
  /^\.eslintrc/,
  /^eslint\.config\./,
  /^prettier\./,
  /^\.prettierrc/,
  /^webpack\.config\./,
  /^vite\.config\./,
  /^next\.config\./,
  /^nuxt\.config\./,
  /^tailwind\.config\./,
  /^postcss\.config\./,
  /^babel\.config\./,
  /^nest-cli\.json$/,
  /^ormconfig\./,
  /^docker-compose/,
  /^Dockerfile/,
];

// ─── Core Logic ──────────────────────────────────────────────

/**
 * Discovers all source modules in the project.
 *
 * Strategy: find all source files, group by their immediate module directory
 * (the first meaningful directory level), then compute line counts.
 */
export async function detectModules(
  projectRoot: string,
): Promise<RawModule[]> {
  const sourceGlobs = SOURCE_EXTENSIONS.map((ext) => `**/*.${ext}`);
  const ignorePatterns = [
    // Match at root and nested (e.g., apps/foo/node_modules)
    ...IGNORED_DIRS.flatMap((d) => [`${d}/**`, `**/${d}/**`]),
    ...TEST_FILE_PATTERNS,
  ];

  const allFiles = await fg(sourceGlobs, {
    cwd: projectRoot,
    ignore: ignorePatterns,
    dot: false,
  });

  if (allFiles.length === 0) return [];

  // Group files by their module directory
  const moduleMap = groupFilesByModule(allFiles, projectRoot);

  // Filter out test-only directories and config-only root modules
  for (const [modulePath, files] of moduleMap) {
    // Skip top-level test-only directories (e.g., "test", "tests", "e2e")
    const topDir = modulePath.split("/")[0]!;
    if (TEST_ONLY_DIRS.has(topDir)) {
      moduleMap.delete(modulePath);
      continue;
    }

    // For root module ("."), filter out config files
    if (modulePath === ".") {
      const nonConfigFiles = files.filter(
        (f) => !CONFIG_FILE_PATTERNS.some((p) => p.test(f)),
      );
      if (nonConfigFiles.length === 0) {
        moduleMap.delete(modulePath);
      } else {
        moduleMap.set(modulePath, nonConfigFiles);
      }
    }
  }

  // Compute line counts in parallel
  const modules = await Promise.all(
    Array.from(moduleMap.entries()).map(async ([modulePath, files]) => {
      const lines = await countLines(projectRoot, files);
      return {
        path: modulePath,
        files,
        lines,
        testFiles: [],
      } satisfies RawModule;
    }),
  );

  // Sort by path for deterministic output
  return modules.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Groups source files into module directories.
 *
 * Module detection heuristic: use the top-level directory inside src/
 * as the module boundary. Files directly in src/ get grouped into "src".
 * For projects without a src/ directory, use the top-level directory.
 *
 * Examples:
 *   src/services/booking.service.ts  → "src/services"
 *   src/controllers/booking.ctrl.ts  → "src/controllers"
 *   src/app.ts                       → "src"
 *   lib/utils/hash.ts                → "lib/utils"
 */
function groupFilesByModule(
  files: string[],
  _projectRoot: string,
): Map<string, string[]> {
  const modules = new Map<string, string[]>();

  for (const file of files) {
    const modulePath = resolveModulePath(file);
    const existing = modules.get(modulePath);
    if (existing) {
      existing.push(file);
    } else {
      modules.set(modulePath, [file]);
    }
  }

  return modules;
}

/**
 * Resolves a file path to its module directory.
 *
 * For files under src/, the module is determined by the second-level
 * directory (e.g., src/services). For deeper nesting, we still use the
 * second level to keep modules coarse-grained.
 *
 * Files at the root of src/ are grouped into "src".
 */
function resolveModulePath(filePath: string): string {
  const parts = filePath.split("/");
  const dir = dirname(filePath);

  // If file is at root level (e.g., "app.ts"), module is "."
  if (parts.length === 1) return ".";

  // If first directory is src/ (or similar entry points), use two levels
  const topDir = parts[0]!;
  const isSrcLike = ["src", "lib", "app", "packages"].includes(topDir);

  if (isSrcLike && parts.length === 2) {
    // File directly in src/ — module is "src"
    return topDir;
  }

  if (isSrcLike && parts.length >= 3) {
    // File in src/something/... — module is "src/something"
    return `${topDir}/${parts[1]}`;
  }

  // Non-src files: use the immediate parent directory
  // For deeply nested paths, cap at two levels
  if (parts.length <= 2) return dir;
  return `${parts[0]}/${parts[1]}`;
}

/**
 * Counts total lines across a list of files.
 * Reads files in parallel with a concurrency limit to avoid fd exhaustion.
 */
async function countLines(
  projectRoot: string,
  files: string[],
): Promise<number> {
  const BATCH_SIZE = 50;
  let total = 0;

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const counts = await Promise.all(
      batch.map(async (file) => {
        try {
          const content = await readFile(join(projectRoot, file), "utf-8");
          return content.split("\n").length;
        } catch {
          // File might be binary or unreadable — skip
          return 0;
        }
      }),
    );
    for (const count of counts) {
      total += count;
    }
  }

  return total;
}
