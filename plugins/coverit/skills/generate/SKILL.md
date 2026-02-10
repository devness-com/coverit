---
name: coverit-generate
description: Analyze a codebase and generate test files without running them
user_invocable: true
arguments:
  - name: path
    description: Project root path (defaults to current directory)
    required: false
---

Use the `coverit_generate` MCP tool to analyze the project and generate test files.

Pass the `projectRoot` as an absolute path. If the user specified flags like `--base`, `--staged`, `--commit`, `--pr`, or `--files`, pass the corresponding parameters to the tool.

Display the results showing:
- Generated test files and their plan IDs
- Test counts per plan
- Location of generated files (.coverit/generated/)
