---
description: "Analyze a codebase and display the test strategy"
---

# Coverit Scan

Analyze a codebase and display the test strategy without generating or running tests.

## IMPORTANT: Run via sub-agent to protect context

The MCP response can be very large (10k-30k+ tokens). **You MUST delegate this to a sub-agent** using the Task tool to avoid filling up the main conversation context.

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current working directory)
- `--base <branch>` - Diff against a specific base branch
- `--commit <ref>` - Diff for a specific commit or range (e.g. HEAD~1, abc..def)
- `--pr [number]` - Diff for a pull request by number (auto-detects base branch)
- `--files <glob>` - Target specific files by glob pattern
- `--staged` - Only analyze staged changes

## Execution

Use the Task tool with `subagent_type: "general-purpose"` and a prompt like:

```
Call the `mcp__plugin_coverit_coverit__coverit_analyze` MCP tool with:
{
  "projectRoot": "<absolute path>",
  <...only include diff params the user specified...>
}

The response JSON includes a "runId" field. Extract it.

Then format the JSON response as a concise readable summary:

Run: <runId> (scope: <derived from diff params>)

Project Info
  Name / Framework / Test Framework / Language

Test Plans (group by priority, show type, description, estimated tests)

Summary: total plans, total estimated tests, execution phases

Note: "Use this runId with `coverit_execute_batch` or `/coverit:run` to execute plans."
```

**CRITICAL**: The sub-agent MUST use the `mcp__plugin_coverit_coverit__coverit_analyze` MCP tool. It must NOT use the `coverit` CLI binary, shell commands, or `gh` to fetch diffs manually.

## Display

Show the sub-agent's formatted summary to the user. Do NOT expand or re-process the raw JSON.
