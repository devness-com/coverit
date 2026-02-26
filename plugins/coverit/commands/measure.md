---
description: "Fast score recalculation from existing coverit.json (no AI cost)"
---

# Coverit Measure

Recalculate the quality score from the existing `coverit.json` manifest. Scans the filesystem for current test files, updates test counts in the manifest, rescores all dimensions, and writes the updated manifest back.

This is a **fast, free operation** -- no AI calls, no token cost. It takes less than 5 seconds. Run it any time you add, remove, or modify test files to see your updated score.

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current working directory)

## Execution

This command runs directly -- do NOT use a sub-agent (the response is small and fast).

### Step 1: Check for coverit.json

Read `<projectRoot>/coverit.json`. If it does not exist, tell the user:

```
No coverit.json found. Run /coverit:scale first to generate the initial manifest.
```

And stop.

### Step 2: Run Measure

Call the `mcp__plugin_coverit_coverit__coverit_measure` MCP tool **directly** (do NOT use a sub-agent or Task tool):

```json
{
  "projectRoot": "<absolute path>"
}
```

### Step 3: Display Results

Format the JSON response as a readable dashboard:

```
coverit -- Quality Score: <overall>/100  (<delta> from previous)

Dimensions
  Functionality   <score>/100  <bar>
  Security        <score>/100  <bar>
  Stability       <score>/100  <bar>
  Conformance     <score>/100  <bar>
  Regression      <score>/100  <bar>

Gaps (<total> total, <critical> critical)
  List top 5 gaps sorted by severity.
  For each: dimension, description.

Modules (<count>)
  Table with columns: Module | Cmplx | Unit | Intg | API | E2E | Cntr | Score
  Show current/expected for each test type (e.g. 3/5).
  Show "-" for test types with no expected coverage.

Updated: coverit.json
```

For the score delta, compare the new `overall` score against the previous entry in the `score.history` array. Show as:
- `+N` if the score increased (in green if your output supports it)
- `-N` if the score decreased
- `(no change)` if unchanged
- `(first measurement)` if there is only one history entry

## Error Handling

If the MCP tool returns an error about a missing manifest, suggest: "Run `/coverit:scale` to generate the initial coverit.json."
