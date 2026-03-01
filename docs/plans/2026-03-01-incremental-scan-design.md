# Incremental Scan Design

## Problem

`coverit scan` currently scans the entire codebase every time (~15-20 min, high token cost). Day-to-day usage requires a fast incremental mode that only re-analyzes modules affected by recent changes.

## Solution

Three new CLI flags that detect changed files via git, map them to affected modules, and run a scoped AI Functionality scan on only those modules.

## CLI Interface

```
coverit scan                     # Full scan (existing behavior)
coverit scan --changed           # Modules with uncommitted changes (staged + unstaged)
coverit scan --branch            # Modules changed in current branch vs main/master
coverit scan --pr <number>       # Modules changed in a GitHub PR
```

All flags combine with existing `--dimensions` and `--timeout`. Default dimension for incremental modes: Functionality only.

## Architecture

### 1. Git Detection (`src/utils/git.ts`)

New utility with three modes:

| Flag | Git command | Returns |
|------|------------|---------|
| `--changed` | `git diff --name-only` + `git diff --name-only --cached` | Uncommitted file paths |
| `--branch` | `git diff --name-only main...HEAD` (auto-detects main vs master) | Branch diff file paths |
| `--pr <num>` | `gh pr diff <num> --name-only` | PR diff file paths |

### 2. File-to-Module Mapping

Uses the same module boundary rules defined in `scale-prompts.ts`:
- `src/services/auth.ts` → module `src/services`
- `packages/api/src/users/user.service.ts` → module `packages/api`
- Falls back to top-level directory if no match

Changed files → affected module paths → filters existing `coverit.json` modules.

Files not in any existing module are flagged for AI to discover as potential new modules.

### 3. Scoped AI Prompt

When incremental mode is active, the Functionality prompt changes to:

> "The following files have changed: [list]. These belong to modules: [list]. Re-analyze ONLY these modules. Use your tools to explore the current state and update: file counts, line counts, complexity, test mapping, expected test counts. If changed files suggest a new module, add it. Return JSON for affected modules only."

AI still uses Read, Glob, Grep, Bash tools — scoped to affected directories.

### 4. Manifest Merge

After AI returns updated modules:

1. Start with existing coverit.json modules
2. For each AI-returned module:
   - Exists → replace with updated version (preserve security/stability/conformance data)
   - New → append
3. AI-flagged deleted modules → remove
4. Re-score full manifest
5. Write coverit.json

### 5. MCP Support

Add `scope` parameter to `coverit_scan` MCP tool:
- `"changed"` — uncommitted changes
- `"branch"` — current branch vs main
- `"pr:<number>"` — specific PR

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| No coverit.json exists | Error: "Run `coverit scan` first for initial setup" |
| No changed files detected | Info: "No changes detected." Exit 0 |
| Changed file not in any module | AI discovers as potential new module |
| Module deleted (all files removed) | AI flags, merge removes from manifest |
| `--changed` + `--dimensions security` | Functionality + Security on affected modules |
| `--branch` on main/master | Error: "Already on default branch" |
| `gh` CLI not installed (for `--pr`) | Error with install link |

## Day-to-Day Workflow

```bash
# Initial setup (once)
coverit scan                    # Full codebase scan → coverit.json

# Daily loop
# ... make code changes ...
coverit scan --changed          # Quick scan (~2-3 min)
coverit cover                   # Generate tests for new gaps
coverit run                     # Run + fix tests

# Before PR
coverit scan --branch           # Verify all branch changes captured
coverit status                  # Check score
```

## Decisions

- **Approach**: Git-based module filtering with AI re-analysis (not pure heuristic)
- **Default dimension**: Functionality only for speed; user adds `--dimensions` for more
- **Missing coverit.json**: Error, not auto-fallback (explicit setup step)
- **Change detection**: Uncommitted only for `--changed` (not since-last-commit)
