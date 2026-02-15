---
description: "Full pipeline: scan, generate, execute tests, and report — all in one command"
---

# Coverit Full

Run the full coverit pipeline: analyze, generate tests, execute them, and produce a report. All in one command.

Uses phased sub-agent execution to handle large PRs without timing out.

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current working directory)
- `--base <branch>` - Diff against a specific base branch
- `--commit <ref>` - Diff for a specific commit or range (e.g. HEAD~1, abc..def)
- `--pr [number]` - Diff for a pull request by number (auto-detects base branch)
- `--files <glob>` - Target specific files by glob pattern
- `--staged` - Only analyze staged changes
- `--all` - Scan all source files (full project coverage audit, ignores git diff)
- `--type <types>` - Comma-separated test types (unit, api, e2e-browser, etc.)
- `--coverage` - Collect coverage data
- `--env <env>` - Execution environment (local, cloud-sandbox)

## Execution — Phased Sub-Agent Pipeline

### Phase 1: Scan

Spawn a sub-agent to analyze the codebase and get the test strategy with plan IDs.

Use the Task tool with `subagent_type: "general-purpose"`:

```
Call the `mcp__plugin_coverit_coverit__coverit_analyze` MCP tool with:
{
  "projectRoot": "<absolute path>",
  <...only include diff params the user specified...>
  <if user specified --all, include "all": true>
}

Return a JSON object with "runId" and "planIds" keys, like:
{"runId": "run-20260213-143022-a7f3", "planIds": ["plan_001", "plan_002", ...]}
Nothing else.
```

Tell the user: "Scanning... found N plans. Run: {runId}"

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

**Spawn all sub-agents in a single message** so they run in parallel. Each plan gets its own isolated sub-agent with full context and token budget.

Each sub-agent prompt:

```
Call the `mcp__plugin_coverit_coverit__coverit_execute_batch` MCP tool with:
{
  "projectRoot": "<absolute path>",
  "planIds": ["<planId>"],
  "runId": "<runId from scan>",
  <...same diff params from the original command...>
  <if the original command used --all, include "all": true>
  <...environment and coverage if specified...>
}

Return a concise summary (NOT the full JSON):
- planId, status (passed/failed/error), tests passed/failed, duration
```

**CRITICAL**: Each sub-agent MUST use the `mcp__plugin_coverit_coverit__coverit_execute_batch` MCP tool. It must NOT use the CLI, shell commands, or `gh` to fetch diffs manually.

### Phase 4: Monitor Progress & Aggregate

After launching all sub-agents, **actively monitor progress** by polling the per-plan progress files that the orchestrator writes in real-time.

**Important**: Do NOT fall back to `coverit_full` or re-run the pipeline. Results are always available on disk in the progress files.

#### Poll Loop

While sub-agents are still running, repeat every 15–20 seconds:

1. **Read progress files**: Use Glob to list `<projectRoot>/.coverit/runs/<runId>/progress/*.json`, then Read each file. Each contains:

```json
{
  "planId": "plan_001",
  "status": "generating" | "running" | "passed" | "failed" | "error" | "skipped",
  "description": "unit tests for src/auth/service.ts — 3 function(s)",
  "testFile": "src/auth/service.test.ts",
  "passed": 5,
  "failed": 0,
  "duration": 1234,
  "updatedAt": "..."
}
```

2. **Check completion**: Call `TaskOutput` with `block: false` and `timeout: 5000` for each sub-agent task ID. When a sub-agent returns output, mark its task completed via TaskUpdate. Don't worry about parsing the sub-agent's text output — the progress files are the source of truth.

3. **Print a progress update** each poll cycle:

```
Progress: 8/14 plans complete (2 generating, 4 running)
  Recently completed:
    plan_003: passed (5/5 tests, 1.2s) — unit tests for auth/service.ts
    plan_004: failed (3/5 tests, 0.8s) — api tests for booking/controller.ts
```

4. **Determine completion**: All plans are done when every progress file has a terminal status (`passed`, `failed`, `error`, or `skipped`). Stop polling when this is true OR when all TaskOutput calls return completed.

#### Aggregate from Disk

After all sub-agents complete, read ALL `<projectRoot>/.coverit/runs/<runId>/progress/*.json` files and aggregate:

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
