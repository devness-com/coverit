---
description: "Re-run tests from a prior coverit run to check if they pass"
---

# Coverit Check

Re-run test files from a prior coverit operation to check if they pass. Works for both:
- **Existing project tests** identified by `/coverit:scan` as covering changes
- **Coverit-generated tests** from `/coverit:run` or `/coverit:full` (e.g. after manual fixes)

No AI refinement — just executes the test files as-is and reports results.

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current working directory)
- `--run <runId>` - Target a specific run ID (defaults to latest run)
- `--plan <ids>` - Comma-separated plan IDs to check (default: all)

## Execution

### Phase 1: Determine What to Check

Read the run directory to decide which MCP tool to use:

1. Use Glob to check if `<projectRoot>/.coverit/runs/<runId>/progress/*.json` files exist
2. **If progress files exist** → this run has generated/executed tests. Use `coverit_recheck`.
3. **If no progress files** → this run was a scan-only with existing tests. Use `coverit_verify`.

If no `--run` was given, read `<projectRoot>/.coverit/latest.json` to get the latest runId first.

### Phase 2: Run via Sub-Agent

Spawn a sub-agent using the Task tool with `subagent_type: "general-purpose"` and `run_in_background: true`.

**If using `coverit_recheck`** (progress files exist):

```
Call the `mcp__plugin_coverit_coverit__coverit_recheck` MCP tool with:
{
  "projectRoot": "<absolute path>",
  "runId": "<runId>",           // only include if user specified --run
  "planIds": ["<planId>", ...]  // only include if user specified --plan
}

Return a concise summary (NOT the full JSON):
- For each plan: planId, status (passed/failed), tests passed/failed, duration
- Overall: N/M plans passing
```

**If using `coverit_verify`** (scan-only run):

```
Call the `mcp__plugin_coverit_coverit__coverit_verify` MCP tool with:
{
  "projectRoot": "<absolute path>",
  "runId": "<runId>"            // only include if user specified --run
}

Return a concise summary (NOT the full JSON):
- Total test files checked, total tests, pass/fail counts
- For each file: file path, status (passed/failed), tests passed/failed, duration
- Only show failure details for files that failed
```

**CRITICAL**: The sub-agent MUST use the appropriate MCP tool. It must NOT use the CLI, shell commands, or attempt to run tests manually.

### Phase 3: Report Results

Wait for the sub-agent to complete, then show the summary:

```
Check complete for run <runId>.

Results: N/M tests passing

  plan_001: passed (5/5 tests, 1.2s) — unit tests for auth/service.ts
  plan_002: failed (3/5 tests, 2.1s) — api tests for booking/controller.ts
  ...
```

If all tests pass: "All tests pass."

If any tests failed, add: "Run `/coverit:fix` to attempt AI-powered fixes on the failing tests."
