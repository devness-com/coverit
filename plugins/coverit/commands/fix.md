---
description: "Fix failing tests from the last coverit run using AI refinement"
---

# Coverit Fix

Fix failing tests from a previous `/coverit:run`. Reads failure details from `.coverit/progress/` files, uses AI to refine test code, and re-executes only the failed plans.

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current working directory)
- `--plan-ids <ids>` - Comma-separated plan IDs to fix (default: all failed plans)
- `--retries <n>` - Max fix attempts per plan (default: 2)

## Execution

### Phase 1: Discover Failures

Read progress files from `<projectRoot>/.coverit/progress/*.json` to identify failed plans.

Use the Glob tool to list all progress files, then Read each one. Filter for plans with `"status": "failed"` or `"status": "error"`.

If no failed plans found, tell the user: "No failed plans found from the last run. Nothing to fix."

If there are failed plans, tell the user:

```
Found N failed plans from the last run:
  plan_001: unit tests for src/auth/service.ts — 3/5 tests passed
  plan_002: api tests for src/booking/controller.ts — 0/4 tests passed
  ...
```

### Phase 2: Fix via Sub-Agent

#### Small fix (10 or fewer failed plans)

Spawn a single sub-agent using the Task tool with `subagent_type: "general-purpose"`:

```
Call the `mcp__plugin_coverit_coverit__coverit_fix` MCP tool with:
{
  "projectRoot": "<absolute path>",
  "planIds": ["<id1>", "<id2>", ...],   // only include if user specified --plan-ids
  "maxRetries": <n>                      // only include if user specified --retries
}

Return a concise summary (NOT the full JSON):
- For each plan: planId, status (passed/failed/error), tests passed/failed, duration
- Total: plans fixed, still failing
```

**CRITICAL**: The sub-agent MUST use the `mcp__plugin_coverit_coverit__coverit_fix` MCP tool. It must NOT use the CLI, shell commands, or attempt to fix tests manually.

#### Large fix (more than 10 failed plans)

Group failed plan IDs into batches of **10** each.

Create a **task for each batch** using TaskCreate:
- Subject: `Fix Coverit Batch K/N: plans XXX–YYY`
- activeForm: `Fixing Coverit batch K (plans XXX–YYY)`

For each batch, spawn a sub-agent using the Task tool with `subagent_type: "general-purpose"` and `run_in_background: true`.

**Spawn all batch sub-agents in a single message** so they run in parallel.

Each sub-agent prompt:

```
Call the `mcp__plugin_coverit_coverit__coverit_fix` MCP tool with:
{
  "projectRoot": "<absolute path>",
  "planIds": ["<id1>", "<id2>", ...],
  "maxRetries": <n>
}

Return a concise summary (NOT the full JSON):
- For each plan: planId, status (passed/failed/error), tests passed/failed, duration
- Total: plans fixed, still failing
```

### Phase 3: Monitor & Report

#### If batched (>10 plans)

Poll `.coverit/progress/*.json` files every 15-20 seconds (same pattern as `/coverit:run`):

1. Read progress files using Glob + Read
2. Check batch completion via `TaskOutput` with `block: false` and `timeout: 5000`
3. Print progress each poll cycle:

```
Fix Progress: 8/15 plans processed (3 running, 4 remaining)
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
