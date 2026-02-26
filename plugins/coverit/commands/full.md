---
description: "Full v1.0 pipeline: scale, measure, scan, generate, run, fix, and update dashboard"
---

# Coverit Full -- v1.0 Pipeline

Run the complete coverit pipeline with quality tracking. This is the primary command for generating and running tests with automatic retry cycles.

The v1.0 flow integrates the quality manifest (`coverit.json`) so you get a before/after score delta showing the impact of generated tests.

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
- `--cycles <n>` - Maximum SGR loop cycles (default: 1, max: 5). Use 2-3 for automatic retry on failures.

## Execution -- v1.0 Pipeline

### Phase 0: Ensure coverit.json exists

Check if `<projectRoot>/coverit.json` exists by reading the file.

If it does NOT exist:
1. Tell the user: "No coverit.json found. Running initial codebase analysis..."
2. Spawn a sub-agent using the Task tool with `subagent_type: "general-purpose"`:

```
Call the `mcp__plugin_coverit_coverit__coverit_scale` MCP tool with:
{
  "projectRoot": "<absolute path>"
}

Return a JSON object with "overall" and "moduleCount" keys from the manifest score.
Nothing else.
```

3. Tell the user: "Manifest created with <moduleCount> modules. Baseline score: <overall>/100"

### Phase 1: Measure current state (before)

Call the `mcp__plugin_coverit_coverit__coverit_measure` MCP tool **directly**:

```json
{
  "projectRoot": "<absolute path>"
}
```

Store the `score.overall` value as `scoreBefore`.

Tell the user:
```
Current quality score: <scoreBefore>/100
```

### Phase 2: SGR Loop (Scan -> Generate -> Run)

Set `maxCycles` from the `--cycles` argument (default 1, clamp to 1-5).
Set `currentCycle = 1`.
Set `priorFailures = []` (empty for first cycle).
Set `allCycleResults = []` to track results across cycles.

---

#### SGR Cycle (repeat up to maxCycles)

Tell the user:
```
SGR Cycle {currentCycle}/{maxCycles}
```

##### Step 1: Scan

Spawn a sub-agent to analyze the codebase and get the test strategy with plan IDs.

Use the Task tool with `subagent_type: "general-purpose"`:

```
Call the `mcp__plugin_coverit_coverit__coverit_analyze` MCP tool with:
{
  "projectRoot": "<absolute path>",
  <...only include diff params the user specified...>
  <if user specified --all, include "all": true>
  <if priorFailures is not empty, include "priorFailures": priorFailures>
}

Return a JSON object with "runId", "planIds", and "planDescriptions" keys, like:
{"runId": "run-20260215-143022-a7f3", "planIds": ["plan_001", "plan_002"], "planDescriptions": {"plan_001": "unit tests for auth service", "plan_002": "api tests for booking"}}
Nothing else.
```

Tell the user: "Scanning... found N plans. Run: {runId}"

If 0 plans found and this is cycle 1, tell the user: "No testable changes found." and skip to Phase 3.
If 0 plans found and this is cycle > 1, the AI decided all prior failures are not worth retrying -- skip to Phase 3.

##### Step 2: Plan Tracking

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

##### Step 3: Execute Plans via Sub-Agents

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

##### Step 4: Monitor Progress & Aggregate

After launching all sub-agents, **actively monitor progress** by polling the per-plan progress files that the orchestrator writes in real-time.

**Important**: Do NOT fall back to `coverit_full` or re-run the pipeline. Results are always available on disk in the progress files.

###### Poll Loop

While sub-agents are still running, repeat every 15-20 seconds:

1. **Read progress files**: Use Glob to list `<projectRoot>/.coverit/runs/<runId>/progress/*.json`, then Read each file. Each contains:

```json
{
  "planId": "plan_001",
  "status": "generating" | "running" | "passed" | "failed" | "error" | "skipped",
  "description": "unit tests for src/auth/service.ts -- 3 function(s)",
  "testFile": "src/auth/service.test.ts",
  "passed": 5,
  "failed": 0,
  "duration": 1234,
  "updatedAt": "..."
}
```

2. **Check completion**: Call `TaskOutput` with `block: false` and `timeout: 5000` for each sub-agent task ID. When a sub-agent returns output, mark its task completed via TaskUpdate. Don't worry about parsing the sub-agent's text output -- the progress files are the source of truth.

3. **Print a progress update** each poll cycle:

```
Cycle {currentCycle} Progress: 8/14 plans complete (2 generating, 4 running)
  Recently completed:
    plan_003: passed (5/5 tests, 1.2s) -- unit tests for auth/service.ts
    plan_004: failed (3/5 tests, 0.8s) -- api tests for booking/controller.ts
```

4. **Determine completion**: All plans are done when every progress file has a terminal status (`passed`, `failed`, `error`, or `skipped`). Stop polling when this is true OR when all TaskOutput calls return completed.

###### Aggregate Cycle Results

After all sub-agents complete, read ALL `<projectRoot>/.coverit/runs/<runId>/progress/*.json` files and aggregate:

- Count plans by status (passed / failed / error / skipped)
- Sum `passed` and `failed` test counts across all plans
- Sum `duration` across all plans
- Store this cycle's results in `allCycleResults`

Show cycle summary:
```
Cycle {currentCycle} complete: N passed, M failed, K errors, J skipped
```

##### Step 5: Check for Next Cycle

Collect all plans with status `failed` or `error`. If none, or if `currentCycle >= maxCycles`, go to Phase 3.

Otherwise, **build `priorFailures` for the next cycle**:

For each failed/error plan from this cycle's progress files:
1. Read the progress file to get `planId`, `description`, `testFile`
2. Read the generated test file from disk (`<projectRoot>/<testFile>`) to get `priorTestCode`
3. Collect failure messages -- read the batch report at `<projectRoot>/.coverit/runs/<runId>/batch-<planId>-<planId>.json`, extract `results[0].failures[].message`. If no batch report, use the progress file's status as the message.

Build the `priorFailures` array:
```json
[
  {
    "planId": "plan_001",
    "description": "unit tests for auth service",
    "testFile": "src/auth/service.test.ts",
    "failureMessages": ["Expected 200 but got 401", "Cannot read property 'user' of undefined"],
    "priorTestCode": "import { AuthService } from ..."
  }
]
```

Tell the user:
```
{M} plans failed. Starting SGR cycle {currentCycle + 1}/{maxCycles} with failure context...
```

Increment `currentCycle` and go back to **Step 1: Scan**.

---

### Phase 3: Update manifest and show final dashboard

After all SGR cycles complete:

1. **Measure the updated state** by calling the `mcp__plugin_coverit_coverit__coverit_measure` MCP tool **directly**:

```json
{
  "projectRoot": "<absolute path>"
}
```

Store the `score.overall` value as `scoreAfter`.

2. **Show the comprehensive final summary**:

```
SGR Complete -- {currentCycle} cycle(s)

Results Summary
  Status: PASSED / FAILED
  Total Plans: N (across all cycles)
  Total Tests: N
  Passed: N | Failed: N | Skipped: N | Errors: N
  Duration: Xs

Per-Cycle Breakdown:
  Cycle 1: 12 plans -- 8 passed, 4 failed (run-20260215-143022-a7f3)
  Cycle 2: 4 plans -- 3 passed, 1 failed (run-20260215-143245-b8d2)
  Cycle 3: 1 plan -- 1 passed (run-20260215-143512-c9e3)

Quality Score: <scoreBefore>/100 -> <scoreAfter>/100  (<delta>)
  (Show "+N" if improved, "-N" if decreased, "no change" if same)

Failures (if any, list first 10):
  1. [planId] description -- N/M tests passed (Xs)
```

If all tests pass: "All tests pass."

If failures remain after all cycles:
```
{N} plans still failing after {maxCycles} cycle(s).
Run `/coverit:fix` for AI-powered refinement of individual test files, or edit manually and run `/coverit:check`.
```
