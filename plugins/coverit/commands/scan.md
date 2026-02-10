---
description: "Analyze a codebase and display the test strategy"
---

# Coverit Scan

Analyze a codebase and display the test strategy without generating or running tests.

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current directory)
- `--base <branch>` - Diff against a specific base branch
- `--commit <ref>` - Diff for a specific commit or range (e.g. HEAD~1, abc..def)
- `--pr [number]` - Diff for a pull request (auto-detects base branch)
- `--files <glob>` - Target specific files by glob pattern
- `--staged` - Only analyze staged changes

## Execution Flow

Use the `coverit_analyze` MCP tool:

1. Set `projectRoot` to the absolute path of the project (default: current working directory)
2. Map flags to the corresponding MCP parameters:
   - `--base <branch>` → `baseBranch: "<branch>"`
   - `--commit <ref>` → `commit: "<ref>"`
   - `--pr [number]` → `pr: <number>` (omit number for auto-detect)
   - `--files <glob>` → `files: ["<glob>"]`
   - `--staged` → `staged: true`
3. Call the tool with `skipExecution: true` and `generateOnly: true`

## Display Results

Show a clear summary:

```
Project Info
  Name: <name>
  Framework: <framework>
  Test Framework: <test framework>
  Language: <language>

Test Plans
  <type>    <priority>    <description>    (~N tests)
  ...

Total estimated tests: N
Execution phases: N
```
