---
description: "Fix failing tests from the last coverit run using AI refinement"
---

# Coverit Fix

Fix failing tests from a previous SGR run (`/coverit:run`, `/coverit:full`, or `/coverit:check`). Reads failure details from `.coverit/progress/` files, uses AI to refine test code, and re-executes only the failed plans.

Unlike the SGR loop in `/coverit:full --cycles`, this command does lightweight per-file refinement without re-scanning or re-planning.

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current working directory)
- `--run <runId>` - Target a specific run ID
- `--pr <number>` - Target the latest run for a specific PR
- `--plan-ids <ids>` - Comma-separated plan IDs to fix (default: all failed plans)
- `--retries <n>` - Max fix attempts per plan (default: 2)

## Execution

### Phase 1: Find Target Run

Determine which run to fix:
- If `--run` given: use that runId directly
- If `--pr` given: call `mcp__plugin_coverit_coverit__coverit_runs` with `scope: "pr-<number>"`, pick the first (latest) result's runId
- Otherwise: use the latest run (no runId needed, MCP tool defaults to latest)

### Phase 2: Discover Failures

Read progress files from `<projectRoot>/.coverit/runs/<runId>/progress/*.json` to identify failed plans. If no `--run` or `--pr` was given, first read `<projectRoot>/.coverit/latest.json` to get the current runId.

Use the Glob tool to list all progress files, then Read each one. Filter for plans with `"status": "failed"` or `"status": "error"`.

If no failed plans found, tell the user: "No failed plans found from the last run. Nothing to fix."

If there are failed plans, tell the user:

```
Found N failed plans from the last run:
  plan_001: unit tests for src/auth/service.ts — 3/5 tests passed
  plan_002: api tests for src/booking/controller.ts — 0/4 tests passed
  ...
```

### Phase 3: Fix via Sub-Agents (1 per plan)

Create a **task for each failed plan** using TaskCreate so progress is visible:
- Subject: `Fix plan_XXX: <description>`
- activeForm: `Fixing plan_XXX`

Spawn **one sub-agent per failed plan** using the Task tool with `subagent_type: "general-purpose"` and `run_in_background: true`.

**Spawn all sub-agents in a single message** so they run in parallel. Each plan gets its own isolated sub-agent with full context and token budget.

Each sub-agent prompt:

```
Call the `mcp__plugin_coverit_coverit__coverit_fix` MCP tool with:
{
  "projectRoot": "<absolute path>",
  "runId": "<runId>",
  "planIds": ["<planId>"],
  "maxRetries": <n>                      // only include if user specified --retries
}

Return a concise summary (NOT the full JSON):
- planId, status (passed/failed/error), tests passed/failed, duration
```

**CRITICAL**: Each sub-agent MUST use the `mcp__plugin_coverit_coverit__coverit_fix` MCP tool. It must NOT use the CLI, shell commands, or attempt to fix tests manually.

### Phase 4: Monitor & Report

Poll `.coverit/runs/<runId>/progress/*.json` files every 15-20 seconds (same pattern as `/coverit:run`):

1. Read progress files using Glob + Read
2. Check sub-agent completion via `TaskOutput` with `block: false` and `timeout: 5000`
3. Print progress each poll cycle:

```
Fix Progress: 8/10 plans processed (2 running)
  Recently fixed:
    plan_001: passed (5/5 tests, 1.2s) — was: 3/5 passed
    plan_002: still failing (2/4 tests, 0.8s)
```

4. Stop when all progress files have terminal status

#### Final Summary

After all fixes complete, read ALL progress files and show a before/after comparison:

```
Fix complete.

Results Summary
  Fixed: N/M plans now passing
  Still failing: K plans
  Total Tests: X passed, Y failed
  Duration: Zs

Before → After:
  plan_001: failed (3/5) → passed (5/5)
  plan_002: failed (0/4) → failed (2/4) — improved
  plan_003: error → passed (3/3)
  plan_004: failed (1/2) → failed (1/2) — no change
```
