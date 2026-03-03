---
description: "Fix failing tests via AI, and update your quality score"
---

# Coverit Fix

Runs all existing tests from `coverit.json`, sends failures to AI for fixing, rescans and updates the manifest score.

Unlike `/coverit:cover` (which writes new tests for gaps), `/coverit:fix` assumes tests already exist and just runs + fixes them.

## IMPORTANT: Fix via sub-agent to protect context

**You MUST delegate this to a sub-agent** using the Task tool.

## Prerequisites

Requires `coverit.json` to exist. If it doesn't, tell the user:
```
No coverit.json found. Run /coverit:scan first.
```

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current working directory)
- `--modules <paths>` - Only fix tests for specific modules (comma-separated, e.g. "src/services,src/utils")

## Execution

First, tell the user:

```
Fixing failing tests. This may take several minutes...
```

Use the Task tool with `subagent_type: "general-purpose"` and a prompt like:

```
Call the `mcp__plugin_coverit_coverit__coverit_fix` MCP tool with:
{
  "projectRoot": "<absolute path>"
  <if --modules specified: "modules": ["src/services", "src/utils"]>
}

The response JSON includes:
- "scoreBefore": number
- "scoreAfter": number
- "totalTests": number
- "passed": number
- "failed": number
- "fixed": number

Format the response as:

coverit -- Fix Complete

Score: <scoreBefore>/100 -> <scoreAfter>/100  (<delta>)

Results
  Total tests: N
  Passed: N | Failed: N
  Fixed by AI: N

If scoreAfter > scoreBefore: "Score improved by <delta> points."
If failed > 0: "Some tests still failing. Run /coverit:fix again to retry, or edit manually."
If fixed > 0: "AI fixed <fixed> test(s)."

Next: Run /coverit:status to see the full dashboard.
```

**CRITICAL**: The sub-agent MUST use the `mcp__plugin_coverit_coverit__coverit_fix` MCP tool.

## Display

Show the sub-agent's formatted results. Do NOT re-process the raw JSON.
