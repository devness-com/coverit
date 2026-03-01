# Incremental Scan Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `--changed`, `--branch`, and `--pr` flags to `coverit scan` so users can incrementally scan only modules affected by recent changes instead of the entire codebase.

**Architecture:** Detect changed files via git (using `simple-git` already in deps), map them to existing coverit.json modules, then pass only affected modules to a scoped AI Functionality prompt. Merge results back into the full manifest.

**Tech Stack:** TypeScript, simple-git, Commander.js, Zod, Vitest

---

### Task 1: Create git utility (`src/utils/git.ts`)

**Files:**
- Create: `src/utils/git.ts`
- Test: `src/utils/__tests__/git.unit.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/utils/__tests__/git.unit.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// We'll mock simple-git
vi.mock("simple-git", () => {
  const mockGit = {
    diff: vi.fn(),
    revparse: vi.fn(),
    branch: vi.fn(),
  };
  return { default: vi.fn(() => mockGit), simpleGit: vi.fn(() => mockGit) };
});

import { getChangedFiles, mapFilesToModules, detectDefaultBranch } from "../git.js";
import type { ModuleEntry } from "../../schema/coverit-manifest.js";

describe("detectDefaultBranch", () => {
  it("returns main when main exists", async () => {
    const { simpleGit } = await import("simple-git");
    const git = simpleGit() as any;
    git.branch.mockResolvedValue({ all: ["main", "develop"] });
    const result = await detectDefaultBranch("/project");
    expect(result).toBe("main");
  });

  it("falls back to master", async () => {
    const { simpleGit } = await import("simple-git");
    const git = simpleGit() as any;
    git.branch.mockResolvedValue({ all: ["master", "develop"] });
    const result = await detectDefaultBranch("/project");
    expect(result).toBe("master");
  });
});

describe("getChangedFiles", () => {
  it("returns uncommitted files for 'changed' mode", async () => {
    const { simpleGit } = await import("simple-git");
    const git = simpleGit() as any;
    // diff returns newline-separated file paths
    git.diff
      .mockResolvedValueOnce("src/a.ts\nsrc/b.ts\n")  // unstaged
      .mockResolvedValueOnce("src/c.ts\n");             // staged
    const files = await getChangedFiles("changed", "/project");
    expect(files).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("deduplicates files", async () => {
    const { simpleGit } = await import("simple-git");
    const git = simpleGit() as any;
    git.diff
      .mockResolvedValueOnce("src/a.ts\n")
      .mockResolvedValueOnce("src/a.ts\n");
    const files = await getChangedFiles("changed", "/project");
    expect(files).toEqual(["src/a.ts"]);
  });
});

describe("mapFilesToModules", () => {
  const modules: Pick<ModuleEntry, "path">[] = [
    { path: "src/services" },
    { path: "src/utils" },
    { path: "packages/api" },
  ];

  it("maps files to their parent module", () => {
    const result = mapFilesToModules(
      ["src/services/auth.ts", "src/utils/logger.ts"],
      modules.map(m => m.path),
    );
    expect(result.affectedModules).toEqual(new Set(["src/services", "src/utils"]));
    expect(result.unmappedFiles).toEqual([]);
  });

  it("handles monorepo packages", () => {
    const result = mapFilesToModules(
      ["packages/api/src/users/user.service.ts"],
      modules.map(m => m.path),
    );
    expect(result.affectedModules).toEqual(new Set(["packages/api"]));
  });

  it("collects unmapped files", () => {
    const result = mapFilesToModules(
      ["src/unknown/foo.ts"],
      modules.map(m => m.path),
    );
    expect(result.affectedModules).toEqual(new Set());
    expect(result.unmappedFiles).toEqual(["src/unknown/foo.ts"]);
  });

  it("ignores non-source files", () => {
    const result = mapFilesToModules(
      ["README.md", ".gitignore", "package.json"],
      modules.map(m => m.path),
    );
    expect(result.affectedModules).toEqual(new Set());
    expect(result.unmappedFiles).toEqual([]);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/utils/__tests__/git.unit.test.ts`
Expected: FAIL — module `../git.js` not found

**Step 3: Write the implementation**

```typescript
// src/utils/git.ts
/**
 * Git utilities for detecting changed files and mapping them to modules.
 *
 * Uses simple-git (already a dependency) for git operations.
 * Used by incremental scan modes: --changed, --branch, --pr.
 */

import { simpleGit } from "simple-git";
import { spawn } from "node:child_process";

/** Files that are never relevant for module scanning */
const IGNORE_PATTERNS = /\.(md|json|lock|yaml|yml|toml|txt|gitignore|prettierrc|eslintrc|editorconfig)$/i;
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
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      if (code !== 0) {
        if (stderr.includes("not found") || stderr.includes("command not found")) {
          reject(new Error(
            "GitHub CLI (gh) is required for --pr. Install: https://cli.github.com",
          ));
        } else {
          reject(new Error(`gh pr diff failed: ${stderr.trim()}`));
        }
        return;
      }
      resolve(dedup(parseFileList(stdout)));
    });

    proc.on("error", () => {
      reject(new Error(
        "GitHub CLI (gh) is required for --pr. Install: https://cli.github.com",
      ));
    });
  });
}

function parseFileList(raw: string): string[] {
  return raw.split("\n").map(l => l.trim()).filter(l => l.length > 0);
}

function dedup(files: string[]): string[] {
  return [...new Set(files)];
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
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/utils/__tests__/git.unit.test.ts`
Expected: PASS

**Step 5: Type check**

Run: `npx tsc --noEmit`
Expected: Clean

**Step 6: Commit**

```bash
git add src/utils/git.ts src/utils/__tests__/git.unit.test.ts
git commit -m "feat: add git utilities for incremental scan (changed files, module mapping)"
```

---

### Task 2: Add scoped Functionality prompt (`src/ai/scale-prompts.ts`)

**Files:**
- Modify: `src/ai/scale-prompts.ts` — add `buildIncrementalScalePrompt()`

**Step 1: Write the failing test**

Add to `src/ai/__tests__/scale-prompts.unit.test.ts`:

```typescript
describe("buildIncrementalScalePrompt", () => {
  it("includes changed files and affected modules in prompt", () => {
    const { buildIncrementalScalePrompt } = require("../scale-prompts.js");
    const projectInfo = { name: "test", language: "typescript", framework: "none", testFramework: "vitest", packageManager: "bun" };
    const messages = buildIncrementalScalePrompt(
      projectInfo,
      ["src/services/auth.ts", "src/services/user.ts"],
      ["src/services"],
      ["src/new/unknown.ts"],
    );
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain("src/services/auth.ts");
    expect(messages[0].content).toContain("src/services");
    expect(messages[0].content).toContain("src/new/unknown.ts");
    expect(messages[0].content).toContain("ONLY these modules");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/ai/__tests__/scale-prompts.unit.test.ts -t "buildIncrementalScalePrompt"`
Expected: FAIL

**Step 3: Write the implementation**

Add to `src/ai/scale-prompts.ts`:

```typescript
/**
 * Build a scoped Functionality prompt for incremental scanning.
 *
 * Instead of "explore the entire codebase", this tells the AI to
 * re-analyze only the affected modules based on changed files.
 */
export function buildIncrementalScalePrompt(
  projectInfo: ProjectInfo,
  changedFiles: string[],
  affectedModulePaths: string[],
  unmappedFiles: string[],
): AIMessage[] {
  const system = `You are a senior QA architect performing an INCREMENTAL codebase analysis.

You have access to Glob, Grep, Read, and Bash tools. Use them to explore the affected modules.

## Your Task

The following files have been modified:
${changedFiles.map(f => `- ${f}`).join("\n")}

These belong to the following modules:
${affectedModulePaths.map(m => `- ${m}`).join("\n")}

${unmappedFiles.length > 0 ? `The following changed files don't belong to any known module — check if they represent a NEW module:\n${unmappedFiles.map(f => `- ${f}`).join("\n")}\n` : ""}

Re-analyze ONLY these modules. For each affected module, use your tools to explore its current state and produce an updated analysis.

## Project Info
- Name: ${projectInfo.name}
- Language: ${projectInfo.language}
- Framework: ${projectInfo.framework}
- Test framework: ${projectInfo.testFramework}

## Module Detection Rules

${MODULE_DETECTION_RULES}

## For Each Affected Module, Determine:

${PER_MODULE_INSTRUCTIONS}

## Output Format

Return a JSON object with this structure:
\`\`\`json
${JSON.stringify(OUTPUT_SCHEMA_EXAMPLE, null, 2)}
\`\`\`

IMPORTANT:
- Only return modules that were affected by the changes or newly discovered.
- Do NOT include modules that were not affected.
- If a module's directory no longer exists, include it with files: 0, lines: 0 to signal deletion.
- Use exact relative paths from the project root.`;

  const user = `Analyze the affected modules in this ${projectInfo.language} ${projectInfo.framework} project and return the JSON manifest. Start by reading the changed files, then explore each affected module's directory.`;

  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
}
```

Note: Extract `MODULE_DETECTION_RULES`, `PER_MODULE_INSTRUCTIONS`, and `OUTPUT_SCHEMA_EXAMPLE` as constants from the existing `buildScalePrompt` function to share between full and incremental prompts. This avoids duplication.

**Step 4: Run tests**

Run: `npx vitest run src/ai/__tests__/scale-prompts.unit.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/ai/scale-prompts.ts src/ai/__tests__/scale-prompts.unit.test.ts
git commit -m "feat: add incremental scale prompt for scoped module analysis"
```

---

### Task 3: Add `scope` to ScanOptions and wire up analyzer

**Files:**
- Modify: `src/scale/analyzer.ts` — add `scope` to `ScanOptions`, add incremental logic
- Test: `src/scale/__tests__/analyzer.integration.test.ts`

**Step 1: Add `scope` to ScanOptions**

In `src/scale/analyzer.ts`, update the interface:

```typescript
import type { ScanScope } from "../utils/git.js";

export interface ScanOptions {
  aiProvider?: AIProvider;
  onProgress?: (event: AIProgressEvent) => void;
  timeoutMs?: number;
  dimensions?: ScanDimension[];
  /** Incremental scan scope — only re-analyze modules affected by changes */
  scope?: ScanScope;
}
```

**Step 2: Add incremental logic in `scanCodebase()`**

Inside the `if (runFunctionality)` block, before calling `buildScalePrompt`, add:

```typescript
// If scope is set, detect changed files and filter to affected modules
if (opts.scope && existingManifest) {
  const { getChangedFiles, mapFilesToModules } = await import("../utils/git.js");
  const changedFiles = await getChangedFiles(opts.scope, projectRoot);

  if (changedFiles.length === 0) {
    logger.info("No changes detected. Nothing to scan.");
    // Return existing manifest as-is
    return existingManifest;
  }

  const modulePaths = existingManifest.modules.map(m => m.path);
  const { affectedModules, unmappedFiles } = mapFilesToModules(changedFiles, modulePaths);

  logger.debug(`Changed files: ${changedFiles.length}, affected modules: ${affectedModules.size}, unmapped: ${unmappedFiles.length}`);
  onProgress?.({ type: "phase", name: "Functionality", step: 1, total: dimCount });

  // Use incremental prompt instead of full prompt
  const { buildIncrementalScalePrompt } = await import("../ai/scale-prompts.js");
  const incMessages = buildIncrementalScalePrompt(
    projectInfo,
    changedFiles,
    [...affectedModules],
    unmappedFiles,
  );

  const response = await provider.generate(incMessages, {
    allowedTools: ALLOWED_TOOLS,
    cwd: projectRoot,
    timeoutMs,
    onProgress,
  });

  const incResult = parseScaleResponse(response.content);

  // Merge: start with existing modules, update affected ones
  const updatedMap = new Map(incResult.modules.map(m => [m.path, m]));
  modules = existingManifest.modules.map(existing => {
    const updated = updatedMap.get(existing.path);
    if (updated) {
      const entry = aiModuleToEntry(updated);
      // Preserve existing dimension data (security, stability, conformance)
      entry.security = existing.security;
      entry.stability = existing.stability;
      entry.conformance = existing.conformance;
      return entry;
    }
    return existing;
  });

  // Add newly discovered modules
  for (const [path, mod] of updatedMap) {
    if (!modules.some(m => m.path === path)) {
      modules.push(aiModuleToEntry(mod));
    }
  }

  // Remove modules flagged as deleted (files: 0)
  modules = modules.filter(m => m.files > 0);

  // Use existing totals (incremental scan doesn't recount whole project)
  totalSourceFiles = existingManifest.project.sourceFiles;
  totalSourceLines = existingManifest.project.sourceLines;
  scannedDates.functionality = now;

  // Preserve journeys/contracts from existing manifest
  aiResult = null; // Signal to use existing manifest's journeys/contracts

  scanLog.record({
    name: "Functionality",
    success: true,
    durationMs: Date.now() - funcStart,
    detail: `${affectedModules.size} modules updated (incremental)`,
  });
  onProgress?.({ type: "dimension_status", name: "Functionality", status: "done", detail: `${affectedModules.size} modules updated` });

  // Skip the regular full functionality scan below
} else {
  // ... existing full scan code ...
}
```

**Step 3: Write integration test**

Add to `src/scale/__tests__/analyzer.integration.test.ts`:

```typescript
describe("incremental scan", () => {
  it("passes scope to functionality scan", async () => {
    // Test that scope option is accepted and processed
    // (Mock git + AI to verify the flow)
  });
});
```

**Step 4: Run all tests**

Run: `npx vitest run`
Expected: All pass

**Step 5: Type check**

Run: `npx tsc --noEmit`
Expected: Clean

**Step 6: Commit**

```bash
git add src/scale/analyzer.ts src/scale/__tests__/analyzer.integration.test.ts
git commit -m "feat: wire incremental scan scope into analyzer"
```

---

### Task 4: Add CLI flags (`--changed`, `--branch`, `--pr`)

**Files:**
- Modify: `src/cli/index.ts` — add three new options to scan command

**Step 1: Update the scan command options**

```typescript
program
  .command("scan")
  .argument("[path]", "Project root path", ".")
  .option("--changed", "Only scan modules with uncommitted changes")
  .option("--branch", "Only scan modules changed in current branch vs main/master")
  .option("--pr <number>", "Only scan modules changed in a GitHub PR")
  .option("--dimensions <list>", "...")
  .option("--timeout <seconds>", "...")
  .action(async (pathArg: string, cmdOpts: {
    changed?: boolean;
    branch?: boolean;
    pr?: string;
    dimensions?: string;
    timeout?: string;
  }) => {
```

**Step 2: Parse scope and pass to scanCodebase**

Inside the action handler, before calling `scanCodebase`:

```typescript
// Parse incremental scope
let scope: ScanScope | undefined;
if (cmdOpts.changed) {
  scope = "changed";
  console.log(`  Scope: ${chalk.cyan("uncommitted changes")}\n`);
} else if (cmdOpts.branch) {
  scope = "branch";
  console.log(`  Scope: ${chalk.cyan("current branch")}\n`);
} else if (cmdOpts.pr) {
  scope = { pr: parseInt(cmdOpts.pr, 10) };
  console.log(`  Scope: ${chalk.cyan(`PR #${cmdOpts.pr}`)}\n`);
}

// Default to functionality-only for incremental scans
if (scope && !cmdOpts.dimensions) {
  dimensions = ["functionality"] as ScanDimension[];
  console.log(`  Dimensions: ${chalk.cyan("functionality")} (default for incremental)\n`);
}
```

Then pass `scope` to `scanCodebase`:

```typescript
const manifest = await scanCodebase(projectRoot, {
  aiProvider: provider,
  onProgress: lazySession.handler,
  timeoutMs,
  dimensions,
  scope,
});
```

**Step 3: Add import**

```typescript
import type { ScanScope } from "../utils/git.js";
```

**Step 4: Run full test suite + type check**

Run: `npx tsc --noEmit && npx vitest run`
Expected: All pass

**Step 5: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat: add --changed, --branch, --pr flags to scan command"
```

---

### Task 5: Add MCP `scope` parameter

**Files:**
- Modify: `src/mcp/server.ts` — add scope to coverit_scan tool

**Step 1: Update the zod schema**

```typescript
server.tool(
  "coverit_scan",
  "...",
  {
    projectRoot: z.string().describe("Absolute path to the project root"),
    scope: z
      .enum(["changed", "branch"])
      .or(z.string().regex(/^pr:\d+$/).describe("PR number as 'pr:123'"))
      .optional()
      .describe("Incremental scan scope: 'changed' (uncommitted), 'branch' (vs main), or 'pr:N' (GitHub PR). Omit for full scan."),
    dimensions: z.array(z.enum([...])).optional().describe("..."),
    timeoutSeconds: z.number().optional().describe("..."),
  },
  async ({ projectRoot, scope, dimensions, timeoutSeconds }) => {
    // Parse scope
    let scanScope: ScanScope | undefined;
    if (scope === "changed" || scope === "branch") {
      scanScope = scope;
    } else if (scope?.startsWith("pr:")) {
      scanScope = { pr: parseInt(scope.slice(3), 10) };
    }

    const manifest = await scanCodebase(projectRoot, {
      timeoutMs,
      dimensions,
      scope: scanScope,
    });
  },
);
```

**Step 2: Run MCP tests + full suite**

Run: `npx vitest run src/mcp/__tests__/`
Expected: All pass

**Step 3: Commit**

```bash
git add src/mcp/server.ts
git commit -m "feat: add scope parameter to coverit_scan MCP tool"
```

---

### Task 6: Export new types from public API

**Files:**
- Modify: `src/index.ts`

**Step 1: Add exports**

```typescript
export type { ScanScope } from "./utils/git.js";
export { getChangedFiles, mapFilesToModules } from "./utils/git.js";
```

**Step 2: Run all tests + type check**

Run: `npx tsc --noEmit && npx vitest run`
Expected: All 658+ tests pass

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: export incremental scan types from public API"
```

---

### Task 7: Verify CLI help and manual test

**Step 1: Check CLI help**

Run: `npx tsx src/cli/index.ts scan --help`
Expected output includes:
```
  --changed              Only scan modules with uncommitted changes
  --branch               Only scan modules changed in current branch vs main/master
  --pr <number>          Only scan modules changed in a GitHub PR
```

**Step 2: Verify error when no coverit.json**

Run: `cd /tmp && npx tsx /path/to/coverit/src/cli/index.ts scan --changed`
Expected: Error about missing coverit.json

**Step 3: Verify no-changes message**

Run in a clean git repo with coverit.json:
`npx tsx src/cli/index.ts scan --changed`
Expected: "No changes detected. Nothing to scan."

**Step 4: Final commit if any fixes needed**

```bash
git commit -m "fix: address issues found during manual testing"
```
