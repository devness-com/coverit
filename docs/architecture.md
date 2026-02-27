# Architecture

coverit is built on a 3-command architecture centered around `coverit.json` as the single source of truth.

## Overview

```
CLI / MCP
    │
    ├── analyze ──→ AI explores codebase with tools ──→ creates coverit.json
    │
    ├── cover ────→ reads coverit.json gaps ──→ AI writes + runs + fixes tests ──→ updates coverit.json
    │
    └── status ───→ reads coverit.json ──→ renders dashboard (instant, no AI)
```

## Source Layout (29 files)

```
src/
├── ai/                        AI providers and prompts
│   ├── types.ts               AIProvider, AIMessage, AIResponse interfaces
│   ├── provider-factory.ts    Auto-detects best AI provider
│   ├── claude-cli-provider.ts Claude CLI (`claude --print`)
│   ├── gemini-cli-provider.ts Gemini CLI
│   ├── codex-cli-provider.ts  Codex CLI
│   ├── anthropic-provider.ts  Anthropic API
│   ├── openai-provider.ts     OpenAI API
│   ├── ollama-provider.ts     Ollama (local)
│   ├── scale-prompts.ts       Prompts for codebase analysis
│   └── cover-prompts.ts       Prompts for test generation
├── scale/                     Codebase analysis
│   ├── analyzer.ts            analyzeCodebase() → CoveritManifest
│   └── writer.ts              readManifest(), writeManifest()
├── cover/                     Test generation pipeline
│   └── pipeline.ts            cover() → CoverResult
├── measure/                   Test scanning and scoring
│   ├── scanner.ts             Filesystem test file scanner
│   ├── scorer.ts              rescoreManifest()
│   └── dashboard.ts           Terminal dashboard renderer
├── scoring/                   Score calculation
│   ├── engine.ts              calculateScore(), complexity-weighted scoring
│   ├── weights.ts             Dimension and test type weights
│   └── thresholds.ts          Gap severity thresholds
├── schema/                    coverit.json schema
│   ├── coverit-manifest.ts    Full TypeScript types for the manifest
│   └── defaults.ts            Default dimensions, expected test counts
├── types/
│   └── index.ts               Core types (Language, Framework, TestFramework, etc.)
├── utils/
│   ├── logger.ts              Structured logging
│   └── framework-detector.ts  Project info detection from package.json
├── mcp/
│   └── server.ts              MCP server (6 tools)
├── cli/
│   └── index.ts               CLI (4 commands)
├── mcp-setup/
│   └── index.ts               Plugin setup wizard
├── entry.ts                   Unified entry point
└── index.ts                   Public API exports
```

## Data Flow

### Analyze

```
detectProjectInfo()          Fast, deterministic — reads package.json
        │
        ▼
AI provider.generate()       AI with tool access (Glob, Grep, Read, Bash)
        │                    Explores codebase autonomously
        ▼
parseScaleResponse()         Extracts structured JSON from AI output
        │
        ▼
calculateScore()             Scores modules, identifies gaps
        │
        ▼
writeManifest()              Writes coverit.json
```

### Cover

```
readManifest()               Read coverit.json
        │
        ▼
identifyGaps()               Find modules where expected > current
        │
        ▼
AI provider.generate()       For each gap: AI writes tests, runs them, fixes failures
        │                    Tools: Read, Glob, Grep, Bash, Write, Edit
        ▼
scanTests()                  Rescan filesystem for new test files
        │
        ▼
rescoreManifest()            Recalculate quality score
        │
        ▼
writeManifest()              Update coverit.json with new scores
```

### Status

```
readManifest()               Read coverit.json
        │
        ▼
renderDashboard()            Terminal output: score, dimensions, gaps, modules
```

## Key Interfaces

### CoveritManifest

The root type for `coverit.json`. Defined in `src/schema/coverit-manifest.ts`.

```typescript
interface CoveritManifest {
  version: string;
  generatedAt: string;
  project: ManifestProject;
  modules: ModuleEntry[];
  journeys: JourneyEntry[];
  contracts: ContractEntry[];
  score: ScoreResult;
}
```

### AIProvider

The interface all AI providers implement. Defined in `src/ai/types.ts`.

```typescript
interface AIProvider {
  generate(messages: AIMessage[], options?: AIGenerateOptions): Promise<AIResponse>;
}
```

The `AIGenerateOptions.allowedTools` parameter enables AI to use Claude Code tools (Read, Glob, Grep, Bash, Write, Edit) during generation.

### CoverResult

Returned by the cover pipeline. Defined in `src/cover/pipeline.ts`.

```typescript
interface CoverResult {
  scoreBefore: number;
  scoreAfter: number;
  modulesProcessed: number;
  testsGenerated: number;
  testsPassed: number;
  testsFailed: number;
}
```

## MCP Tools

| Tool | Description | AI Cost |
|------|-------------|---------|
| `coverit_analyze` | AI explores codebase → coverit.json | High |
| `coverit_cover` | AI generates tests from gaps → updates score | High |
| `coverit_status` | Shows dashboard from coverit.json | None |
| `coverit_clear` | Deletes coverit.json and .coverit/ | None |
| `coverit_backup` | Exports coverit.json | None |
| `coverit_restore` | Imports coverit.json from backup | None |

## AI Provider Detection

The provider factory (`src/ai/provider-factory.ts`) auto-detects the best available AI provider:

1. **Claude CLI** — `claude --print` (preferred, supports tool access)
2. **Gemini CLI** — `gemini` CLI
3. **Codex CLI** — `codex` CLI
4. **Anthropic API** — `ANTHROPIC_API_KEY`
5. **OpenAI API** — `OPENAI_API_KEY`
6. **Ollama** — local Ollama instance

Tool access (`allowedTools`) is only supported by the Claude CLI provider.
