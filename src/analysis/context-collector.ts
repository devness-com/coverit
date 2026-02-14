/**
 * Coverit — Context Collector
 *
 * Replaces code-scanner.ts + dependency-graph.ts. No AST parsing.
 * Reads changed files from disk, finds nearby test files, and builds
 * a ContextBundle for the AI triage phase.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, dirname, basename, extname } from "node:path";
import { existsSync } from "node:fs";
import type {
  DiffResult,
  ProjectInfo,
  ContextBundle,
  FileContext,
  ExistingTestFile,
} from "../types/index.js";

const MAX_FILE_SIZE = 50 * 1024; // 50KB safety valve

/**
 * Collect context for AI triage: source code, nearby test files, diff summary.
 */
export async function collectContext(
  diffResult: DiffResult,
  projectRoot: string,
  project: ProjectInfo,
): Promise<ContextBundle> {
  const changedFiles: FileContext[] = [];
  const existingTestMap = new Map<string, ExistingTestFile>();

  for (const file of diffResult.files) {
    if (file.status === "deleted") continue;

    // Read full source code
    let sourceCode = "";
    try {
      const fullPath = join(projectRoot, file.path);
      const raw = await readFile(fullPath, "utf-8");
      // Safety valve: truncate large files to diff hunks + surrounding context
      if (raw.length > MAX_FILE_SIZE && file.hunks.length > 0) {
        sourceCode = truncateToHunks(raw, file.hunks);
      } else {
        sourceCode = raw;
      }
    } catch {
      // File unreadable — skip
      continue;
    }

    changedFiles.push({
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      sourceCode,
      hunks: file.hunks,
    });

    // Find nearby test files for this source file
    const nearbyTests = await findNearbyTestFiles(projectRoot, file.path);
    for (const testFile of nearbyTests) {
      if (existingTestMap.has(testFile.path)) continue;
      existingTestMap.set(testFile.path, testFile);
    }
  }

  // Build diff summary (lightweight metadata for triage)
  const diffSummary = buildDiffSummary(diffResult);

  return {
    changedFiles,
    existingTests: Array.from(existingTestMap.values()),
    project,
    diffSummary,
  };
}

/**
 * Find test files near a source file using common conventions.
 * Matches both exact patterns (foo.test.ts) and suffixed patterns (foo.admin.spec.ts).
 */
async function findNearbyTestFiles(
  projectRoot: string,
  sourcePath: string,
): Promise<ExistingTestFile[]> {
  const dir = dirname(sourcePath);
  const ext = extname(sourcePath);
  const name = basename(sourcePath, ext);
  const found: ExistingTestFile[] = [];
  const seen = new Set<string>();

  // Directories to scan for matching test files
  const dirsToScan = [
    dir,                                    // Colocated
    join(dir, "__tests__"),                  // __tests__ in same dir
    join(dirname(dir), "__tests__"),         // Parent __tests__
  ];

  // Match: name.test.ext, name.spec.ext, name.*.test.ext, name.*.spec.ext
  const testPattern = new RegExp(
    `^${escapeRegExp(name)}(?:\\.[\\w-]+)?\\.(test|spec)${escapeRegExp(ext)}$`,
  );

  for (const scanDir of dirsToScan) {
    const fullScanDir = join(projectRoot, scanDir);
    if (!existsSync(fullScanDir)) continue;

    let entries: string[];
    try {
      entries = await readdir(fullScanDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!testPattern.test(entry)) continue;
      const relPath = join(scanDir, entry);
      if (seen.has(relPath)) continue;
      seen.add(relPath);

      try {
        const content = await readFile(join(projectRoot, relPath), "utf-8");
        found.push({
          path: relPath,
          content,
          importsFrom: extractImports(content),
        });
      } catch {
        // Unreadable — skip
      }
    }
  }

  return found;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract import sources from test file content (best-effort regex).
 */
function extractImports(content: string): string[] {
  const imports: string[] = [];
  const importRegex = /(?:import|from)\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    if (match[1] && !match[1].startsWith("vitest") && !match[1].startsWith("@jest")) {
      imports.push(match[1]);
    }
  }
  return imports;
}

/**
 * Truncate a large file to diff hunks + surrounding context lines.
 */
function truncateToHunks(
  content: string,
  hunks: Array<{ startLine: number; endLine: number }>,
): string {
  const lines = content.split("\n");
  const CONTEXT_LINES = 100;
  const includedRanges: Array<[number, number]> = [];

  for (const hunk of hunks) {
    const start = Math.max(0, hunk.startLine - CONTEXT_LINES - 1);
    const end = Math.min(lines.length, hunk.endLine + CONTEXT_LINES);
    includedRanges.push([start, end]);
  }

  // Merge overlapping ranges
  includedRanges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of includedRanges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push([...range]);
    }
  }

  // Build truncated content
  const parts: string[] = [];
  for (const [start, end] of merged) {
    if (parts.length > 0) {
      parts.push(`\n// ... (lines ${merged[parts.length - 1]?.[1] ?? 0 + 1}-${start} omitted) ...\n`);
    }
    parts.push(lines.slice(start, end).join("\n"));
  }

  return parts.join("\n");
}

/**
 * Build a lightweight diff summary string for the triage prompt.
 */
function buildDiffSummary(diffResult: DiffResult): string {
  const lines: string[] = [
    `${diffResult.files.length} file(s) changed (${diffResult.baseBranch} → ${diffResult.headBranch})`,
    "",
  ];

  for (const file of diffResult.files) {
    const stats = file.status === "deleted"
      ? "deleted"
      : `+${file.additions}/-${file.deletions}`;
    lines.push(`  ${file.status.padEnd(8)} ${file.path} (${stats})`);
  }

  return lines.join("\n");
}
