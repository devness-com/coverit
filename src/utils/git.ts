/**
 * Git utilities for detecting changed files and mapping them to modules.
 *
 * Uses simple-git (already a dependency) for git operations.
 * Used by auto-incremental scan via lastScanCommit in coverit.json.
 */

import { simpleGit } from "simple-git";

/** Files that are never relevant for module scanning */
const IGNORE_PATTERNS =
  /\.(md|json|lock|yaml|yml|toml|txt|gitignore|prettierrc|eslintrc|editorconfig)$/i;
const IGNORE_DIRS = /^(node_modules|dist|\.git|\.coverit|\.next|coverage)\//;

function parseFileList(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function dedup(files: string[]): string[] {
  return [...new Set(files)];
}

/**
 * Get the current HEAD commit SHA.
 * Returns null if not in a git repo or git fails.
 */
export async function getHeadCommit(projectRoot: string): Promise<string | null> {
  try {
    const git = simpleGit(projectRoot);
    const sha = await git.revparse(["HEAD"]);
    return sha.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get files changed between a specific commit and HEAD.
 * Returns empty array if the commit hash is invalid or git fails.
 * Used by auto-incremental scan to detect delta since last scan.
 */
export async function getFilesSinceCommit(
  commitHash: string,
  projectRoot: string,
): Promise<string[]> {
  try {
    const git = simpleGit(projectRoot);
    const diff = await git.diff(["--name-only", `${commitHash}...HEAD`]);
    return dedup(parseFileList(diff));
  } catch {
    return [];
  }
}

/**
 * Map changed file paths to their parent modules from coverit.json.
 *
 * Returns the set of affected module paths and any files that couldn't
 * be mapped (potential new modules for the AI to discover).
 */
export function mapFilesToModules(
  changedFiles: string[],
  modulePaths: string[],
): { affectedModules: Set<string>; unmappedFiles: string[] } {
  const affectedModules = new Set<string>();
  const unmappedFiles: string[] = [];

  // Sort module paths longest-first for best prefix matching
  const sorted = [...modulePaths].sort((a, b) => b.length - a.length);

  for (const file of changedFiles) {
    // Skip non-source files
    if (IGNORE_PATTERNS.test(file) || IGNORE_DIRS.test(file)) continue;

    let matched = false;
    for (const modPath of sorted) {
      if (file.startsWith(modPath + "/") || file === modPath) {
        affectedModules.add(modPath);
        matched = true;
        break;
      }
    }

    if (!matched) {
      unmappedFiles.push(file);
    }
  }

  return { affectedModules, unmappedFiles };
}
