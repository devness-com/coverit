---
description: "Full pipeline: analyze, generate, execute tests, and report"
---

# Coverit Run

Run the full coverit pipeline: analyze, generate tests, execute them, and produce a report.

Uses phased sub-agent execution to handle large PRs without timing out.

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current working directory)
- `--base <branch>` - Diff against a specific base branch
- `--commit <ref>` - Diff for a specific commit or range (e.g. HEAD~1, abc..def)
- `--pr [number]` - Diff for a pull request by number (auto-detects base branch)
- `--files <glob>` - Target specific files by glob pattern
- `--staged` - Only analyze staged changes
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
}

Return ONLY a JSON array of plan IDs, like: ["plan_001", "plan_002", ...]. Nothing else.
```

Tell the user: "Scanning... found N plans."

### Phase 2: Batch & Track

From the scan result, group plan IDs into batches of **10 plans** each.

Create a **task for each batch** using TaskCreate so progress is visible:
- Subject: `Coverit Batch K/N: plans XXX–YYY`
- activeForm: `Running Coverit batch K (plans XXX–YYY)`

Tell the user the batch breakdown, e.g.:
```
Executing 96 plans in 10 batches of 10:
  Coverit Batch 1: plans 001–010
  Coverit Batch 2: plans 011–020
  ...
  Coverit Batch 10: plans 091–096
```

### Phase 3: Execute Batches via Sub-Agents

For each batch, spawn a sub-agent using the Task tool with `subagent_type: "general-purpose"` and `run_in_background: true`.

**Spawn all batch sub-agents in a single message** so they run in parallel.

Each sub-agent prompt:

```
Call the `mcp__plugin_coverit_coverit__coverit_execute_batch` MCP tool with:
{
  "projectRoot": "<absolute path>",
  "planIds": ["<id1>", "<id2>", ...],
  <...same diff params from the original command...>
  <...environment and coverage if specified...>
}

Return a concise summary (NOT the full JSON):
- For each plan: planId, status (passed/failed/error), tests passed/failed, duration
- Total: tests passed, failed, skipped, duration
```

**CRITICAL**: Each sub-agent MUST use the `mcp__plugin_coverit_coverit__coverit_execute_batch` MCP tool. It must NOT use the CLI, shell commands, or `gh` to fetch diffs manually.

### Phase 4: Monitor Progress & Aggregate

After launching all batch agents, **actively monitor progress** by polling the per-plan progress files that the orchestrator writes in real-time.

**Important**: Do NOT fall back to `coverit_full` or re-run the pipeline. Results are always available on disk in the progress files.

#### Poll Loop

While batches are still running, repeat every 15–20 seconds:

1. **Read progress files**: Use Glob to list `<projectRoot>/.coverit/progress/*.json`, then Read each file. Each contains:

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

2. **Check batch completion**: Call `TaskOutput` with `block: false` and `timeout: 5000` for each batch task ID. When a batch returns output, mark its task completed via TaskUpdate. Don't worry about parsing the sub-agent's text output — the progress files are the source of truth.

3. **Print a progress update** each poll cycle:

```
Progress: 42/96 plans complete (8 generating, 12 running, 34 remaining)
  Recently completed:
    plan_021: passed (5/5 tests, 1.2s) — unit tests for auth/service.ts
    plan_022: failed (3/5 tests, 0.8s) — api tests for booking/controller.ts
```

4. **Determine completion**: All batches are done when every progress file has a terminal status (`passed`, `failed`, `error`, or `skipped`). Stop polling when this is true OR when all TaskOutput calls return completed.

#### Aggregate from Disk

After all batches complete, read ALL `<projectRoot>/.coverit/progress/*.json` files and aggregate:

- Count plans by status (passed / failed / error / skipped)
- Sum `passed` and `failed` test counts across all plans
- Sum `duration` across all plans

Then show the final summary:

```
All batches complete.

Results Summary
  Status: PASSED / FAILED
  Total Plans: N (in K batches)
  Total Tests: N
  Passed: N | Failed: N | Skipped: N | Errors: N
  Duration: Xs

Failures (if any, list first 10):
  1. [planId] description — N/M tests passed (Xs)
```

#### Small PR Shortcut

If only a small number of plans (≤10), skip batching and run all plans in a single `coverit_execute_batch` call via one sub-agent (without `run_in_background`). Then read progress files to aggregate results the same way.
