---
description: "Re-run existing test files and update status (no AI refinement)"
---

# Coverit Recheck

Re-run existing test files from a prior `/coverit:run` or `/coverit:full` and update progress status. Use this after manually fixing tests outside the coverit pipeline — it executes the test files as-is (no AI refinement) and updates the run's progress files and meta status.

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current working directory)
- `--run <runId>` - Target a specific run ID (defaults to latest run)
- `--plan-ids <ids>` - Comma-separated plan IDs to recheck (default: all plans with test files)

## Execution

### Phase 1: Find Target Run

Determine which run to recheck:
- If `--run` given: use that runId directly
- Otherwise: use the latest run (no runId needed, MCP tool defaults to latest)

### Phase 2: Recheck via Sub-Agent

Spawn a sub-agent using the Task tool with `subagent_type: "general-purpose"` and `run_in_background: true`.

Sub-agent prompt:

```
Call the `mcp__plugin_coverit_coverit__coverit_recheck` MCP tool with:
{
  "projectRoot": "<absolute path>",
  "runId": "<runId>",           // only include if user specified --run
  "planIds": ["<planId>", ...]  // only include if user specified --plan-ids
}

Return a concise summary (NOT the full JSON):
- For each plan: planId, previous status, new status, tests passed/failed, duration
- Overall: N/M plans passing
```

**CRITICAL**: The sub-agent MUST use the `mcp__plugin_coverit_coverit__coverit_recheck` MCP tool. It must NOT use the CLI, shell commands, or attempt to run tests manually.

### Phase 3: Report Results

Wait for the sub-agent to complete, then show a summary:

```
Recheck complete for run <runId>.

Results:
  plan_001: passed (81/81 tests, 12.3s) — was: error
  plan_002: failed (3/5 tests, 2.1s) — was: failed

Overall: N/M plans passing
```
