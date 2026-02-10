---
description: "Generate test files without running them"
---

# Coverit Generate

Analyze a codebase and generate test files without executing them.

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current directory)
- `--base <branch>` - Diff against a specific base branch
- `--commit <ref>` - Diff for a specific commit or range (e.g. HEAD~1, abc..def)
- `--pr [number]` - Diff for a pull request (auto-detects base branch)
- `--files <glob>` - Target specific files by glob pattern
- `--staged` - Only analyze staged changes
- `--type <types>` - Comma-separated test types (unit, api, e2e-browser, etc.)

## Execution Flow

Use the `coverit_generate` MCP tool:

1. Set `projectRoot` to the absolute path of the project (default: current working directory)
2. Map diff source flags to MCP parameters (same as scan)
3. If `--type` specified, pass as `testTypes` array
4. Call the tool

## Display Results

```
Generated Tests
  ● Plan <id>: N test(s)
  ● Plan <id>: N test(s)

Files written to .coverit/generated/
```
