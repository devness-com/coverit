/**
 * Scope Detector — Determines the appropriate CoveritScope for a run
 *
 * Uses git state and environment variables to auto-detect what kind
 * of coverit run to perform. Explicit flags always take priority
 * over auto-detection.
 *
 * Detection order (first match wins):
 *   1. Explicit flags (--staged, --branch, --full, --rescale, --pr, --ci, files)
 *   2. No coverit.json exists -> "first-time"
 *   3. Staged changes -> "staged"
 *   4. Unstaged changes -> "unstaged"
 *   5. On a feature branch (not main/master) -> "branch"
 *   6. CI environment detected -> "ci"
 *   7. Otherwise -> "measure-only"
 */

import simpleGit from "simple-git";
import type { CoveritScope } from "../schema/coverit-manifest.js";
import { readManifest } from "../scale/writer.js";

// ─── Public Types ───────────────────────────────────────────

export interface ScopeOptions {
  /** Explicit --staged flag */
  staged?: boolean;
  /** Explicit --branch flag */
  branch?: boolean;
  /** Explicit --full flag */
  full?: boolean;
  /** Explicit --rescale flag */
  rescale?: boolean;
  /** Explicit --pr flag (number or true for auto-detect) */
  pr?: number | boolean;
  /** Explicit --ci flag */
  ci?: boolean;
  /** Explicit file patterns */
  files?: string[];
}

// ─── Main branches that indicate "not on a feature branch" ──

const MAIN_BRANCHES = new Set(["main", "master", "develop", "HEAD"]);

// ─── CI environment variable markers ────────────────────────

const CI_ENV_VARS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "JENKINS_URL",
  "BUILDKITE",
  "TRAVIS",
  "TF_BUILD",
  "BITBUCKET_PIPELINE_UUID",
];

// ─── Public API ─────────────────────────────────────────────

/**
 * Detect the appropriate scope for a coverit run.
 *
 * Explicit flags take absolute priority. When no flags are passed,
 * the function inspects git state and the environment to infer
 * the most useful scope automatically.
 */
export async function detectScope(
  projectRoot: string,
  options: ScopeOptions,
): Promise<CoveritScope> {
  // 1. Explicit flags — highest priority
  if (options.staged) return "staged";
  if (options.full) return "full";
  if (options.rescale) return "rescale";
  if (options.pr !== undefined && options.pr !== false) return "pr";
  if (options.ci) return "ci";
  if (options.files && options.files.length > 0) return "files";
  if (options.branch) return "branch";

  // 2. No coverit.json -> first-time setup
  const manifest = await readManifest(projectRoot);
  if (!manifest) return "first-time";

  // 3-5. Git state detection
  try {
    const g = simpleGit(projectRoot);

    // Check for staged changes
    const stagedDiff = await g.diff(["--cached", "--name-only"]);
    const stagedFiles = stagedDiff.trim().split("\n").filter(Boolean);
    if (stagedFiles.length > 0) return "staged";

    // Check for unstaged changes (modified tracked files)
    const status = await g.status();
    const hasUnstaged =
      status.modified.length > 0 ||
      status.deleted.length > 0 ||
      status.renamed.length > 0;
    if (hasUnstaged) return "unstaged";

    // Check if on a feature branch (not main/master/develop)
    const branchName = (await g.revparse(["--abbrev-ref", "HEAD"])).trim();
    if (!MAIN_BRANCHES.has(branchName)) return "branch";
  } catch {
    // Not a git repo or git failed — fall through to environment detection
  }

  // 6. CI environment detection
  if (isCI()) return "ci";

  // 7. Default: measure-only (no changes, no special context)
  return "measure-only";
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Check if the process is running in a CI environment by
 * probing well-known environment variables from major CI providers.
 */
function isCI(): boolean {
  return CI_ENV_VARS.some((envVar) => {
    const value = process.env[envVar];
    return value !== undefined && value !== "" && value !== "false";
  });
}
