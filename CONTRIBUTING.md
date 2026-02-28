# Contributing to coverit

Thanks for your interest in contributing to coverit! Whether it's a bug report, feature request, documentation improvement, or code contribution, we appreciate your help.

## Prerequisites

- [Bun](https://bun.sh/) 1.1+
- TypeScript 5.7+
- Git

## Getting Started

```bash
# Fork and clone the repository
git clone https://github.com/<your-username>/coverit.git
cd coverit

# Install dependencies
bun install

# Build
bun run build

# Run tests
bun run test

# Type check
bun run typecheck
```

## Project Structure

coverit is a single-package TypeScript project with 31 source files:

```
src/
├── ai/                        AI providers and prompts
│   ├── types.ts               AIProvider, AIMessage, AIResponse interfaces
│   ├── provider-factory.ts    Auto-detects best available AI provider
│   ├── claude-cli-provider.ts Claude CLI (claude --print)
│   ├── gemini-cli-provider.ts Gemini CLI
│   ├── codex-cli-provider.ts  Codex CLI
│   ├── anthropic-provider.ts  Anthropic API
│   ├── openai-provider.ts     OpenAI API
│   ├── ollama-provider.ts     Ollama (local)
│   ├── scale-prompts.ts       Prompts for codebase scanning
│   ├── cover-prompts.ts       Prompts for test generation
│   └── run-prompts.ts         Prompts for test run + fix
├── scale/                     Codebase scanning
│   ├── analyzer.ts            analyzeCodebase() → CoveritManifest
│   └── writer.ts              readManifest(), writeManifest()
├── cover/                     Test generation pipeline
│   └── pipeline.ts            cover() → CoverResult
├── run/                       Test run + fix pipeline
│   └── pipeline.ts            run() → RunResult
├── measure/                   Test scanning and scoring
│   ├── scanner.ts             Filesystem test file scanner
│   ├── scorer.ts              rescoreManifest()
│   └── dashboard.ts           Terminal dashboard renderer
├── scoring/                   Score calculation
│   ├── engine.ts              calculateScore(), complexity-weighted
│   ├── weights.ts             Dimension and test type weights
│   └── thresholds.ts          Gap severity thresholds
├── schema/                    coverit.json schema
│   ├── coverit-manifest.ts    Full TypeScript types for the manifest
│   └── defaults.ts            Default dimensions, expected test counts
├── types/
│   └── index.ts               Core types (Language, Framework, etc.)
├── utils/
│   ├── logger.ts              Structured logging
│   └── framework-detector.ts  Project info detection
├── mcp/
│   └── server.ts              MCP server (7 tools)
├── cli/
│   └── index.ts               CLI (5 commands)
├── mcp-setup/
│   └── index.ts               Plugin setup wizard
├── entry.ts                   Unified entry point
└── index.ts                   Public API exports
```

## Development Workflow

1. **Pick an area to work on.** Most contributions will touch `src/ai/`, `src/scale/`, `src/cover/`, `src/run/`, or `src/measure/`.

2. **Run in dev mode:**
   ```bash
   bun run dev          # TypeScript watch mode
   bun run cli          # Run CLI locally
   bun run mcp          # Run MCP server locally
   ```

3. **Run tests:**
   ```bash
   bun run test         # Run all tests (Vitest)
   bun run test:watch   # Watch mode
   ```

4. **Type check and lint:**
   ```bash
   bun run typecheck    # TypeScript strict mode
   bun run lint         # ESLint
   bun run format       # Prettier
   ```

## Code Conventions

- **Strict TypeScript** — `strict: true` in tsconfig. No `any` unless interfacing with external untyped data.
- **ESM imports** — always use `.js` extensions in import paths (e.g., `./base.js`).
- **No console.log** — use `logger` from `src/utils/logger.ts` in library code. `console` is only for the CLI layer.
- **Types in `src/types/`** — shared interfaces and type aliases live in `src/types/index.ts`.
- **Formatting** — run `bun run format` (Prettier) before committing.
- **Linting** — run `bun run lint` (ESLint) before committing.

## Submitting a Pull Request

1. **Fork** the repository and create a feature branch from `main`:
   ```bash
   git checkout -b feat/your-feature-name
   ```

2. **Make your changes.** Keep commits focused and descriptive.

3. **Test your changes:**
   ```bash
   bun run test
   bun run typecheck
   bun run lint
   ```

4. **Push** your branch and open a Pull Request against `main`.

5. In your PR description, include:
   - What the change does and why
   - How to test it

6. A maintainer will review your PR. We aim to respond within a few days.

## Reporting Issues

When filing an issue, please include:

- A clear, descriptive title
- Steps to reproduce the problem
- Expected vs. actual behavior
- Your environment (OS, Node.js version, AI tool being used)
- Relevant logs or error messages

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). By participating, you are expected to uphold this code. Please report unacceptable behavior to the maintainers.

## Questions?

If you have questions or want to discuss a larger change before working on it, open a [Discussion](https://github.com/devness-com/coverit/discussions) or file an issue. We're happy to help you get started.
