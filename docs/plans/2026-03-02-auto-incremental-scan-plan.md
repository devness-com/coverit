# Auto-Incremental Scan Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `coverit scan` automatically incremental by storing the git commit SHA in coverit.json and only re-scanning changed modules on subsequent runs.

**Architecture:** Add `lastScanCommit` to the manifest schema. On scan, if coverit.json exists with a valid `lastScanCommit`, diff against HEAD to find changed files, map them to modules, and run an incremental AI scan. Remove the old explicit `--changed`/`--branch`/`--pr` flags and `ScanScope` type entirely. Add `--full` flag as escape hatch.

**Tech Stack:** TypeScript, simple-git, Vitest

---

### Task 1: Add `lastScanCommit` to Manifest Schema

**Files:**
- Modify: `src/schema/coverit-manifest.ts:42-52`
- Test: `src/schema/__tests__/coverit-manifest.unit.test.ts`

**Step 1: Write the failing test**

Add a test to `src/schema/__tests__/coverit-manifest.unit.test.ts` asserting that `ManifestProject` accepts `lastScanCommit`:

```typescript
it("ManifestProject accepts lastScanCommit field", () => {
  const project: ManifestProject = {
    name: "test",
    root: "/test",
    language: "typescript",
    framework: "none",
    testFramework: "vitest",
    sourceFiles: 10,
    sourceLines: 500,
    lastScanCommit: "abc123def456",
  };
  expect(project.lastScanCommit).toBe("abc123def456");
});

it("ManifestProject allows undefined lastScanCommit", () => {
  const project: ManifestProject = {
    name: "test",
    root: "/test",
    language: "typescript",
    framework: "none",
    testFramework: "vitest",
    sourceFiles: 10,
    sourceLines: 500,
  };
  expect(project.lastScanCommit).toBeUndefined();
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/apple/Code/devness/coverit && bun run test -- --run src/schema/__tests__/coverit-manifest.unit.test.ts`
Expected: FAIL — `lastScanCommit` does not exist on type `ManifestProject`

**Step 3: Add `lastScanCommit` to schema**

In `src/schema/coverit-manifest.ts:42-52`, add the field:

```typescript
export interface ManifestProject {
  name: string;
  root: string;
  language: Language;
  framework: Framework;
  testFramework: TestFramework;
  /** Total source files (excluding tests, configs, etc.) */
  sourceFiles: number;
  /** Total lines of source code */
  sourceLines: number;
  /** Git commit SHA at time of last successful scan (for auto-incremental) */
  lastScanCommit?: string;
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/apple/Code/devness/coverit && bun run test -- --run src/schema/__tests__/coverit-manifest.unit.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/schema/coverit-manifest.ts src/schema/__tests__/coverit-manifest.unit.test.ts
git commit -m "feat: add lastScanCommit to ManifestProject schema"
```

---

### Task 2: Add Git Utilities (`getHeadCommit`, `getFilesSinceCommit`)

**Files:**
- Modify: `src/utils/git.ts`
- Test: `src/utils/__tests__/git.unit.test.ts`

**Step 1: Write failing tests**

Add to `src/utils/__tests__/git.unit.test.ts`:

```typescript
import { getHeadCommit, getFilesSinceCommit } from "../git.js";

describe("getHeadCommit", () => {
  it("returns current HEAD SHA", async () => {
    const { simpleGit } = await import("simple-git");
    const git = simpleGit() as any;
    git.revparse.mockResolvedValue("abc123def456\n");
    const result = await getHeadCommit("/project");
    expect(result).toBe("abc123def456");
  });

  it("returns null on error", async () => {
    const { simpleGit } = await import("simple-git");
    const git = simpleGit() as any;
    git.revparse.mockRejectedValue(new Error("not a git repo"));
    const result = await getHeadCommit("/project");
    expect(result).toBeNull();
  });
});

describe("getFilesSinceCommit", () => {
  it("returns files changed since a specific commit", async () => {
    const { simpleGit } = await import("simple-git");
    const git = simpleGit() as any;
    git.diff.mockResolvedValue("src/a.ts\nsrc/b.ts\n");
    const files = await getFilesSinceCommit("abc123", "/project");
    expect(files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(git.diff).toHaveBeenCalledWith(["--name-only", "abc123...HEAD"]);
  });

  it("returns empty array on error (invalid hash)", async () => {
    const { simpleGit } = await import("simple-git");
    const git = simpleGit() as any;
    git.diff.mockRejectedValue(new Error("unknown revision"));
    const files = await getFilesSinceCommit("invalid", "/project");
    expect(files).toEqual([]);
  });

  it("deduplicates results", async () => {
    const { simpleGit } = await import("simple-git");
    const git = simpleGit() as any;
    git.diff.mockResolvedValue("src/a.ts\nsrc/a.ts\n");
    const files = await getFilesSinceCommit("abc123", "/project");
    expect(files).toEqual(["src/a.ts"]);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/apple/Code/devness/coverit && bun run test -- --run src/utils/__tests__/git.unit.test.ts`
Expected: FAIL — `getHeadCommit` and `getFilesSinceCommit` not exported

**Step 3: Implement the functions**

Add to `src/utils/git.ts`:

```typescript
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
```

**Step 4: Run tests to verify they pass**

Run: `cd /Users/apple/Code/devness/coverit && bun run test -- --run src/utils/__tests__/git.unit.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/utils/git.ts src/utils/__tests__/git.unit.test.ts
git commit -m "feat: add getHeadCommit and getFilesSinceCommit git utilities"
```

---

### Task 3: Remove Old Scope Infrastructure

**Files:**
- Modify: `src/utils/git.ts` — remove `ScanScope`, `getChangedFiles`, `getUncommittedFiles`, `getBranchFiles`, `getPrFiles`, `detectDefaultBranch`
- Modify: `src/scale/analyzer.ts` — remove `scope` from `ScanOptions`, remove old `ScanScope` import
- Modify: `src/cli/index.ts` — remove `--changed`, `--branch`, `--pr` flags and scope parsing
- Modify: `src/mcp/server.ts` — remove `scope` parameter from `coverit_scan`
- Test: `src/utils/__tests__/git.unit.test.ts` — remove `detectDefaultBranch` and `getChangedFiles` tests

**Step 1: Remove old exports from `src/utils/git.ts`**

Delete the following functions and types:
- `ScanScope` type (line 27)
- `detectDefaultBranch` function (lines 19-25)
- `getChangedFiles` function (lines 36-47)
- `getUncommittedFiles` function (lines 49-56)
- `getBranchFiles` function (lines 58-72)
- `getPrFiles` function (lines 74-110)

Also remove the `spawn` import from `node:child_process` (line 9) since it was only used by `getPrFiles`.

Keep: `getHeadCommit`, `getFilesSinceCommit`, `mapFilesToModules`, `IGNORE_PATTERNS`, `IGNORE_DIRS`, `parseFileList`, `dedup`.

**Step 2: Remove old tests from `src/utils/__tests__/git.unit.test.ts`**

Delete the `detectDefaultBranch` and `getChangedFiles` describe blocks.
Remove the `getChangedFiles` and `detectDefaultBranch` imports.

**Step 3: Remove `scope` from `ScanOptions` in `src/scale/analyzer.ts`**

In `ScanOptions` (line 78-93), remove:
```typescript
  /** Incremental scan scope — only re-analyze modules affected by changes */
  scope?: ScanScope;
```

Remove the `import type { ScanScope } from "../utils/git.js"` (line 52).

In `scanCodebase` (line 126+), remove `scope` from the destructured options (line 135, 152).

Do NOT remove the incremental scan path inside the functionality section (lines 214-284) — that code will be reused in Task 4 with the new auto-detect trigger.

**Step 4: Remove scope flags from CLI in `src/cli/index.ts`**

Remove lines 459-461 (the `--changed`, `--branch`, `--pr` options).
Remove `changed`, `branch`, `pr` from the `cmdOpts` type (lines 466-468).
Remove the scope parsing block (lines 490-512).
Remove `scope` from the `scanCodebase` call (line 528).
Remove `import type { ScanScope } from "../utils/git.js"` (line 32).

**Step 5: Remove `scope` parameter from MCP `coverit_scan` in `src/mcp/server.ts`**

Remove the `scope` zod schema (lines 46-50).
Remove `scope` from the destructured params (line 57).
Remove the `scanScope` parsing block (lines 63-68).
Remove `scope: scanScope` from the `scanCodebase` call (line 73).
Remove the `ScanScope` import (line 25).

**Step 6: Run all tests to verify nothing breaks**

Run: `cd /Users/apple/Code/devness/coverit && bun run test -- --run`
Expected: PASS (some tests may need minor import fixes)

**Step 7: Commit**

```bash
git add src/utils/git.ts src/utils/__tests__/git.unit.test.ts src/scale/analyzer.ts src/cli/index.ts src/mcp/server.ts
git commit -m "refactor: remove explicit scope flags (--changed, --branch, --pr) in favor of auto-incremental"
```

---

### Task 4: Implement Auto-Incremental Logic in Analyzer

**Files:**
- Modify: `src/scale/analyzer.ts`
- Test: `src/scale/__tests__/analyzer.unit.test.ts`

**Step 1: Write failing tests**

Add to `src/scale/__tests__/analyzer.unit.test.ts`:

```typescript
describe("auto-incremental scan", () => {
  it("does full scan when no coverit.json exists", async () => {
    // Mock readManifest returning null
    // Assert scanCodebase runs full functionality scan
    // Assert lastScanCommit is set in returned manifest
  });

  it("does incremental scan when lastScanCommit exists and files changed", async () => {
    // Mock readManifest returning manifest with lastScanCommit
    // Mock getFilesSinceCommit returning changed files
    // Assert only affected modules are re-scanned
    // Assert lastScanCommit is updated to HEAD
  });

  it("returns existing manifest when no files changed since lastScanCommit", async () => {
    // Mock readManifest returning manifest with lastScanCommit
    // Mock getFilesSinceCommit returning []
    // Mock getHeadCommit returning same as lastScanCommit
    // Assert existing manifest is returned without AI call
  });

  it("falls back to full scan when lastScanCommit is invalid", async () => {
    // Mock readManifest returning manifest with invalid lastScanCommit
    // Mock getFilesSinceCommit returning [] (error path)
    // Mock getHeadCommit returning new HEAD
    // Assert full scan runs
  });

  it("does full scan when forceFullScan is true", async () => {
    // Mock readManifest returning manifest with lastScanCommit
    // Assert full scan runs regardless
    // Assert lastScanCommit is updated
  });
});
```

These tests should mock the AI provider, `readManifest`, and git functions. Follow the existing test patterns in `src/scale/__tests__/analyzer.unit.test.ts`.

**Step 2: Run tests to verify they fail**

Run: `cd /Users/apple/Code/devness/coverit && bun run test -- --run src/scale/__tests__/analyzer.unit.test.ts`
Expected: FAIL

**Step 3: Implement auto-incremental in `scanCodebase`**

Add `forceFullScan` to `ScanOptions`:

```typescript
export interface ScanOptions {
  aiProvider?: AIProvider;
  onProgress?: (event: AIProgressEvent) => void;
  timeoutMs?: number;
  dimensions?: ScanDimension[];
  /** Force a full scan even if lastScanCommit exists (--full flag) */
  forceFullScan?: boolean;
}
```

In `scanCodebase`, after reading the existing manifest, add auto-detect logic:

```typescript
import { getHeadCommit, getFilesSinceCommit, mapFilesToModules } from "../utils/git.js";

// After Step 2 (read existing manifest):

// Step 2b: Auto-detect incremental scope from lastScanCommit
let autoIncremental = false;
let changedFiles: string[] = [];
let affectedModules = new Set<string>();
let unmappedFiles: string[] = [];

if (
  !forceFullScan &&
  existingManifest?.project.lastScanCommit &&
  runFunctionality
) {
  const headCommit = await getHeadCommit(projectRoot);
  if (headCommit && headCommit !== existingManifest.project.lastScanCommit) {
    changedFiles = await getFilesSinceCommit(
      existingManifest.project.lastScanCommit,
      projectRoot,
    );
    if (changedFiles.length > 0) {
      const modulePaths = existingManifest.modules.map(m => m.path);
      const mapping = mapFilesToModules(changedFiles, modulePaths);
      affectedModules = mapping.affectedModules;
      unmappedFiles = mapping.unmappedFiles;
      autoIncremental = true;
      logger.info(
        `Auto-incremental: ${changedFiles.length} files changed since last scan, ${affectedModules.size} modules affected`,
      );
    } else {
      // No changes — either hash is same or git diff returned nothing
      logger.info("Nothing changed since last scan.");
      onProgress?.({ type: "dimension_status", name: "Functionality", status: "done", detail: "no changes" });
      return existingManifest;
    }
  } else if (headCommit === existingManifest.project.lastScanCommit) {
    logger.info("Nothing changed since last scan.");
    return existingManifest;
  }
  // If headCommit is null (not a git repo) or getFilesSinceCommit returned []
  // with a different HEAD, fall through to full scan
}
```

Then in the functionality scan section, replace the old `scope && existingManifest` check with `autoIncremental && existingManifest`:

```typescript
if (autoIncremental && existingManifest) {
  // Use the already-computed changedFiles, affectedModules, unmappedFiles
  const { buildIncrementalScalePrompt } = await import("../ai/scale-prompts.js");
  // ... (existing incremental code, but using the auto-detected values)
}
```

After the manifest is assembled, set `lastScanCommit`:

```typescript
const headCommit = await getHeadCommit(projectRoot);
if (headCommit) {
  manifest.project.lastScanCommit = headCommit;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /Users/apple/Code/devness/coverit && bun run test -- --run src/scale/__tests__/analyzer.unit.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/scale/analyzer.ts src/scale/__tests__/analyzer.unit.test.ts
git commit -m "feat: auto-incremental scan using lastScanCommit from coverit.json"
```

---

### Task 5: Update CLI (`--full` flag, scope display)

**Files:**
- Modify: `src/cli/index.ts`
- Test: `src/cli/__tests__/cli.unit.test.ts`

**Step 1: Add `--full` flag to scan command**

Replace the removed `--changed`/`--branch`/`--pr` options with:

```typescript
.option("--full", "Force a full codebase scan (ignore incremental cache)")
```

Update `cmdOpts` type:

```typescript
cmdOpts: {
  full?: boolean;
  dimensions?: string;
  timeout?: string;
}
```

**Step 2: Pass `forceFullScan` to `scanCodebase`**

```typescript
const manifest = await scanCodebase(projectRoot, {
  aiProvider: provider,
  onProgress: lazySession.handler,
  timeoutMs,
  dimensions,
  forceFullScan: cmdOpts.full,
});
```

**Step 3: Add scope display in CLI output**

Before the spinner starts, read coverit.json and show what mode will be used:

```typescript
const existingManifest = await readManifest(projectRoot);
if (cmdOpts.full) {
  console.log(`  Scope: ${chalk.cyan("full scan (forced)")}\n`);
} else if (existingManifest?.project.lastScanCommit) {
  console.log(`  Scope: ${chalk.cyan("auto-incremental (since last scan)")}\n`);
} else {
  console.log(`  Scope: ${chalk.cyan("full scan (first time)")}\n`);
}
```

Import `readManifest` from `../scale/writer.js` (already imported).

**Step 4: Remove the old incremental dimensions default**

The old code defaulted to `functionality`-only for incremental scans. Keep this behavior for auto-incremental: if no `--dimensions` specified and auto-incremental is detected, default to functionality-only:

```typescript
if (!cmdOpts.full && !cmdOpts.dimensions && existingManifest?.project.lastScanCommit) {
  dimensions = ["functionality"] as ScanDimension[];
  console.log(`  Dimensions: ${chalk.cyan("functionality")} (default for incremental)\n`);
}
```

**Step 5: Run CLI tests**

Run: `cd /Users/apple/Code/devness/coverit && bun run test -- --run src/cli/__tests__/cli.unit.test.ts`
Expected: PASS (fix any import/type errors from removed flags)

**Step 6: Commit**

```bash
git add src/cli/index.ts src/cli/__tests__/cli.unit.test.ts
git commit -m "feat: add --full flag, remove --changed/--branch/--pr, show auto-incremental scope"
```

---

### Task 6: Update MCP Tool (remove `scope`, add `full`)

**Files:**
- Modify: `src/mcp/server.ts`
- Test: `src/mcp/__tests__/server.unit.test.ts`

**Step 1: Replace `scope` with `full` parameter**

In the `coverit_scan` tool definition, the `scope` parameter was removed in Task 3. Now add `full`:

```typescript
server.tool(
  "coverit_scan",
  "Scan and analyze the full codebase using AI and generate coverit.json quality manifest. AI explores the project with tool access to detect modules, map existing tests, classify complexity, identify journeys and contracts, and compute baseline scores.",
  {
    projectRoot: z.string().describe("Absolute path to the project root"),
    full: z.boolean().optional().describe("Force a full codebase scan, ignoring incremental cache (default: false)"),
    dimensions: z
      .array(z.enum(["functionality", "security", "stability", "conformance", "regression"]))
      .optional()
      .describe("Only scan specific dimensions (default: all 5). When functionality is omitted, modules are loaded from existing coverit.json."),
    timeoutSeconds: z.number().optional().describe("Timeout per dimension in seconds (default: 1200)"),
  },
  async ({ projectRoot, full, dimensions, timeoutSeconds }) => {
```

Pass `forceFullScan` to `scanCodebase`:

```typescript
const manifest = await scanCodebase(projectRoot, {
  timeoutMs,
  dimensions: dimensions as ScanDimension[] | undefined,
  forceFullScan: full,
});
```

**Step 2: Update MCP tests**

In `src/mcp/__tests__/server.unit.test.ts`, update any tests referencing the `scope` parameter to use `full` instead. Remove any test cases for `scope: "changed"`, `scope: "branch"`, `scope: "pr:42"`.

**Step 3: Run MCP tests**

Run: `cd /Users/apple/Code/devness/coverit && bun run test -- --run src/mcp/__tests__/server.unit.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/mcp/server.ts src/mcp/__tests__/server.unit.test.ts
git commit -m "feat: replace scope param with full boolean in coverit_scan MCP tool"
```

---

### Task 7: Update Skill File (scan.md)

**Files:**
- Check: `plugins/coverit/commands/scan.md` (if it references `--changed`/`--branch`/`--pr` or `scope`)

**Step 1: Read the skill file and update any references**

Remove mentions of `--changed`, `--branch`, `--pr`, and `scope` parameter.
Add mention of `--full` flag if relevant.
Update the MCP tool description if it mentions scope.

**Step 2: Commit**

```bash
git add plugins/coverit/commands/scan.md
git commit -m "docs: update scan skill to reflect auto-incremental and --full flag"
```

---

### Task 8: Run Full Test Suite and Typecheck

**Step 1: Run typecheck**

Run: `cd /Users/apple/Code/devness/coverit && bun run typecheck`
Expected: No type errors

**Step 2: Run full test suite**

Run: `cd /Users/apple/Code/devness/coverit && bun run test -- --run`
Expected: All tests pass

**Step 3: Fix any issues found, commit**

```bash
git commit -m "fix: resolve any remaining type/test issues from auto-incremental migration"
```

---

### Task 9: Clean Up Old Design Docs

**Files:**
- Delete: `docs/plans/2026-03-01-incremental-scan-design.md` (superseded)
- Delete: `docs/plans/2026-03-01-incremental-scan-plan.md` (superseded)

**Step 1: Remove old docs**

```bash
rm docs/plans/2026-03-01-incremental-scan-design.md docs/plans/2026-03-01-incremental-scan-plan.md
```

**Step 2: Commit**

```bash
git add -A docs/plans/
git commit -m "docs: remove superseded incremental scan design docs"
```
