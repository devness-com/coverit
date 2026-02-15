import simpleGit, { type DiffResultTextFile, type SimpleGit } from "simple-git";
import { resolve, extname } from "path";
import { readFile } from "node:fs/promises";
import { glob } from "glob";
import type {
  DiffResult,
  ChangedFile,
  DiffHunk,
  Language,
  FileType,
} from "../types/index.js";

const EXTENSION_TO_LANGUAGE: Record<string, Language> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
};

/**
 * Path-based rules evaluated in order. First match wins.
 * Each rule is [pattern, fileType] where pattern is a regex tested against the normalized posix path.
 */
const FILE_TYPE_RULES: Array<[RegExp, FileType]> = [
  // Tests first — they override everything
  [/\.(test|spec)\.[^/]+$/, "test"],

  // Platform-specific
  [/\/src-tauri\//, "desktop-window"],
  [/\/desktop\/.*components?\//, "desktop-component"],
  [/\/desktop\//, "desktop-window"],
  [/\/mobile\/.*screens?\//, "mobile-screen"],
  [/\/mobile\/.*components?\//, "mobile-component"],
  [/\/expo\/.*screens?\//, "mobile-screen"],
  [/\/expo\/.*components?\//, "mobile-component"],
  [/\/mobile\//, "mobile-screen"],
  [/\/expo\//, "mobile-screen"],

  // API layer
  [/\/routes?\//, "api-route"],
  [/\/api\//, "api-route"],
  [/\/controllers?\//, "api-controller"],
  [/\/middleware\//, "middleware"],

  // React patterns
  [/\/pages?\//, "react-page"],
  [/\/screens?\//, "react-page"],
  [/\/hooks?\//, "react-hook"],
  [/\/components?\//, "react-component"],

  // Backend patterns
  [/\/services?\//, "service"],
  [/\/utils?\//, "utility"],
  [/\/helpers?\//, "utility"],
  [/\/models?\//, "model"],
  [/\/entities\//, "model"],
  [/\/schemas?\//, "schema"],
  [/\/migrations?\//, "migration"],

  // Infrastructure / config files by extension
  [/\.(ya?ml|json|toml|ini|env)$/, "config"],
  [/docker-compose/, "config"],
  [/Dockerfile/, "config"],
  [/Makefile/, "config"],
  [/\.dockerignore/, "config"],

  // Config files
  [/\.(config|rc)\.[^/]+$/, "config"],
  [/\/config\//, "config"],

  // Style files
  [/\.(css|scss|sass|less|styl)$/, "style"],
];

function detectLanguage(filePath: string): Language {
  const ext = extname(filePath).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? "unknown";
}

function detectFileType(filePath: string): FileType {
  // Normalize to forward slashes for consistent matching
  const normalized = filePath.replace(/\\/g, "/");

  for (const [pattern, fileType] of FILE_TYPE_RULES) {
    if (pattern.test(normalized)) {
      return fileType;
    }
  }

  // TSX files with no other pattern match are likely React components
  if (normalized.endsWith(".tsx")) {
    return "react-component";
  }

  return "unknown";
}

/**
 * Parse unified diff hunks from raw diff text for a single file.
 */
function parseHunks(rawDiff: string, _filePath: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];

  // Find the section for this file and extract @@ hunk headers
  const hunkHeaderRegex = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/gm;
  let match: RegExpExecArray | null;

  while ((match = hunkHeaderRegex.exec(rawDiff)) !== null) {
    const startLine = parseInt(match[1]!, 10);
    const lineCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;
    const endLine = startLine + Math.max(lineCount - 1, 0);

    // Capture the hunk content (lines between this header and the next one)
    const headerEnd = match.index + match[0].length;
    const nextHunkIdx = rawDiff.indexOf("\n@@", headerEnd);
    const nextFileIdx = rawDiff.indexOf("\ndiff --git", headerEnd);

    let sliceEnd: number;
    if (nextHunkIdx === -1 && nextFileIdx === -1) {
      sliceEnd = rawDiff.length;
    } else if (nextHunkIdx === -1) {
      sliceEnd = nextFileIdx;
    } else if (nextFileIdx === -1) {
      sliceEnd = nextHunkIdx;
    } else {
      sliceEnd = Math.min(nextHunkIdx, nextFileIdx);
    }

    const content = rawDiff.slice(headerEnd, sliceEnd).trim();

    hunks.push({ startLine, endLine, content });
  }

  return hunks;
}

function mapDiffStatus(status: string): ChangedFile["status"] {
  switch (status) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
    case "R100":
      return "renamed";
    default:
      // Renames with similarity (R075 etc.) or copies
      if (status.startsWith("R")) return "renamed";
      return "modified";
  }
}

/**
 * Analyze git diff to identify changed files with metadata.
 *
 * @param projectRoot - Absolute path to the git repository root
 * @param baseBranch - Branch to diff against (defaults to HEAD for uncommitted changes)
 */
export async function analyzeDiff(
  projectRoot: string,
  baseBranch?: string
): Promise<DiffResult> {
  const root = resolve(projectRoot);
  const git: SimpleGit = simpleGit(root);

  // Verify this is a git repository
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    throw new Error(`Not a git repository: ${root}`);
  }

  const currentBranch =
    (await git.revparse(["--abbrev-ref", "HEAD"])).trim() || "HEAD";
  const base = baseBranch ?? currentBranch;

  let diffSummaryFiles: DiffResultTextFile[];
  let rawDiff: string;

  if (baseBranch) {
    // Diff between base branch and current HEAD
    const summary = await git.diffSummary([baseBranch]);
    diffSummaryFiles = summary.files as DiffResultTextFile[];
    rawDiff = await git.diff([baseBranch]);
  } else {
    // Combine staged + unstaged changes against HEAD
    const stagedSummary = await git.diffSummary(["--cached"]);
    const unstagedSummary = await git.diffSummary();

    // Merge results, preferring staged if both exist
    const fileMap = new Map<string, DiffResultTextFile>();
    for (const f of unstagedSummary.files as DiffResultTextFile[]) {
      fileMap.set(f.file, f);
    }
    for (const f of stagedSummary.files as DiffResultTextFile[]) {
      const existing = fileMap.get(f.file);
      if (existing) {
        // Combine additions/deletions from both staged and unstaged
        fileMap.set(f.file, {
          ...f,
          insertions: f.insertions + existing.insertions,
          deletions: f.deletions + existing.deletions,
          changes: f.changes + existing.changes,
        });
      } else {
        fileMap.set(f.file, f);
      }
    }

    diffSummaryFiles = Array.from(fileMap.values());

    // Get raw diff for hunk parsing
    const stagedRaw = await git.diff(["--cached"]);
    const unstagedRaw = await git.diff();
    rawDiff = stagedRaw + "\n" + unstagedRaw;
  }

  // Filter out binary files and non-source artifacts
  const sourceFiles = diffSummaryFiles.filter(
    (f) => !f.binary && !f.file.includes("node_modules/") && !f.file.includes("dist/")
  );

  const files: ChangedFile[] = sourceFiles.map((f) => {
    // simple-git provides status info in diffSummary via the status property on StatusResult,
    // but DiffResultTextFile does not carry it. We infer from insertions/deletions.
    let status: ChangedFile["status"] = "modified";
    if (f.deletions === 0 && f.insertions > 0) {
      status = "added";
    }

    return {
      path: f.file,
      status,
      additions: f.insertions,
      deletions: f.deletions,
      hunks: parseHunks(rawDiff, f.file),
      language: detectLanguage(f.file),
      fileType: detectFileType(f.file),
    };
  });

  // Augment with status from `git status` for more accurate added/deleted detection
  const statusResult = await git.status();
  const statusMap = new Map<string, string>();
  for (const f of statusResult.created) statusMap.set(f, "A");
  for (const f of statusResult.deleted) statusMap.set(f, "D");
  for (const f of statusResult.renamed) statusMap.set(f.to, "R");

  for (const file of files) {
    const st = statusMap.get(file.path);
    if (st) {
      file.status = mapDiffStatus(st);
    }
  }

  const addedCount = files.filter((f) => f.status === "added").length;
  const modifiedCount = files.filter((f) => f.status === "modified").length;
  const deletedCount = files.filter((f) => f.status === "deleted").length;

  const summary = [
    `${files.length} file(s) changed`,
    addedCount > 0 ? `${addedCount} added` : null,
    modifiedCount > 0 ? `${modifiedCount} modified` : null,
    deletedCount > 0 ? `${deletedCount} deleted` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return {
    files,
    summary,
    baseBranch: base,
    headBranch: currentBranch,
  };
}

/**
 * Build a DiffResult from raw git diff output and diff summary files.
 */
function buildDiffResult(
  diffSummaryFiles: DiffResultTextFile[],
  rawDiff: string,
  baseBranch: string,
  headBranch: string,
): DiffResult {
  const sourceFiles = diffSummaryFiles.filter(
    (f) => !f.binary && !f.file.includes("node_modules/") && !f.file.includes("dist/"),
  );

  const files: ChangedFile[] = sourceFiles.map((f) => {
    let status: ChangedFile["status"] = "modified";
    if (f.deletions === 0 && f.insertions > 0) status = "added";
    if (f.insertions === 0 && f.deletions > 0) status = "deleted";

    return {
      path: f.file,
      status,
      additions: f.insertions,
      deletions: f.deletions,
      hunks: parseHunks(rawDiff, f.file),
      language: detectLanguage(f.file),
      fileType: detectFileType(f.file),
    };
  });

  const addedCount = files.filter((f) => f.status === "added").length;
  const modifiedCount = files.filter((f) => f.status === "modified").length;
  const deletedCount = files.filter((f) => f.status === "deleted").length;

  const summary = [
    `${files.length} file(s) changed`,
    addedCount > 0 ? `${addedCount} added` : null,
    modifiedCount > 0 ? `${modifiedCount} modified` : null,
    deletedCount > 0 ? `${deletedCount} deleted` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return { files, summary, baseBranch, headBranch };
}

/**
 * Analyze diff for a specific commit or commit range.
 *
 * @param projectRoot - Absolute path to the git repository root
 * @param commitRef - A commit ref like "HEAD~1", "abc123", or a range "abc..def"
 */
export async function analyzeDiffForCommit(
  projectRoot: string,
  commitRef: string,
): Promise<DiffResult> {
  const root = resolve(projectRoot);
  const git: SimpleGit = simpleGit(root);

  const isRepo = await git.checkIsRepo();
  if (!isRepo) throw new Error(`Not a git repository: ${root}`);

  const currentBranch =
    (await git.revparse(["--abbrev-ref", "HEAD"])).trim() || "HEAD";

  // Determine if this is a range (contains "..")
  const isRange = commitRef.includes("..");
  const diffArgs = isRange ? [commitRef] : [`${commitRef}~1`, commitRef];

  const summary = await git.diffSummary(diffArgs);
  const rawDiff = await git.diff(diffArgs);

  return buildDiffResult(
    summary.files as DiffResultTextFile[],
    rawDiff,
    isRange ? commitRef.split("..")[0]! : `${commitRef}~1`,
    currentBranch,
  );
}

/**
 * Analyze only staged changes (index vs HEAD).
 *
 * @param projectRoot - Absolute path to the git repository root
 */
export async function analyzeDiffStaged(
  projectRoot: string,
): Promise<DiffResult> {
  const root = resolve(projectRoot);
  const git: SimpleGit = simpleGit(root);

  const isRepo = await git.checkIsRepo();
  if (!isRepo) throw new Error(`Not a git repository: ${root}`);

  const currentBranch =
    (await git.revparse(["--abbrev-ref", "HEAD"])).trim() || "HEAD";

  const summary = await git.diffSummary(["--cached"]);
  const rawDiff = await git.diff(["--cached"]);

  return buildDiffResult(
    summary.files as DiffResultTextFile[],
    rawDiff,
    "HEAD",
    currentBranch,
  );
}

/**
 * Analyze ALL source files in a project for a full coverage audit.
 * Ignores test files, config files, style files, and common non-source directories.
 *
 * @param projectRoot - Absolute path to the git repository root
 */
export async function analyzeDiffAll(
  projectRoot: string,
): Promise<DiffResult> {
  const root = resolve(projectRoot);

  // Build glob patterns from supported extensions
  const extensions = Object.keys(EXTENSION_TO_LANGUAGE).map((ext) => `**/*${ext}`);
  const ignorePatterns = [
    "node_modules/**", "dist/**", "build/**", ".coverit/**", ".next/**",
    "coverage/**", "**/*.d.ts", ".git/**", "vendor/**", "__pycache__/**",
  ];

  const matchedFiles: string[] = [];
  for (const pattern of extensions) {
    const matches = await glob(pattern, { cwd: root, nodir: true, ignore: ignorePatterns });
    matchedFiles.push(...matches);
  }

  // Deduplicate and filter out test files, config files, and style files
  const uniqueFiles = [...new Set(matchedFiles)].filter((filePath) => {
    const fileType = detectFileType(filePath);
    return fileType !== "test" && fileType !== "config" && fileType !== "style";
  });

  if (uniqueFiles.length === 0) {
    return {
      files: [],
      summary: "0 source file(s) in project (full scan)",
      baseBranch: "all",
      headBranch: "HEAD",
    };
  }

  // Build ChangedFile entries by reading file line counts
  const files: ChangedFile[] = [];
  for (const filePath of uniqueFiles) {
    try {
      const fullPath = resolve(root, filePath);
      const content = await readFile(fullPath, "utf-8");
      const lines = content.split("\n").length;

      files.push({
        path: filePath,
        status: "modified",
        additions: lines,
        deletions: 0,
        hunks: [],
        language: detectLanguage(filePath),
        fileType: detectFileType(filePath),
      });
    } catch {
      // File doesn't exist or can't be read — skip
    }
  }

  const summary = `${files.length} source file(s) in project (full scan)`;
  return { files, summary, baseBranch: "all", headBranch: "HEAD" };
}

/**
 * Analyze specific files by glob patterns, treating them as fully "modified".
 * The diff is computed against HEAD so hunks reflect working-tree state.
 *
 * @param projectRoot - Absolute path to the git repository root
 * @param patterns - Glob patterns relative to projectRoot (e.g. ["src/ai/**"])
 */
export async function analyzeDiffForFiles(
  projectRoot: string,
  patterns: string[],
): Promise<DiffResult> {
  const root = resolve(projectRoot);

  // Resolve globs to actual file paths
  const matchedFiles: string[] = [];
  for (const pattern of patterns) {
    const matches = await glob(pattern, { cwd: root, nodir: true });
    matchedFiles.push(...matches);
  }

  // Deduplicate
  const uniqueFiles = [...new Set(matchedFiles)];

  if (uniqueFiles.length === 0) {
    return {
      files: [],
      summary: "0 file(s) matched",
      baseBranch: "HEAD",
      headBranch: "HEAD",
    };
  }

  // Build ChangedFile entries by reading file stats
  const files: ChangedFile[] = [];
  for (const filePath of uniqueFiles) {
    try {
      const fullPath = resolve(root, filePath);
      const content = await readFile(fullPath, "utf-8");
      const lines = content.split("\n").length;

      files.push({
        path: filePath,
        status: "modified",
        additions: lines,
        deletions: 0,
        hunks: [{ startLine: 1, endLine: lines, content }],
        language: detectLanguage(filePath),
        fileType: detectFileType(filePath),
      });
    } catch {
      // File doesn't exist or can't be read — skip
    }
  }

  const summary = `${files.length} file(s) targeted`;
  return { files, summary, baseBranch: "HEAD", headBranch: "HEAD" };
}
