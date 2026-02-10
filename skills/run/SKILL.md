---
name: coverit-run
description: Run the full coverit pipeline — analyze, generate, execute tests, and report
user_invocable: true
arguments:
  - name: path
    description: Project root path (defaults to current directory)
    required: false
---

Use the `coverit_full` MCP tool to run the complete pipeline: analyze, generate tests, execute them, and produce a report.

Pass the `projectRoot` as an absolute path. If the user specified flags like `--base`, `--staged`, `--commit`, `--pr`, or `--files`, pass the corresponding parameters to the tool.

Display the results showing:
- Summary: status, total tests, passed, failed, skipped, errors
- Coverage data if available
- Duration
- Any test failures with details
