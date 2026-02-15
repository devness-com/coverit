---
description: "Execute test plans from a prior scan"
---

# Coverit Run

Execute test plans from a prior `/coverit:scan`. Generates test files and runs them for each plan.

This is the "next step" after scanning — it skips re-analysis and directly executes the plans that were already identified.

## Arguments

Parse from user input:
- `[runId]` - Run ID from a prior scan (defaults to latest run). Anything starting with `run-` is a runId.
- `[path]` - Project root path (defaults to current working directory)
- `--plan <ids>` - Comma-separated plan IDs to execute (default: all plans in the run)
- `--coverage` - Collect coverage data
- `--env <env>` - Execution environment (local, cloud-sandbox)

## Execution

### Phase 1: Load Plans from Prior Scan

Determine the runId:
- If user provided a runId argument, use it
- Otherwise, read `<projectRoot>/.coverit/latest.json` to get the latest runId

Read the strategy file at `<projectRoot>/.coverit/runs/<runId>/strategy.json`. Parse it as JSON:
- Extract plan IDs from `triage.plans[].id`
- Extract plan descriptions from `triage.plans[].description`
- If `--plan` was specified, filter to only those plan IDs

If the strategy file doesn't exist or has no plans, tell the user:
"No plans found for run {runId}. Run `/coverit:scan` first to analyze the codebase."

Tell the user: "Loaded N plans from run {runId}."

### Phase 2: Plan Tracking

Create a **task for each plan** using TaskCreate so progress is visible:
- Subject: `Coverit plan_XXX: <description>`
- activeForm: `Running plan_XXX`

Tell the user:
```
Executing N plans (1 sub-agent per plan):
  plan_001: <description>
  plan_002: <description>
  ...
```

### Phase 3: Execute Plans via Sub-Agents

Spawn **one sub-agent per plan** using the Task tool with `subagent_type: "general-purpose"` and `run_in_background: true`.

**Spawn all sub-agents in a single message** so they run in parallel.

Each sub-agent prompt:

```
Call the `mcp__plugin_coverit_coverit__coverit_execute_batch` MCP tool with:
{
  "projectRoot": "<absolute path>",
  "planIds": ["<planId>"],
  "runId": "<runId>",
  <...environment and coverage if specified...>
}

Return a concise summary (NOT the full JSON):
- planId, status (passed/failed/error), tests passed/failed, duration
```

**CRITICAL**: Each sub-agent MUST use the `mcp__plugin_coverit_coverit__coverit_execute_batch` MCP tool. It must NOT use the CLI, shell commands, or `gh` to fetch diffs manually.

### Phase 4: Monitor Progress & Aggregate

After launching all sub-agents, **actively monitor progress** by polling the per-plan progress files.

#### Poll Loop

While sub-agents are still running, repeat every 15–20 seconds:

1. **Read progress files**: Use Glob to list `<projectRoot>/.coverit/runs/<runId>/progress/*.json`, then Read each file. Each contains:

```json
{
  "planId": "plan_001",
  "status": "generating" | "running" | "passed" | "failed" | "error" | "skipped",
  "description": "unit tests for src/auth/service.ts",
  "testFile": "src/auth/service.test.ts",
  "passed": 5,
  "failed": 0,
  "duration": 1234,
  "updatedAt": "..."
}
```

2. **Check completion**: Call `TaskOutput` with `block: false` and `timeout: 5000` for each sub-agent task ID. When a sub-agent returns output, mark its task completed via TaskUpdate.

3. **Print a progress update** each poll cycle:

```
Progress: 5/7 plans complete (1 generating, 1 running)
  Recently completed:
    plan_003: passed (5/5 tests, 1.2s) — crypto utility functions
    plan_004: failed (3/5 tests, 0.8s) — hash chain logic
```

4. **Determine completion**: All plans are done when every progress file has a terminal status (`passed`, `failed`, `error`, or `skipped`).

#### Aggregate from Disk

After all sub-agents complete, read ALL progress files and aggregate:

- Count plans by status (passed / failed / error / skipped)
- Sum `passed` and `failed` test counts across all plans
- Sum `duration` across all plans

Then show the final summary:

```
All plans complete.

Results Summary
  Status: PASSED / FAILED
  Total Plans: N
  Total Tests: N
  Passed: N | Failed: N | Skipped: N | Errors: N
  Duration: Xs

Failures (if any, list first 10):
  1. [planId] description — N/M tests passed (Xs)
```

If there are failures, add: "Run `/coverit:fix` to attempt AI-powered fixes on the failing tests."
