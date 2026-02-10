---
description: "Generate test files without running them"
---

# Coverit Generate

Analyze a codebase and generate test files without executing them.

## IMPORTANT: Run via sub-agent to protect context

The MCP response can be very large. **You MUST delegate this to a sub-agent** using the Task tool to avoid filling up the main conversation context.

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current working directory)
- `--base <branch>` - Diff against a specific base branch
- `--commit <ref>` - Diff for a specific commit or range (e.g. HEAD~1, abc..def)
- `--pr [number]` - Diff for a pull request by number (auto-detects base branch)
- `--files <glob>` - Target specific files by glob pattern
- `--staged` - Only analyze staged changes
- `--type <types>` - Comma-separated test types (unit, api, e2e-browser, etc.)

## Execution

Use the Task tool with `subagent_type: "general-purpose"` and a prompt like:

```
Call the `mcp__plugin_coverit_coverit__coverit_generate` MCP tool with:
{
  "projectRoot": "<absolute path>",
  <...only include params the user specified...>
}

Then format the response as a concise summary:

Generated Tests
  Plan <id>: N test(s) — <description>
  ...

Total: N test files written colocated next to source files
```

**CRITICAL**: The sub-agent MUST use the `mcp__plugin_coverit_coverit__coverit_generate` MCP tool. It must NOT use the `coverit` CLI binary, shell commands, or `gh` to fetch diffs manually.

## Display

Show the sub-agent's formatted summary to the user. Do NOT expand or re-process the raw JSON.
