import fg from "fast-glob";
import { resolve, dirname, relative } from "path";
import { readFile } from "fs/promises";
import type { DependencyGraph } from "../types/index.js";

/** Source file extensions we trace imports through. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** Glob patterns for discovering source files. */
const SOURCE_GLOBS = ["**/*.{ts,tsx,js,jsx,mjs,cjs}"];

/** Directories to exclude from scanning. */
const IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/__mocks__/**",
];

/**
 * Regex to match import/require statements and extract the module specifier.
 * Handles:
 *   import ... from "specifier"
 *   import "specifier"
 *   export ... from "specifier"
 *   require("specifier")
 *   dynamic import("specifier")
 */
const IMPORT_REGEX =
  /(?:import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|export\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']\s*\)|import\s*\(\s*["']([^"']+)["']\s*\))/g;

/**
 * Resolve a relative import specifier to an absolute file path.
 * Tries the specifier as-is, then with each source extension appended,
 * then as a directory index file.
 */
function resolveImport(
  specifier: string,
  importerDir: string,
  allFiles: Set<string>
): string | null {
  // Only resolve relative imports
  if (!specifier.startsWith(".")) return null;

  const basePath = resolve(importerDir, specifier);

  // Direct match (specifier already has extension)
  if (allFiles.has(basePath)) return basePath;

  // Try appending source extensions
  for (const ext of SOURCE_EXTENSIONS) {
    const withExt = basePath + ext;
    if (allFiles.has(withExt)) return withExt;
  }

  // Strip .js extension and try .ts/.tsx (common in ESM projects importing .js that are actually .ts)
  if (specifier.endsWith(".js")) {
    const stripped = basePath.slice(0, -3);
    for (const ext of [".ts", ".tsx"]) {
      const mapped = stripped + ext;
      if (allFiles.has(mapped)) return mapped;
    }
  }

  // Try as directory index
  for (const ext of SOURCE_EXTENSIONS) {
    const indexPath = resolve(basePath, `index${ext}`);
    if (allFiles.has(indexPath)) return indexPath;
  }

  return null;
}

/**
 * Extract import specifiers from file content using regex.
 * Faster than full AST parsing for dependency graph purposes.
 */
function extractImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  let match: RegExpExecArray | null;

  // Reset lastIndex for the global regex
  IMPORT_REGEX.lastIndex = 0;

  while ((match = IMPORT_REGEX.exec(content)) !== null) {
    // One of the capture groups will have the specifier
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (specifier) {
      specifiers.push(specifier);
    }
  }

  return specifiers;
}

/**
 * Build a dependency graph mapping each file to its direct dependencies and dependents.
 *
 * @param projectRoot - Absolute path to the project root
 * @param files - Optional subset of files to include. If omitted, all source files are discovered.
 */
export async function buildDependencyGraph(
  projectRoot: string,
  files?: string[]
): Promise<DependencyGraph> {
  const root = resolve(projectRoot);

  // Discover all source files for import resolution
  const allSourceFiles = await fg(SOURCE_GLOBS, {
    cwd: root,
    absolute: true,
    ignore: IGNORE_PATTERNS,
  });

  const allFilesSet = new Set(allSourceFiles);

  // Determine which files to analyze (all or a provided subset)
  const filesToAnalyze = files
    ? files.map((f) => resolve(root, f)).filter((f) => allFilesSet.has(f))
    : allSourceFiles;

  const graph: DependencyGraph = new Map();

  // Initialize nodes for all discovered files so dependedBy edges are complete
  for (const absPath of allSourceFiles) {
    const relPath = relative(root, absPath);
    if (!graph.has(relPath)) {
      graph.set(relPath, { file: relPath, dependsOn: [], dependedBy: [] });
    }
  }

  // Parse imports and build forward edges (dependsOn)
  const readPromises = filesToAnalyze.map(async (absPath) => {
    const relPath = relative(root, absPath);
    let node = graph.get(relPath);
    if (!node) {
      node = { file: relPath, dependsOn: [], dependedBy: [] };
      graph.set(relPath, node);
    }

    try {
      const content = await readFile(absPath, "utf-8");
      const specifiers = extractImportSpecifiers(content);
      const importerDir = dirname(absPath);

      for (const spec of specifiers) {
        const resolved = resolveImport(spec, importerDir, allFilesSet);
        if (!resolved) continue;

        const resolvedRel = relative(root, resolved);

        // Avoid self-references
        if (resolvedRel === relPath) continue;

        if (!node.dependsOn.includes(resolvedRel)) {
          node.dependsOn.push(resolvedRel);
        }
      }
    } catch {
      // File may have been deleted or be unreadable; skip silently
    }
  });

  await Promise.all(readPromises);

  // Build reverse edges (dependedBy) from forward edges
  for (const [filePath, node] of graph) {
    for (const dep of node.dependsOn) {
      const depNode = graph.get(dep);
      if (depNode && !depNode.dependedBy.includes(filePath)) {
        depNode.dependedBy.push(filePath);
      }
    }
  }

  return graph;
}
