# coverit

**Your code, covered. One command.**

<!-- badges -->
[![Version](https://img.shields.io/npm/v/@devness/coverit)](https://www.npmjs.com/package/@devness/coverit)
[![License](https://img.shields.io/npm/l/@devness/coverit)](https://opensource.org/licenses/MIT)
[![Downloads](https://img.shields.io/npm/dm/@devness/coverit)](https://www.npmjs.com/package/@devness/coverit)

## What is coverit?

coverit is an AI-powered test generation and execution platform. It analyzes your code changes, determines what tests are needed, generates them, runs them, and reports the results. One command: `coverit run`.

## Quick Start

```bash
# Install globally
npm install -g @devness/coverit

# Or run with npx (no install)
npx @devness/coverit run

# Scan first (dry run)
coverit scan

# Full pipeline
coverit run
```

## Features

- **Smart diff analysis** -- parses git diffs to identify exactly what changed: new endpoints, modified functions, added components.
- **Automatic test strategy** -- decides which test types to generate (unit, API, E2E, mobile, desktop) based on file types and framework detection.
- **Multi-framework support** -- generates tests for Vitest, Jest, Playwright, Detox, and more, using the correct idioms for each.
- **Framework detection** -- identifies Hono, Express, NestJS, React, Expo, Tauri, and other frameworks from your project config.
- **Parallel execution** -- organizes tests into execution phases and runs independent plans concurrently.
- **Coverage tracking** -- collects line, branch, function, and statement coverage from test runners.
- **MCP integration** -- use coverit directly inside Claude Code as a set of MCP tools.
- **Local + Cloud** -- execute tests locally or in cloud sandboxes (E2B, Docker, Hetzner).

## How It Works

```
git diff → analyze → strategize → generate → execute → report
```

| Step | What happens |
|------|-------------|
| **Diff** | Parses git changes to identify modified files, hunks, and line ranges. |
| **Analyze** | Scans source code to extract functions, classes, endpoints, components, and dependencies. |
| **Strategize** | Builds a `TestStrategy` with prioritized `TestPlan` items and phased execution order. |
| **Generate** | Produces test files using framework-specific generators (unit, API, E2E, mobile, desktop). |
| **Execute** | Runs generated tests via local runners, browsers, simulators, or cloud sandboxes. |
| **Report** | Aggregates results into a `CoveritReport` with pass/fail counts, coverage, and failure details. |

## CLI Reference

| Command | Description |
|---------|-------------|
| `coverit scan [path]` | Analyze changes and display the test strategy without generating or running tests. |
| `coverit generate [path]` | Generate test files based on the analysis, but do not execute them. |
| `coverit run [path]` | Full pipeline: analyze, generate, execute, and report. |
| `coverit report` | Display the results of the last run. |

## CLI Options

| Option | Description |
|--------|-------------|
| `--type <type>` | Restrict to a specific test type: `unit`, `api`, `e2e-browser`, `e2e-mobile`, `e2e-desktop`. |
| `--env <env>` | Execution environment: `local`, `cloud-sandbox`, `browser`, `mobile-simulator`, `desktop-app`. |
| `--coverage` | Collect coverage data during execution. |
| `--dry-run` | Show what would happen without writing files or running tests. |
| `--verbose` | Enable debug-level logging (`COVERIT_DEBUG=1`). |

## MCP Integration

Add coverit as an MCP server in your Claude Code config:

```json
{
  "mcpServers": {
    "coverit": {
      "command": "npx",
      "args": ["@devness/coverit", "mcp"]
    }
  }
}
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `coverit_analyze` | Analyze code changes and return the test strategy. |
| `coverit_generate` | Generate test files from a strategy. |
| `coverit_run` | Execute generated tests and return results. |
| `coverit_full` | Full pipeline: analyze, generate, execute, report. |

## Supported Frameworks

| Category | Frameworks |
|----------|-----------|
| API | Hono, Express, NestJS, Fastify |
| Frontend | React, Next.js |
| Mobile | React Native, Expo |
| Desktop | Tauri, Electron |
| Test Runners | Vitest, Jest, Playwright, Detox, Pytest |
| Package Managers | Bun, pnpm, npm, yarn |

## Architecture

```
┌──────────────┐
│  CLI / MCP   │  ← Entry points
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Orchestrator  │  ← Coordinates pipeline
└──────┬───────┘
       │
       ├──────────────┬──────────────┐
       ▼              ▼              ▼
┌────────────┐ ┌───────────┐ ┌────────────┐
│  Analysis   │ │ Generators │ │  Executors  │
│  Engine     │ │            │ │             │
│ - Diff      │ │ - Unit     │ │ - Local     │
│ - Scanner   │ │ - API      │ │ - Cloud     │
│ - Deps      │ │ - E2E      │ │ - Browser   │
│ - Strategy  │ │ - Mobile   │ │ - Simulator │
└────────────┘ │ - Desktop  │ └──────┬──────┘
               └───────────┘        │
                                    ▼
                             ┌────────────┐
                             │  Reporter   │
                             └────────────┘
```

See [docs/architecture.md](docs/architecture.md) for a detailed breakdown.

## Configuration

Create a `coverit.config.ts` in your project root:

```ts
import { defineConfig } from "coverit";

export default defineConfig({
  projectRoot: ".",
  testTypes: ["unit", "api", "e2e-browser"],
  environment: "local",
  coverageThreshold: 80,
});
```

See [docs/configuration.md](docs/configuration.md) for all options.

## Roadmap

- Cloud execution (E2B, Docker)
- AI-powered test refinement on failure
- PR comment integration (GitHub Actions)
- VS Code extension
- Coverage trend tracking across runs

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[MIT](LICENSE)
