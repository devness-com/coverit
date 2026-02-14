---
description: "Clear coverit runs and generated test files"
---

# Coverit Clear

Delete coverit run data and optionally clean up generated test files from the project.

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current working directory)
- `--run <runId>` - Delete a specific run by ID
- `--scope <scope>` - Delete all runs matching scope (e.g. 'pr-99', 'staged')
- `--all` - Delete all runs
- `--clean` - Also delete generated test files from the project (optional)

If no `--run`, `--scope`, or `--all` is specified, default to `--all`.

## Execution

Call the `mcp__plugin_coverit_coverit__coverit_clear` MCP tool **directly** (do NOT use a sub-agent or Task tool):
```json
{
  "projectRoot": "<absolute path>",
  "runId": "<runId>",             // only if --run specified
  "scope": "<scope>",             // only if --scope specified
  "all": true,                    // only if --all specified or no flag given
  "cleanTestFiles": true          // only if --clean specified
}
```

## Display

Show the result to the user:

```
Cleared N run(s). M generated test file(s) deleted.
```

If no runs found, say: "No coverit runs to clear."
