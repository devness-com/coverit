---
description: "Full pipeline: analyze, generate, execute tests, and report"
---

# Coverit Run

Run the full coverit pipeline: analyze, generate tests, execute them, and produce a report.

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current directory)
- `--base <branch>` - Diff against a specific base branch
- `--commit <ref>` - Diff for a specific commit or range (e.g. HEAD~1, abc..def)
- `--pr [number]` - Diff for a pull request (auto-detects base branch)
- `--files <glob>` - Target specific files by glob pattern
- `--staged` - Only analyze staged changes
- `--type <types>` - Comma-separated test types (unit, api, e2e-browser, etc.)
- `--coverage` - Collect coverage data
- `--env <env>` - Execution environment (local, cloud-sandbox)

## Execution Flow

Use the `coverit_full` MCP tool:

1. Set `projectRoot` to the absolute path of the project (default: current working directory)
2. Map diff source flags to MCP parameters (same as scan)
3. Map additional flags:
   - `--type <types>` → `testTypes: [...]`
   - `--coverage` → `coverage: true`
   - `--env <env>` → `environment: "<env>"`
4. Call the tool

## Display Results

```
Results Summary
  Status: <PASSED/FAILED>
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

If there are failures, show details for each:
```
Failures
  1. <test name>: <message>
     Expected: <expected>
     Actual: <actual>
```

Exit with non-zero suggestion if tests failed.
