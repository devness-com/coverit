/**
 * Git utilities for detecting changed files and mapping them to modules.
 *
 * Uses simple-git (already a dependency) for git operations.
 * Used by incremental scan modes: --changed, --branch, --pr.
 */

import { simpleGit } from "simple-git";
import { spawn } from "node:child_process";

/** Files that are never relevant for module scanning */
const IGNORE_PATTERNS =
  /\.(md|json|lock|yaml|yml|toml|txt|gitignore|prettierrc|eslintrc|editorconfig)$/i;
const IGNORE_DIRS = /^(node_modules|dist|\.git|\.coverit|\.next|coverage)\//;

/**
 * Detect the default branch name (main or master).
 */
export async function detectDefaultBranch(projectRoot: string): Promise<string> {
  const git = simpleGit(projectRoot);
  const branches = await git.branch();
  if (branches.all.includes("main")) return "main";
  if (branches.all.includes("master")) return "master";
  return "main"; // fallback
}

export type ScanScope = "changed" | "branch" | { pr: number };

/**
 * Get changed file paths relative to the project root.
 *
 * - "changed": uncommitted files (staged + unstaged)
 * - "branch": files changed in current branch vs default branch
 * - { pr: N }: files changed in GitHub PR #N (requires `gh` CLI)
 */
export async function getChangedFiles(
  scope: ScanScope,
  projectRoot: string,
): Promise<string[]> {
  if (scope === "changed") {
    return getUncommittedFiles(projectRoot);
  } else if (scope === "branch") {
    return getBranchFiles(projectRoot);
  } else {
    return getPrFiles(scope.pr, projectRoot);
  }
}

async function getUncommittedFiles(projectRoot: string): Promise<string[]> {
  const git = simpleGit(projectRoot);
  const [unstaged, staged] = await Promise.all([
    git.diff(["--name-only"]),
    git.diff(["--name-only", "--cached"]),
  ]);
  return dedup(parseFileList(unstaged).concat(parseFileList(staged)));
}

async function getBranchFiles(projectRoot: string): Promise<string[]> {
  const git = simpleGit(projectRoot);
  const defaultBranch = await detectDefaultBranch(projectRoot);

  // Check we're not on the default branch
  const current = await git.revparse(["--abbrev-ref", "HEAD"]);
  if (current.trim() === defaultBranch) {
    throw new Error(
      `Already on the default branch (${defaultBranch}). Use \`coverit scan\` for a full scan.`,
    );
  }

  const diff = await git.diff(["--name-only", `${defaultBranch}...HEAD`]);
  return dedup(parseFileList(diff));
}

async function getPrFiles(prNumber: number, projectRoot: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn("gh", ["pr", "diff", String(prNumber), "--name-only"], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        if (stderr.includes("not found") || stderr.includes("command not found")) {
          reject(
            new Error("GitHub CLI (gh) is required for --pr. Install: https://cli.github.com"),
          );
        } else {
          reject(new Error(`gh pr diff failed: ${stderr.trim()}`));
        }
        return;
      }
      resolve(dedup(parseFileList(stdout)));
    });

    proc.on("error", () => {
      reject(
        new Error("GitHub CLI (gh) is required for --pr. Install: https://cli.github.com"),
      );
    });
  });
}

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
