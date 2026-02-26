---
description: "Show the coverit quality dashboard and run details"
---

# Coverit Status

Show the quality dashboard from `coverit.json` and optionally details for a specific test run.

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current working directory)
- `--run <runId>` - Also show details for a specific run
- `--pr <number>` - Also show latest run for a specific PR

## Execution

### Step 1: Read coverit.json

Read `<projectRoot>/coverit.json` directly using the Read tool.

If the file does not exist, tell the user:
```
No coverit.json found. Run /coverit:scale to generate the quality manifest.
```
And stop.

### Step 2: Display Quality Dashboard

Parse the manifest JSON and format the dashboard:

```
coverit -- Quality Score: <overall>/100

Project
  Name: <name>
  Framework: <framework> (<language>)
  Test Framework: <testFramework>
  Source: <sourceFiles> files, <sourceLines> lines

Dimensions
  Functionality   <score>/100
  Security        <score>/100
  Stability       <score>/100
  Conformance     <score>/100
  Regression      <score>/100

Gaps (<total> total, <critical> critical)
  List top 5 gaps sorted by severity.
  For each gap, show: dimension, description, severity indicator.
  If gaps.total is 0, show: "None -- all clear"
  If any dimension shows "pending-ai-scan", note: "Run /coverit:full to populate AI-dependent dimensions."

Modules (<count>)
  Table with columns: Module | Cmplx | Unit | Intg | API | E2E | Cntr | Score
  For each module:
    - Show current/expected for each test type (e.g. 3/5)
    - Show "-" for test types with no expected coverage
    - Score = (totalCurrent / totalExpected) * 100, rounded

Score History (last 5 entries from score.history)
  Date          Score    Scope
  2026-02-26    72       measure
  2026-02-25    65       first-time
```

### Step 3: Show Run Details (optional)

If the user specified `--run` or `--pr`, also show run details.

#### Resolve Run ID (if --pr given)

If `--pr` given: first call `mcp__plugin_coverit_coverit__coverit_runs` with `scope: "pr-<number>"` to find the latest run for that PR, then use its runId.

#### Fetch Run Status

Call the `mcp__plugin_coverit_coverit__coverit_status` MCP tool **directly** (do NOT use a sub-agent or Task tool):
```json
{
  "projectRoot": "<absolute path>",
  "runId": "<runId>"
}
```

#### Display Run Details

```
Latest Run: <runId>
Scope: <scope>    Status: <status>
Created: <createdAt>    Completed: <completedAt or "in progress">

Summary:
  Tests: <passed>/<totalTests> passed, <failed> failed, <skipped> skipped
  Errors: <errorCount>
  Duration: <duration>ms

Per-Plan Breakdown:
  Plan ID      Status     Tests     Duration   Description
  plan_001     passed     5/5       1.2s       unit tests for auth/service.ts
  plan_002     failed     3/5       0.8s       api tests for booking/controller.ts
  plan_003     error      -         -          e2e tests for checkout flow
```

If there are failures, show a brief "Failure Summaries" section listing the first 5 failed plans.

If there are skipped plans, show a "Skipped Plans" section with each plan's `reason` field (if present) to explain why generation failed.

## Quick Tips

At the end, show contextual suggestions based on what the dashboard reveals:

- If overall score < 50: "Tip: Run `/coverit:full --all` for a comprehensive test generation pass."
- If security/stability/conformance show 0: "Tip: Run `/coverit:full` to populate AI-dependent dimensions."
- If gaps.critical > 0: "Tip: Focus on critical gaps first. Run `/coverit:full --files <path>` targeting the critical modules."
- If score history shows improvement: "Score trending up -- keep it going."
- If no run details were shown: "Tip: Run `/coverit:list` to see recent test runs, or `/coverit:full` to generate new tests."
