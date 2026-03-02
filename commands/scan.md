---
description: "AI-driven codebase scan and analysis — creates coverit.json quality manifest"
---

# Coverit Scan

AI scans and analyzes the project with tool access (Glob, Grep, Read, Bash) to create the `coverit.json` quality manifest. Discovers modules, maps existing tests, classifies complexity, identifies user journeys and API contracts.

**Auto-incremental behavior:**
- **First scan**: Performs a full codebase scan and records the current git commit in `coverit.json` (`lastScanCommit`).
- **Subsequent scans**: Automatically detects changes since the last scan (via git commit tracking) and only re-analyzes affected modules. This makes repeated scans much faster.
- **Force full rescan**: Use the `--full` flag (CLI) or `full: true` (MCP) to force a complete rescan of the entire codebase, ignoring the last scan commit.

Full scans are heavy operations — the AI thoroughly explores and analyzes the entire codebase. They may take several minutes for large projects. Incremental scans are significantly faster.

## IMPORTANT: Run via sub-agent to protect context

The scan produces a large manifest. **You MUST delegate this to a sub-agent** using the Task tool.

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current working directory)
- `--full` - Force a full rescan (optional, defaults to incremental if a previous scan exists)

## Execution

First, tell the user:

```
Scanning and analyzing codebase. This may take a few minutes...
```

Use the Task tool with `subagent_type: "general-purpose"` and a prompt like:

```
Call the `mcp__plugin_coverit_coverit__coverit_scan` MCP tool with:
{
  "projectRoot": "<absolute path>"
}

If the user passed --full, also include "full": true in the parameters.

The response JSON includes:
- "project": { name, framework, testFramework, language, sourceFiles, sourceLines }
- "modules": array of { path, files, lines, complexity, functionality.tests }
- "journeys": array of { id, name, steps, covered, testFile }
- "contracts": array of { endpoint, method, requestSchema, responseSchema, covered, testFile }
- "score": { overall, breakdown, gaps, history }

Format the response as a readable dashboard:

coverit -- Quality Score: <overall>/100

Project
  Name: <name>
  Framework: <framework> (<language>)
  Test Framework: <testFramework>
  Source: <sourceFiles> files, <sourceLines> lines

Dimensions (show score/100 for each, "pending" if unscanned)
  Functionality, Security, Stability, Conformance, Regression

Gaps (<total> total, <critical> critical)
  Top 8 gaps sorted by severity.

Modules (<count>)
  Table: Module | Cmplx | Unit | Intg | API | E2E | Cntr
  Show current/expected (e.g. 3/5). Show "-" for no expected coverage.

Journeys (<count>) — list with covered/uncovered status
Contracts (<count>) — list with covered/uncovered status

Summary
  Total modules: N
  Manifest: coverit.json
  Next step: "Run /coverit:cover to generate tests and improve your score."
```

**CRITICAL**: The sub-agent MUST use the `mcp__plugin_coverit_coverit__coverit_scan` MCP tool to scan and analyze the codebase.

## Display

Show the sub-agent's formatted dashboard. Do NOT re-process the raw JSON.
