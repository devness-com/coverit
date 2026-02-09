# Architecture

coverit is organized into six modules that form a linear pipeline. Each module has a clear input/output contract defined by the types in `src/types/index.ts`.

## Module Overview

```
CLI / MCP
    │
    ▼
Orchestrator
    │
    ├── Analysis Engine
    │     ├── diff-analyzer    DiffResult
    │     ├── code-scanner     CodeScanResult[]
    │     ├── dependency-graph DependencyGraph
    │     └── strategy-planner TestStrategy
    │
    ├── Generators
    │     ├── unit-generator
    │     ├── api-generator
    │     ├── e2e-generator
    │     ├── mobile-generator
    │     └── desktop-generator
    │
    ├── Executors
    │     ├── local-runner
    │     ├── cloud-runner
    │     ├── browser-runner
    │     └── simulator-runner
    │
    └── Reporter
```

## Data Flow

Types flow through the pipeline in a strict sequence:

```
DiffResult
    │  analyzeDiff() parses git changes into structured file metadata
    ▼
CodeScanResult[]
    │  scanCode() extracts functions, classes, endpoints, components
    ▼
DependencyGraph
    │  buildDependencyGraph() maps import relationships between files
    ▼
TestStrategy
    │  planStrategy() produces TestPlan items with priorities and phases
    ▼
GeneratedTest[]
    │  generators produce test file content for each plan
    ▼
ExecutionResult[]
    │  executors run tests and collect pass/fail/coverage data
    ▼
CoveritReport
       reporter aggregates results into a final summary
```

## Modules

### Analysis Engine (`src/analysis/`)

The analysis engine transforms raw git state into a structured test strategy.

**diff-analyzer.ts** -- Uses `simple-git` to parse `git diff` output. Produces a `DiffResult` containing `ChangedFile[]` with per-file metadata: path, status (added/modified/deleted/renamed), line-level hunks, detected language, and classified file type (api-route, react-component, service, etc.). File type detection uses ordered regex rules against the file path.

**code-scanner.ts** -- Uses `ts-morph` to parse source files and extract their structure: exported symbols, imports, functions (with params, return types, complexity), classes, API endpoints, and React components. Produces `CodeScanResult[]`.

**dependency-graph.ts** -- Builds a `DependencyGraph` (a `Map<string, DependencyNode>`) from import statements. Each node tracks what it depends on and what depends on it. Used by the strategy planner to determine test scope -- if a utility changes, tests for all its consumers may be needed.

**strategy-planner.ts** -- Takes the diff, scan results, and dependency graph to produce a `TestStrategy`. This includes `TestPlan` items (what to test, what type, priority, estimated test count) and `ExecutionPhase` items (which plans run in parallel, in what environment).

### Generators (`src/generators/`)

Each generator extends `BaseGenerator` and implements a single method:

```ts
abstract generate(context: GeneratorContext): Promise<GeneratorResult>;
```

The `GeneratorContext` provides the test plan, project info, scan results, and existing test contents (for deduplication).

**BaseGenerator** provides shared helpers:
- `buildImports()` -- framework-specific import statements (Vitest, Jest, Playwright, Detox)
- `buildDescribeBlock()` / `buildTestCase()` -- test structure builders
- `generateTestFileName()` -- naming convention per test type (`.test.ts`, `.api.test.ts`, `.e2e.test.ts`, etc.)
- `isAlreadyTested()` -- checks if a target is already covered by existing tests
- `sampleValueForType()` -- generates sample values for TypeScript types
- `assembleTestFile()` -- combines header, imports, and test body into a complete file

**Concrete generators:**
- `UnitGenerator` -- tests for exported functions and class methods
- `ApiGenerator` -- tests for HTTP endpoints using supertest-style requests
- `E2eGenerator` -- browser tests using Playwright
- `MobileGenerator` -- mobile tests using Detox
- `DesktopGenerator` -- desktop app tests for Tauri/Electron windows

### Executors (`src/executors/`)

Each executor extends `BaseExecutor` and implements:

```ts
abstract execute(test: GeneratedTest, config: ExecutionConfig): Promise<ExecutionResult>;
```

**BaseExecutor** provides:
- `withTimeout()` -- wraps execution in a timeout race
- `withRetry()` -- retry with exponential backoff (200ms, 400ms, 800ms...)
- `parseJsonOutput()` -- extracts JSON from mixed test runner stdout
- `parseCoverage()` -- normalizes Istanbul/v8 coverage JSON into `CoverageResult`
- `createBaseResult()` -- scaffolds an `ExecutionResult` with safe defaults

**Concrete executors:**
- `LocalRunner` -- spawns the test runner process locally (Vitest, Jest, Playwright CLI)
- `CloudRunner` -- provisions a cloud sandbox (E2B, Docker, Hetzner), uploads test files, runs remotely
- `BrowserRunner` -- manages browser lifecycle for E2E tests
- `SimulatorRunner` -- manages iOS simulator or Android emulator for mobile tests

### Orchestrator (`src/orchestrator.ts`)

The orchestrator is the central coordinator. It:

1. Calls the analysis engine to produce a `TestStrategy`
2. Dispatches each `TestPlan` to the appropriate generator
3. Organizes execution by phase, running plans within a phase in parallel
4. Collects results and passes them to the reporter
5. Emits `CoveritEvent` events for progress tracking

The orchestrator accepts a `CoveritConfig` and a `CoveritEventHandler` callback.

### MCP Server (`src/mcp/`)

Exposes coverit as an MCP (Model Context Protocol) server with four tools:

| Tool | Pipeline Steps |
|------|---------------|
| `coverit_analyze` | diff + scan + strategy |
| `coverit_generate` | diff + scan + strategy + generate |
| `coverit_run` | diff + scan + strategy + generate + execute |
| `coverit_full` | full pipeline including report |

Built on `@modelcontextprotocol/sdk`. The MCP server accepts tool calls, runs the orchestrator, and returns structured results.

### CLI (`src/cli/`)

Built with `commander` for command parsing, `chalk` for colored output, and `ora` for spinners. Maps CLI commands to orchestrator calls:

- `coverit scan` -- runs analysis, prints the strategy
- `coverit generate` -- runs analysis + generation, writes test files
- `coverit run` -- full pipeline
- `coverit report` -- reads and displays the last saved report

## Directory Structure

```
src/
├── analysis/
│   ├── diff-analyzer.ts      git diff parsing
│   ├── code-scanner.ts       source code analysis (ts-morph)
│   ├── dependency-graph.ts   import graph builder
│   ├── strategy-planner.ts   test strategy planner
│   └── index.ts              barrel export
├── generators/
│   ├── base-generator.ts     abstract base + helpers
│   ├── unit-generator.ts     unit test generator
│   ├── api-generator.ts      API test generator
│   ├── e2e-generator.ts      browser E2E generator
│   ├── mobile-generator.ts   mobile test generator
│   ├── desktop-generator.ts  desktop test generator
│   └── index.ts              barrel export
├── executors/
│   ├── base-executor.ts      abstract base + helpers
│   ├── local-runner.ts       local process execution
│   ├── cloud-runner.ts       cloud sandbox execution
│   ├── browser-runner.ts     browser lifecycle
│   ├── simulator-runner.ts   mobile simulator
│   └── index.ts              barrel export
├── agents/                   agent coordination (multi-plan parallel execution)
├── mcp/
│   └── server.ts             MCP server entry point
├── cli/
│   └── index.ts              CLI entry point
├── types/
│   └── index.ts              all type definitions
├── utils/
│   └── logger.ts             structured logging
├── orchestrator.ts           pipeline coordinator
└── reporter.ts               result aggregation
```

## Extension Guide

### Adding a New Generator

1. Create `src/generators/my-generator.ts`
2. Extend `BaseGenerator`:

```ts
import type { GeneratorContext, GeneratorResult } from "../types/index.js";
import { BaseGenerator } from "./base-generator.js";

export class MyGenerator extends BaseGenerator {
  async generate(context: GeneratorContext): Promise<GeneratorResult> {
    const { plan, project, scanResults, existingTests } = context;
    const tests = [];

    for (const file of plan.target.files) {
      const scan = scanResults.find((s) => s.file === file);
      if (!scan) continue;

      // Build test cases for each function
      for (const fn of scan.functions) {
        if (this.isAlreadyTested(fn.name, existingTests)) continue;

        const testBody = this.buildTestCase(
          `should handle ${fn.name}`,
          `const result = ${fn.name}();\nexpect(result).toBeDefined();`
        );

        tests.push({
          planId: plan.id,
          filePath: this.generateTestFileName(file, plan.type),
          content: this.assembleTestFile({
            imports: [this.buildImports(project.testFramework)],
            body: [this.buildDescribeBlock(fn.name, [testBody])],
          }),
          testType: plan.type,
          testCount: 1,
          framework: project.testFramework,
        });
      }
    }

    return { tests, warnings: [], skipped: [] };
  }
}
```

3. Register it in the orchestrator's generator dispatch map.

### Adding a New Executor

1. Create `src/executors/my-runner.ts`
2. Extend `BaseExecutor`:

```ts
import type { GeneratedTest, ExecutionConfig, ExecutionResult } from "../types/index.js";
import { BaseExecutor } from "./base-executor.js";

export class MyRunner extends BaseExecutor {
  async execute(test: GeneratedTest, config: ExecutionConfig): Promise<ExecutionResult> {
    const result = this.createBaseResult(test.planId);
    const start = Date.now();

    try {
      const outcome = await this.withTimeout(
        this.withRetry(() => this.runTest(test), config.retries),
        config.timeout
      );

      result.status = outcome.failures.length === 0 ? "passed" : "failed";
      result.totalTests = outcome.total;
      result.passed = outcome.passed;
      result.failed = outcome.failures.length;
      result.failures = outcome.failures;
      result.output = outcome.stdout;

      if (config.collectCoverage) {
        result.coverage = this.parseCoverage(outcome.coverageJson);
      }
    } catch (err) {
      result.status = err instanceof Error && err.message.includes("timed out")
        ? "timeout"
        : "error";
      result.output = err instanceof Error ? err.message : String(err);
    }

    result.duration = Date.now() - start;
    return result;
  }

  private async runTest(test: GeneratedTest) {
    // Implementation here
  }
}
```

3. Register it in the orchestrator's executor dispatch map.
