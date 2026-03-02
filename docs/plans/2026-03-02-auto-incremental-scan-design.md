# Auto-Incremental Scan Design

## Problem

`coverit scan` currently does a full codebase scan every time (~15-20 min, high token cost). Running `coverit scan` a second time repeats all the same work even if nothing changed. Users need a way to scan only what changed since the last scan — automatically, without extra flags.

## Solution

Store the git commit SHA in `coverit.json` after each scan. On subsequent `coverit scan` calls, auto-detect the delta since that commit and only re-analyze affected modules.

**Two modes only:**

```
coverit scan          # Smart: full first time, incremental after
coverit scan --full   # Force full rescan
```

## Why Not Explicit Flags?

The previous design had `--changed`, `--branch`, and `--pr` flags. These are all redundant with auto-incremental:

- `--changed` (uncommitted files) — commit first, then bare `coverit scan` picks it up
- `--branch` (diff vs main) — auto-incremental from `lastScanCommit` captures the same changes
- `--pr N` (PR diff) — checkout the branch locally, then bare `coverit scan` handles it

One command that does the right thing. One escape hatch (`--full`) for fresh rescans.

## Schema Change

Add `lastScanCommit` to `ManifestProject` in `coverit.json`:

```typescript
export interface ManifestProject {
  name: string;
  root: string;
  language: Language;
  framework: Framework;
  testFramework: TestFramework;
  sourceFiles: number;
  sourceLines: number;
  lastScanCommit?: string;  // NEW: git commit SHA at time of last scan
}
```

## Auto-Detection Flow

When `coverit scan` is called (no `--full` flag):

```
Has coverit.json?
  ├── No → Full scan → save HEAD as lastScanCommit
  └── Yes → Has lastScanCommit?
        ├── No → Full scan (legacy manifest) → save lastScanCommit
        └── Yes → git diff lastScanCommit...HEAD
              ├── No changes → "Nothing changed since last scan" (return existing)
              ├── Changes found → Incremental scan → update lastScanCommit
              └── Git error (hash gone, not a repo) → Full scan → update lastScanCommit
```

When `coverit scan --full` is called:
- Always does a full scan regardless of `lastScanCommit`
- Updates `lastScanCommit` to HEAD after completion

## Git Utility

New function in `src/utils/git.ts`:

```typescript
/**
 * Get files changed between a specific commit and HEAD.
 * Returns empty array if the commit hash is invalid or git fails.
 */
export async function getFilesSinceCommit(
  commitHash: string,
  projectRoot: string,
): Promise<string[]>;

/**
 * Get the current HEAD commit SHA.
 */
export async function getHeadCommit(
  projectRoot: string,
): Promise<string | null>;
```

## Incremental Scan Behavior

When auto-incremental is triggered:

1. **Get changed files** via `git diff --name-only <lastScanCommit>...HEAD`
2. **Map to modules** using existing `mapFilesToModules()` from `git.ts`
3. **AI re-analyzes** only affected modules (existing `buildIncrementalScalePrompt`)
4. **Merge results** into existing manifest (update affected, add new, remove deleted)
5. **Re-score** the full manifest
6. **Update `lastScanCommit`** to current HEAD

Dimensions default to functionality-only for incremental scans (existing behavior). User can add `--dimensions` for more.

## What Changes Where

| File | Change |
|------|--------|
| `src/schema/coverit-manifest.ts` | Add `lastScanCommit?: string` to `ManifestProject` |
| `src/utils/git.ts` | Add `getFilesSinceCommit()`, `getHeadCommit()`. Remove `ScanScope` type, `getChangedFiles()`, `getUncommittedFiles()`, `getBranchFiles()`, `getPrFiles()`, `detectDefaultBranch()` |
| `src/scale/analyzer.ts` | Replace `ScanScope`-based incremental path with auto-detect from `lastScanCommit`. Remove `scope` from `ScanOptions`. Add `--full` support. Save `lastScanCommit` after scan. |
| `src/cli/index.ts` | Remove `--changed`, `--branch`, `--pr` flags. Add `--full` flag. Print auto-incremental scope info. |
| `src/mcp/server.ts` | Remove `scope` parameter from `coverit_scan`. Add `full` boolean parameter. |
| `src/ai/scale-prompts.ts` | Keep `buildIncrementalScalePrompt` (still used by auto-incremental path) |

## CLI Output

```
# First time
coverit scan
  Scope: full scan (first time)
  ...

# Subsequent (changes detected)
coverit scan
  Scope: incremental (14 files changed since last scan)
  ...

# Subsequent (no changes)
coverit scan
  Nothing changed since last scan. Score: 72/100
  Run `coverit scan --full` to force a complete rescan.

# Force full
coverit scan --full
  Scope: full scan (forced)
  ...
```

## MCP Interface

```typescript
coverit_scan({
  projectRoot: "/path/to/project",
  // scope parameter REMOVED
  full: true,  // Optional: force full scan (default: false)
  dimensions: ["functionality", "security"],  // Optional
  timeoutSeconds: 900,  // Optional
})
```

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| No coverit.json | Full scan, save `lastScanCommit` |
| coverit.json exists, no `lastScanCommit` | Full scan (legacy upgrade), save `lastScanCommit` |
| `lastScanCommit` points to deleted/rebased commit | Git diff fails gracefully → full scan |
| Not a git repo | Full scan always (no commit tracking possible) |
| No changes since last scan | Early return with info message, no AI cost |
| Scan fails midway | Do NOT update `lastScanCommit` (retry will re-scan same delta) |
| `--full` flag | Ignore `lastScanCommit`, full scan, update it after |

## Decisions

- **Approach**: Git commit hash in coverit.json (single source of truth)
- **Explicit flags removed**: `--changed`, `--branch`, `--pr` all redundant with auto-incremental
- **Failure mode**: Invalid commit hash → graceful fallback to full scan (not error)
- **`lastScanCommit` only updated on success**: Failed scans don't advance the marker
- **Default dimensions for incremental**: Functionality only (fast), user adds `--dimensions` for more
