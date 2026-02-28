# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.3] - 2026-02-14

### Added
- `run` command — run existing tests, AI fixes failures, rescan and update score
- AI run prompts (`src/ai/run-prompts.ts`)
- Run pipeline (`src/run/pipeline.ts`)

### Changed
- Renamed `analyze` command to `scan` across CLI, MCP, and skill files
- Updated MCP server to 7 tools (added `coverit_run`)
- Updated CLI to 5 commands (added `run`)

## [0.5.0] - 2026-02-10

### Added
- Initial public release
- `scan` command — AI-driven codebase analysis creating `coverit.json`
- `cover` command — AI generates tests from coverage gaps
- `status` command — instant quality dashboard from `coverit.json`
- `clear` command — reset manifest and working directory
- MCP server with 6 tools (scan, cover, status, clear, backup, restore)
- CLI with 4 commands
- Claude Code plugin with slash commands
- 6 AI providers: Claude CLI, Gemini CLI, Codex CLI, Anthropic API, OpenAI API, Ollama
- Quality scoring across 5 ISO 25010 dimensions
- Testing Diamond strategy (Integration 50%, Unit 20%, API 15%, E2E 10%, Contract 5%)

[0.5.3]: https://github.com/devness-com/coverit/releases/tag/v0.5.3
[0.5.0]: https://github.com/devness-com/coverit/releases/tag/v0.5.0
