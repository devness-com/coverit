---
description: "AI-driven codebase scan and analysis — creates coverit.json quality manifest"
---

# Coverit Scan

AI scans and analyzes the project with tool access (Glob, Grep, Read, Bash) to create the `coverit.json` quality manifest. Discovers modules, maps existing tests, classifies complexity, identifies user journeys and API contracts.

This is a heavy operation — the AI thoroughly explores and analyzes the entire codebase. It may take several minutes for large projects.

## IMPORTANT: Run via sub-agent to protect context

The scan produces a large manifest. **You MUST delegate this to a sub-agent** using the Task tool.

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current working directory)

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
