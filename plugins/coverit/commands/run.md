---
description: "Full pipeline: analyze, generate, execute tests, and report"
---

# Coverit Run

Run the full coverit pipeline: analyze, generate tests, execute them, and produce a report.

## IMPORTANT: Always use the MCP tool

**You MUST use the `mcp__plugin_coverit_coverit__coverit_full` MCP tool.** Do NOT use the `coverit` CLI binary, do NOT run shell commands, do NOT use `gh` to fetch diffs manually. The MCP tool handles everything internally.

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current working directory)
- `--base <branch>` - Diff against a specific base branch
- `--commit <ref>` - Diff for a specific commit or range (e.g. HEAD~1, abc..def)
- `--pr [number]` - Diff for a pull request by number (auto-detects base branch)
- `--files <glob>` - Target specific files by glob pattern
- `--staged` - Only analyze staged changes
- `--type <types>` - Comma-separated test types (unit, api, e2e-browser, etc.)
- `--coverage` - Collect coverage data
- `--env <env>` - Execution environment (local, cloud-sandbox)

## Execution

Call the MCP tool with these parameters:

```json
{
  "projectRoot": "<absolute path to project root>",
  "testTypes": ["unit", "api"],
  "environment": "local",
  "coverage": true,
  "baseBranch": "<branch>",
  "commit": "<ref>",
  "pr": <number>,
  "files": ["<glob>"],
  "staged": true
}
```

Only include parameters that were specified by the user.

## Display Results

```
Results Summary
  Status: PASSED / FAILED
  Total Tests: N
  Passed: N
  Failed: N
  Skipped: N
  Duration: Nms

Coverage (if collected)
  Lines: N%
  Branches: N%
  Functions: N%
  Statements: N%
```

If there are failures, show details:
```
Failures
  1. <test name>: <message>
     Expected: <expected>
     Actual: <actual>
```
