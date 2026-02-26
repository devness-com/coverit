---
description: "Show the coverit quality dashboard from coverit.json"
---

# Coverit Status

Show the quality dashboard from `coverit.json`.

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current working directory)

## Execution

### Step 1: Read coverit.json

Read `<projectRoot>/coverit.json` directly using the Read tool.

If the file does not exist, tell the user:
```
No coverit.json found. Run /coverit:analyze to generate the quality manifest.
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
  If any dimension shows "pending-ai-scan", note: "Run /coverit:cover to populate AI-dependent dimensions."

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

## Quick Tips

At the end, show contextual suggestions based on what the dashboard reveals:

- If overall score < 50: "Tip: Run `/coverit:cover` for a comprehensive test generation pass."
- If security/stability/conformance show 0: "Tip: Run `/coverit:cover` to populate AI-dependent dimensions."
- If gaps.critical > 0: "Tip: Focus on critical gaps first. Run `/coverit:cover --modules <path>` targeting the critical modules."
- If score history shows improvement: "Score trending up -- keep it going."
- If no coverit.json exists: "Tip: Run `/coverit:analyze` to create the quality manifest, then `/coverit:cover` to generate tests."
