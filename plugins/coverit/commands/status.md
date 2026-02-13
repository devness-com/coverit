---
description: "Show details for a specific coverit run"
---

# Coverit Status

Show detailed status for a specific coverit run, including per-plan breakdown.

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current working directory)
- `--run <runId>` - Run ID to inspect (defaults to latest)
- `--pr <number>` - Show latest run for a specific PR

## Execution

### Resolve Run ID (if --pr given)

If `--pr` given: first call `mcp__plugin_coverit_coverit__coverit_runs` with `scope: "pr-<number>"` to find the latest run for that PR, then use its runId.

### Fetch Status

Call the `mcp__plugin_coverit_coverit__coverit_status` MCP tool **directly** (do NOT use a sub-agent or Task tool):
```json
{
  "projectRoot": "<absolute path>",
  "runId": "<runId>"              // only include if resolved above or --run was given
}
```

## Display

Format the JSON response and show it directly to the user:

```
Run: <runId>
Scope: <scope>    Status: <status>
Created: <createdAt>    Completed: <completedAt or "in progress">

Summary:
  Tests: <passed>/<totalTests> passed, <failed> failed, <skipped> skipped
  Errors: <errorCount>
  Duration: <duration>ms

Per-Plan Breakdown:
  Plan ID      Status     Tests     Duration   Description
  plan_001     passed     5/5       1.2s       unit tests for auth/service.ts
  plan_002     failed     3/5       0.8s       api tests for booking/controller.ts
  plan_003     error      -         -          e2e tests for checkout flow
```

If there are failures, show a brief "Failure Summaries" section listing the first 5 failed plans.

If there are skipped plans, show a "Skipped Plans" section with each plan's `reason` field (if present) to explain why generation failed.
