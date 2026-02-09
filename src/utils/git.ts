/**
 * Coverit — Git Utilities
 *
 * Thin wrappers around simple-git for diffing, branch detection,
 * and changed-file enumeration used by the analysis pipeline.
 */

import simpleGit, { type SimpleGit } from "simple-git";

function git(projectRoot: string): SimpleGit {
  return simpleGit(projectRoot);
}

/**
 * Returns files changed between the current HEAD and the given base branch.
 * Falls back to detecting the base branch automatically.
 */
export async function getChangedFiles(
  projectRoot: string,
  baseBranch?: string,
): Promise<string[]> {
  const base = baseBranch ?? (await getBaseBranch(projectRoot));
  const g = git(projectRoot);
  const diff = await g.diff(["--name-only", `${base}...HEAD`]);
  return diff
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
}

/**
 * Returns the raw unified diff between HEAD and the base branch.
 */
export async function getDiff(
  projectRoot: string,
  baseBranch?: string,
): Promise<string> {
  const base = baseBranch ?? (await getBaseBranch(projectRoot));
  const g = git(projectRoot);
  return g.diff([`${base}...HEAD`]);
}

/**
 * Returns the name of the currently checked-out branch.
 */
export async function getCurrentBranch(projectRoot: string): Promise<string> {
  const g = git(projectRoot);
  const branch = await g.revparse(["--abbrev-ref", "HEAD"]);
  return branch.trim();
}

/**
 * Detects the base branch by checking for main, master, develop in order.
 * Returns the first one that exists as a local or remote ref.
 */
export async function getBaseBranch(projectRoot: string): Promise<string> {
  const g = git(projectRoot);
  const candidates = ["main", "master", "develop"];

  const branchSummary = await g.branch();
  const allBranches = new Set(branchSummary.all);

  for (const candidate of candidates) {
    if (
      allBranches.has(candidate) ||
      allBranches.has(`remotes/origin/${candidate}`)
    ) {
      return candidate;
    }
  }

  // Last resort: whatever the default remote HEAD points to
  return "main";
}

/**
 * Checks whether the given path is inside a git repository.
 */
export async function isGitRepo(path: string): Promise<boolean> {
  try {
    const g = git(path);
    await g.revparse(["--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns files currently staged in the index.
 */
export async function getStagedFiles(projectRoot: string): Promise<string[]> {
  const g = git(projectRoot);
  const diff = await g.diff(["--name-only", "--cached"]);
  return diff
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
}
