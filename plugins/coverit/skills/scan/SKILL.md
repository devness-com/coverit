---
name: coverit-scan
description: Analyze a codebase and display the test strategy without generating or running tests
user_invocable: true
arguments:
  - name: path
    description: Project root path (defaults to current directory)
    required: false
---

Use the `coverit_analyze` MCP tool to analyze the project at the given path (or the current working directory if no path is provided).

Pass the `projectRoot` as an absolute path. If the user specified flags like `--base`, `--staged`, `--commit`, `--pr`, or `--files`, pass the corresponding parameters to the tool.

Display the results in a clear, readable format showing:
- Project info (framework, language, test framework)
- Test plans with priorities and estimated test counts
- Total estimated tests and execution phases
