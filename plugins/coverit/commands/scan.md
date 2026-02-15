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
- `--all` - Scan all source files (full project coverage audit, ignores git diff)
- `--type <types>` - Comma-separated test types (unit, api, e2e-browser, etc.)

## Execution

Use the Task tool with `subagent_type: "general-purpose"` and a prompt like:

```
Call the `mcp__plugin_coverit_coverit__coverit_analyze` MCP tool with:
{
  "projectRoot": "<absolute path>",
  <...only include diff params the user specified...>
  <if user specified --all, include "all": true>
}

The response JSON includes:
- "runId": the run identifier
- "strategy": { plans, executionOrder, estimatedDuration }
- "skipped": array of { path, reason } for files the AI decided not to test

Format the response as a concise readable summary:

Run: <runId> (scope: <derived from diff params>)

Project Info
  Name / Framework / Test Framework / Language

If there are test plans (strategy.plans.length > 0):
  Test Plans (group by priority, show type, description, estimated tests)
  Summary: total plans, total estimated tests, execution phases
  Note: "Next: /coverit:generate <runId> to generate test files, or /coverit:full to do everything at once."

If there are NO test plans (strategy.plans.length === 0):
  Show "All changes are already covered by existing tests." if skipped entries mention coverage.
  Then list a summary of coverage:
    - Count how many skipped entries mention "Covered by" or "already covered"
    - Show: "N/M changed files already have test coverage"
    - Show 3-5 key examples like: "booking.service.ts — covered by booking.service.admin.spec.ts (+1984 lines)"
    - End with: "Run /coverit:check to execute the existing test suites and confirm they pass."
  If skipped entries do NOT mention coverage (only configs/DTOs/etc.), show:
    "No testable changes found — all changes are configs, DTOs, schemas, or module wiring."
    Then add: "Tip: Use /coverit:scan --all for a full project coverage audit."
```

**CRITICAL**: The sub-agent MUST use the `mcp__plugin_coverit_coverit__coverit_analyze` MCP tool. It must NOT use the `coverit` CLI binary, shell commands, or `gh` to fetch diffs manually.

## Display

Show the sub-agent's formatted summary to the user. Do NOT expand or re-process the raw JSON.
