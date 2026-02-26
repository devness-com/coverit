---
description: "Generate or regenerate coverit.json from full codebase analysis"
---

# Coverit Scale

Generate or regenerate the `coverit.json` manifest from a full codebase analysis. This discovers all modules, maps existing tests, classifies complexity, calculates expected test counts, and produces a complete quality baseline.

This is a heavy operation that analyzes the entire codebase. It may take a few minutes for large projects.

## IMPORTANT: Run via sub-agent to protect context

The analysis produces a large manifest (modules, dimensions, scores, gaps). **You MUST delegate this to a sub-agent** using the Task tool to avoid filling up the main conversation context.

## Arguments

Parse from user input:
- `[path]` - Project root path (defaults to current working directory)

## Execution

First, warn the user:

```
Starting full codebase analysis. This may take a few minutes for large projects...
```

Use the Task tool with `subagent_type: "general-purpose"` and a prompt like:

```
Call the `mcp__plugin_coverit_coverit__coverit_scale` MCP tool with:
{
  "projectRoot": "<absolute path>"
}

The response JSON is a full CoveritManifest including:
- "project": { name, framework, testFramework, language, sourceFiles, sourceLines }
- "modules": array of { path, files, lines, complexity, functionality.tests }
- "score": { overall, breakdown (5 dimensions), gaps, history }

Format the response as a readable dashboard:

coverit -- Quality Score: <overall>/100

Project
  Name: <name>
  Framework: <framework> (<language>)
  Test Framework: <testFramework>
  Source: <sourceFiles> files, <sourceLines> lines

Dimensions
  Functionality   <score>/100  <bar>
  Security        <score>/100  <bar>
  Stability       <score>/100  <bar>
  Conformance     <score>/100  <bar>
  Regression      <score>/100  <bar>

Gaps (<total> total, <critical> critical)
  List top 8 gaps sorted by severity (critical > high > medium > low).
  For each: dimension, description, severity indicator.
  If there are more than 8, note how many remain.

Modules (<count>)
  Table with columns: Module | Cmplx | Unit | Intg | API | E2E | Cntr | Score
  Show current/expected for each test type (e.g. 3/5).
  Show "-" for test types with no expected coverage.

Summary
  Total modules analyzed: N
  Manifest written to: coverit.json
  Note: "Security, stability, and conformance dimensions are initialized with placeholder scores. Run /coverit:full to populate them with AI analysis."
```

**CRITICAL**: The sub-agent MUST use the `mcp__plugin_coverit_coverit__coverit_scale` MCP tool. It must NOT use the CLI, shell commands, or attempt to analyze the codebase manually.

## Display

Show the sub-agent's formatted dashboard to the user. Do NOT expand or re-process the raw JSON.

If the tool returns an error, show the error message and suggest:
- Check that the path is a valid project root
- Ensure the project has source files (not just configs)
- Try running from the project root directory
