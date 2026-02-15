---
description: "Generate test files without running them"
---

# Coverit Generate

Generate test files without executing them. Can reuse plans from a prior `/coverit:scan` or analyze from scratch.

## IMPORTANT: Run via sub-agent to protect context

The MCP response can be very large. **You MUST delegate this to a sub-agent** using the Task tool to avoid filling up the main conversation context.

## Arguments

Parse from user input:
- `[runId]` - Run ID from a prior scan (skips re-analysis). Anything starting with `run-` is a runId.
- `[path]` - Project root path (defaults to current working directory)
- `--base <branch>` - Diff against a specific base branch
- `--commit <ref>` - Diff for a specific commit or range (e.g. HEAD~1, abc..def)
- `--pr [number]` - Diff for a pull request by number (auto-detects base branch)
- `--files <glob>` - Target specific files by glob pattern
- `--staged` - Only analyze staged changes
- `--all` - Scan all source files (full project coverage audit, ignores git diff)
- `--type <types>` - Comma-separated test types (unit, api, e2e-browser, etc.)

## Execution

### If a runId was provided

The user wants to generate tests for plans from a prior scan. Spawn **one sub-agent per plan** to generate in parallel.

1. Read the strategy file at `<projectRoot>/.coverit/runs/<runId>/strategy.json`
2. Extract plan IDs from `triage.plans[].id`

Then spawn one sub-agent per plan using the Task tool with `subagent_type: "general-purpose"` and `run_in_background: true`:

```
Call the `mcp__plugin_coverit_coverit__coverit_execute_batch` MCP tool with:
{
  "projectRoot": "<absolute path>",
  "planIds": ["<planId>"],
  "runId": "<runId>"
}

Note: This will generate AND execute. The generation output (test files) is what we care about.

Return a concise summary:
- planId, test file path, status
```

Wait for all sub-agents to complete, then show:

```
Generated Tests
  plan_001: src/services/user.service.test.ts — <description>
  plan_002: src/utils/hash.test.ts — <description>
  ...

Total: N test files written. Review them, then run /coverit:run <runId> to execute.
```

### If no runId was provided (fresh analysis)

Use the Task tool with `subagent_type: "general-purpose"` and a prompt like:

```
Call the `mcp__plugin_coverit_coverit__coverit_generate` MCP tool with:
{
  "projectRoot": "<absolute path>",
  <...only include params the user specified...>
  <if user specified --all, include "all": true>
}

Then format the response as a concise summary:

Generated Tests
  Plan <id>: N test(s) — <description>
  ...

Total: N test files written colocated next to source files
```

**CRITICAL**: The sub-agent MUST use the MCP tools. It must NOT use the `coverit` CLI binary, shell commands, or `gh` to fetch diffs manually.

## Display

Show the sub-agent's formatted summary to the user. Do NOT expand or re-process the raw JSON.
