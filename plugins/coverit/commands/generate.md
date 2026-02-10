---
description: "Generate test files without running them"
---

# Coverit Generate

Analyze a codebase and generate test files without executing them.

## IMPORTANT: Always use the MCP tool

**You MUST use the `mcp__plugin_coverit_coverit__coverit_generate` MCP tool.** Do NOT use the `coverit` CLI binary, do NOT run shell commands, do NOT use `gh` to fetch diffs manually. The MCP tool handles everything internally.

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current working directory)
- `--base <branch>` - Diff against a specific base branch
- `--commit <ref>` - Diff for a specific commit or range (e.g. HEAD~1, abc..def)
- `--pr [number]` - Diff for a pull request by number (auto-detects base branch)
- `--files <glob>` - Target specific files by glob pattern
- `--staged` - Only analyze staged changes
- `--type <types>` - Comma-separated test types (unit, api, e2e-browser, etc.)

## Execution

Call the MCP tool with these parameters:

```json
{
  "projectRoot": "<absolute path to project root>",
  "testTypes": ["unit", "api"],
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
Generated Tests
  Plan <id>: N test(s)
  ...

Test files written colocated next to source files
```
