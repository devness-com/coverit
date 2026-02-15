---
description: "SGR Step 2: Generate test files from a prior scan without executing them"
---

# Coverit Generate

**Step 2 of the SGR pipeline** (Scan → Generate → Run). Generates test files from plans produced by a prior `/coverit:scan`.

Does NOT execute tests — only writes test files to disk for review.

## Arguments

Parse from user input:
- `[runId]` - Run ID from a prior scan (defaults to latest run). Anything starting with `run-` is a runId.
- `[path]` - Project root path (defaults to current working directory)
- `--plan <ids>` - Comma-separated plan IDs to generate (default: all plans)

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
"No plans found. Run `/coverit:scan` first to analyze the codebase, or use `/coverit:full` to do everything at once."

### Phase 2: Generate via Sub-Agents

Spawn **one sub-agent per plan** using the Task tool with `subagent_type: "general-purpose"` and `run_in_background: true`.

**Spawn all sub-agents in a single message** so they run in parallel.

Each sub-agent prompt:

```
Call the `mcp__plugin_coverit_coverit__coverit_execute_batch` MCP tool with:
{
  "projectRoot": "<absolute path>",
  "planIds": ["<planId>"],
  "runId": "<runId>",
  "generateOnly": true
}

Return a concise summary (NOT the full JSON):
- planId, status, test file path (if generated)
```

**CRITICAL**: Each sub-agent MUST use the `mcp__plugin_coverit_coverit__coverit_execute_batch` MCP tool with `"generateOnly": true`. It must NOT use the CLI, shell commands, or `gh` to fetch diffs manually.

### Phase 3: Aggregate & Report

Wait for all sub-agents to complete. Read progress files from `<projectRoot>/.coverit/runs/<runId>/progress/*.json` to get the generated test file paths.

Show the summary:

```
Generated test files for run <runId>:

  plan_001: src/utils/hash.test.ts — crypto utility functions
  plan_002: src/services/auth.test.ts — session management
  ...

Total: N test files written.

Review the generated files, then run /coverit:run <runId> to execute them.
```

If no test files were generated: "No test files were generated. Check the scan plans for details."
