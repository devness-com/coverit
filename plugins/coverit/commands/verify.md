---
description: "Run existing test files to verify they pass"
---

# Coverit Verify

Run existing test files identified by a prior `/coverit:scan` to verify they actually pass. Use this when the scan shows "all changes are already covered" to confirm the tests work.

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current working directory)
- `--run <runId>` - Target a specific run ID from a prior scan (defaults to latest run)

## Execution

### Phase 1: Verify via Sub-Agent

Spawn a sub-agent using the Task tool with `subagent_type: "general-purpose"` and `run_in_background: true`.

Sub-agent prompt:

```
Call the `mcp__plugin_coverit_coverit__coverit_verify` MCP tool with:
{
  "projectRoot": "<absolute path>",
  "runId": "<runId>"              // only include if user specified --run
}

Return a concise summary (NOT the full JSON):
- Total test files verified, total tests, pass/fail counts
- For each file: file path, status (passed/failed), tests passed/failed, duration
- Only show failure details for files that failed
```

**CRITICAL**: The sub-agent MUST use the `mcp__plugin_coverit_coverit__coverit_verify` MCP tool. It must NOT use the CLI, shell commands, or attempt to run tests manually.

### Phase 2: Report Results

Wait for the sub-agent to complete, then show a summary:

```
Verification complete for run <runId>.

Results: N/M test files passing (X tests passed, Y failed)

  booking.service.admin.spec.ts — passed (81 tests, 12.3s)
  notifications.controller.spec.ts — passed (15 tests, 3.1s)
  ...

All existing tests pass. The PR's test coverage is verified.
```
