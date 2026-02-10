---
description: "Analyze a codebase and display the test strategy"
---

# Coverit Scan

Analyze a codebase and display the test strategy without generating or running tests.

## IMPORTANT: Always use the MCP tool

**You MUST use the `mcp__plugin_coverit_coverit__coverit_analyze` MCP tool.** Do NOT use the `coverit` CLI binary, do NOT run shell commands, do NOT use `gh` to fetch diffs manually. The MCP tool handles everything internally.

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current working directory)
- `--base <branch>` - Diff against a specific base branch
- `--commit <ref>` - Diff for a specific commit or range (e.g. HEAD~1, abc..def)
- `--pr [number]` - Diff for a pull request by number (auto-detects base branch)
- `--files <glob>` - Target specific files by glob pattern
- `--staged` - Only analyze staged changes

## Execution

Call the MCP tool with these parameters:

```json
{
  "projectRoot": "<absolute path to project root>",
  "baseBranch": "<branch>",
  "commit": "<ref>",
  "pr": <number>,
  "files": ["<glob>"],
  "staged": true
}
```

Only include the diff source parameter that was specified. If none specified, omit all diff source params (auto-detect mode).

## Display Results

Format the JSON response as a readable summary:

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
