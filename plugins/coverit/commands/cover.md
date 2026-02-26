---
description: "AI generates, runs, and fixes tests to improve your quality score"
---

# Coverit Cover

The main command. AI reads gaps from `coverit.json`, generates tests to fill them, runs the tests, fixes failures, and updates your quality score.

This is a heavy operation — AI writes and executes real test files. May take several minutes.

## IMPORTANT: Run via sub-agent to protect context

**You MUST delegate this to a sub-agent** using the Task tool.

## Prerequisites

Requires `coverit.json` to exist. If it doesn't, tell the user:
```
No coverit.json found. Run /coverit:analyze first.
```

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current working directory)
- `--modules <paths>` - Only cover specific modules (comma-separated, e.g. "src/services,src/utils")

## Execution

First, tell the user:

```
Reading coverit.json and generating tests for gaps. This may take several minutes...
```

Use the Task tool with `subagent_type: "general-purpose"` and a prompt like:

```
Call the `mcp__plugin_coverit_coverit__coverit_cover` MCP tool with:
{
  "projectRoot": "<absolute path>"
  <if --modules specified: "modules": ["src/services", "src/utils"]>
}

The response JSON includes:
- "scoreBefore": number
- "scoreAfter": number
- "modulesProcessed": number
- "testsGenerated": number
- "testsPassed": number
- "testsFailed": number

Format the response as:

coverit -- Cover Complete

Score: <scoreBefore>/100 -> <scoreAfter>/100  (<delta>)

Results
  Modules processed: N
  Tests generated: N
  Passed: N | Failed: N

If scoreAfter > scoreBefore: "Score improved by <delta> points."
If testsFailed > 0: "Some tests still failing. Run /coverit:cover again to retry, or edit manually."

Next: Run /coverit:status to see the full dashboard.
```

**CRITICAL**: The sub-agent MUST use the `mcp__plugin_coverit_coverit__coverit_cover` MCP tool.

## Display

Show the sub-agent's formatted results. Do NOT re-process the raw JSON.
