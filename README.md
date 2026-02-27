# coverit

**Your code, covered. AI-powered test quality.**

<!-- badges -->
[![Version](https://img.shields.io/npm/v/@devness/coverit)](https://www.npmjs.com/package/@devness/coverit)
[![License](https://img.shields.io/npm/l/@devness/coverit)](https://opensource.org/licenses/MIT)
[![Downloads](https://img.shields.io/npm/dm/@devness/coverit)](https://www.npmjs.com/package/@devness/coverit)

## What is coverit?

coverit is an AI-powered test quality platform. It analyzes your entire codebase, identifies coverage gaps across 5 quality dimensions, generates tests to fill them, and tracks your score over time — all through a single persistent manifest: `coverit.json`.

Three commands. That's it.

## Quick Start

```bash
# Install as a Claude Code plugin
npx @devness/coverit mcp

# Or use directly via CLI
npx @devness/coverit analyze    # AI explores your codebase → creates coverit.json
npx @devness/coverit cover      # AI writes tests for gaps → updates your score
npx @devness/coverit status     # Show your quality dashboard
```

## How It Works

```
analyze → coverit.json → cover → updated coverit.json → status
```

| Command | What happens |
|---------|-------------|
| **analyze** | AI explores your codebase with tool access (read files, search code, run commands). Discovers modules, maps existing tests, classifies complexity, identifies user journeys and API contracts. Produces `coverit.json`. |
| **cover** | AI reads gaps from `coverit.json`, writes test files for each module, runs them, fixes failures, and updates the quality score. |
| **status** | Instantly displays your quality dashboard from `coverit.json`. No AI, no scanning. |

### The Manifest: `coverit.json`

`coverit.json` is the single source of truth. It's git-tracked, persistent, and contains:

- **Project info** — framework, language, test runner, file/line counts
- **Modules** — each source directory with complexity, file counts, and test coverage (current vs expected)
- **Quality score** — 0-100, weighted across 5 dimensions (ISO 25010)
- **Gaps** — what's missing, ranked by severity
- **Journeys** — user flows that need E2E coverage
- **Contracts** — API endpoints that need contract tests

## CLI Reference

| Command | Description |
|---------|-------------|
| `coverit analyze [path]` | AI analyzes codebase and creates `coverit.json` |
| `coverit cover [path]` | AI generates tests from gaps and updates score |
| `coverit status [path]` | Show quality dashboard from `coverit.json` |
| `coverit clear [path]` | Delete `coverit.json` and `.coverit/` for a fresh start |

### Cover Options

| Option | Description |
|--------|-------------|
| `--modules <paths>` | Only cover specific modules (comma-separated) |

## Claude Code Integration

coverit works as a Claude Code plugin with slash commands:

| Command | Description |
|---------|-------------|
| `/coverit:analyze` | AI analyzes codebase and creates `coverit.json` |
| `/coverit:cover` | AI generates tests from gaps and updates score |
| `/coverit:status` | Show quality dashboard |

### Setup

```bash
npx @devness/coverit mcp
```

This adds coverit as an MCP server to your Claude Code config.

### MCP Tools

| Tool | Description |
|------|-------------|
| `coverit_analyze` | AI analyzes codebase → `coverit.json` |
| `coverit_cover` | AI generates tests from gaps → updates score |
| `coverit_status` | Show quality dashboard (instant, no AI) |
| `coverit_clear` | Delete `coverit.json` and `.coverit/` |
| `coverit_backup` | Export `coverit.json` as JSON |
| `coverit_restore` | Import `coverit.json` from backup |

## Quality Dimensions

coverit measures quality across 5 dimensions mapped to ISO 25010:

| Dimension | What it checks |
|-----------|---------------|
| **Functionality** | Unit, integration, API, E2E, and contract test coverage |
| **Security** | OWASP Top 10, injection, auth bypass, data exposure |
| **Stability** | Error handling, edge cases, resource cleanup |
| **Conformance** | Naming conventions, patterns, architectural rules |
| **Regression** | Baseline test results, breaking changes |

### Testing Diamond

coverit follows the Testing Diamond strategy (not the outdated Testing Pyramid):

| Test Type | Target % | Purpose |
|-----------|----------|---------|
| Integration | ~50% | Module boundaries, real dependencies |
| Unit | ~20% | Pure functions, algorithms, edge cases |
| API | ~15% | HTTP endpoints, request/response contracts |
| E2E | ~10% | Critical user journeys |
| Contract | ~5% | API schema validation |

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
│  CLI / MCP   │  ← Entry points (3 commands)
└──────┬───────┘
       │
       ├── analyze ──→ AI with tool access ──→ coverit.json
       │
       ├── cover ────→ AI reads gaps ──→ writes tests ──→ runs ──→ updates coverit.json
       │
       └── status ───→ reads coverit.json ──→ dashboard
```

```
src/
├── ai/           AI providers (Claude, Gemini, Codex, Anthropic, OpenAI, Ollama)
├── scale/        Codebase analyzer + manifest writer
├── cover/        Test generation pipeline
├── measure/      Test scanner, scorer, dashboard
├── scoring/      Score engine, weights, thresholds
├── schema/       coverit.json types + defaults
├── types/        Core type definitions
├── utils/        Logger, framework detector
├── mcp/          MCP server (6 tools)
└── cli/          CLI (4 commands)
```

See [docs/architecture.md](docs/architecture.md) for details.

## License

[MIT](LICENSE)
