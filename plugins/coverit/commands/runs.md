---
description: "List all coverit test runs with metadata"
---

# Coverit Runs

List all coverit test runs with their metadata (scope, status, plan count, test results).

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current working directory)
- `--scope <scope>` - Filter by scope (e.g. 'pr-99', 'staged', 'auto')

## Execution

Call the `mcp__plugin_coverit_coverit__coverit_runs` MCP tool **directly** (do NOT use a sub-agent or Task tool):
```json
{
  "projectRoot": "<absolute path>",
  "scope": "<scope>"              // only include if user specified --scope
}
```

## Display

Format the JSON response as a table and show it directly to the user:

```
Run ID                      Scope    Status     Plans    Tests      Created
run-20260213-143022-a7f3    pr-99    failed     18       161/217    2h ago
run-20260213-120015-c4d8    staged   completed  8        42/42      5h ago
```

For the "Tests" column, use "passed/total" from the summary. If no summary, show "-".
For the "Created" column, show relative time (e.g. "2h ago", "1d ago").

If no runs found, say: "No coverit runs found. Run /coverit:run to create one."
