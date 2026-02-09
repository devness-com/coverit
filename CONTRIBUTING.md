# Contributing to coverit

## Prerequisites

- [Bun](https://bun.sh/) 1.1+
- TypeScript 5.7+
- Git

## Setup

```bash
git clone https://github.com/nicepkg/coverit.git
cd coverit
bun install
bun run build
```

Verify the build:

```bash
bun run typecheck
bun run test
```

## Project Structure

```
src/
├── analysis/           Code analysis engine
│   ├── diff-analyzer.ts      git diff parsing
│   ├── code-scanner.ts       AST-based source analysis
│   ├── dependency-graph.ts   import graph builder
│   ├── strategy-planner.ts   test strategy planner
│   └── index.ts              barrel export
├── generators/         Test file generators
│   ├── base-generator.ts     abstract base class
│   ├── unit-generator.ts     unit tests
│   ├── api-generator.ts      API endpoint tests
│   ├── e2e-generator.ts      browser E2E tests
│   ├── mobile-generator.ts   mobile tests
│   ├── desktop-generator.ts  desktop tests
│   └── index.ts              barrel export
├── executors/          Test execution runners
│   ├── base-executor.ts      abstract base class
│   ├── local-runner.ts       local process runner
│   ├── cloud-runner.ts       cloud sandbox runner
│   ├── browser-runner.ts     browser lifecycle
│   ├── simulator-runner.ts   mobile simulator
│   └── index.ts              barrel export
├── agents/             Agent coordination
├── mcp/                MCP server
├── cli/                CLI entry point
├── types/              Type definitions
├── utils/              Shared utilities
├── orchestrator.ts     Pipeline coordinator
└── reporter.ts         Result aggregation
```

## Adding a New Test Generator

1. Create `src/generators/my-generator.ts`.
2. Extend `BaseGenerator` and implement the `generate` method:

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

3. Export it from `src/generators/index.ts`.
4. Register the generator in the orchestrator's dispatch map.

## Adding a New Executor

1. Create `src/executors/my-runner.ts`.
2. Extend `BaseExecutor` and implement the `execute` method:

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
      result.status = outcome.failed === 0 ? "passed" : "failed";
      result.totalTests = outcome.total;
      result.passed = outcome.passed;
      result.failed = outcome.failed;
    } catch (err) {
      result.status = "error";
      result.output = err instanceof Error ? err.message : String(err);
    }

    result.duration = Date.now() - start;
    return result;
  }
}
```

3. Export it from `src/executors/index.ts`.
4. Register the executor in the orchestrator's dispatch map.

## Code Conventions

- **Strict TypeScript** -- `strict: true` in tsconfig. No `any` unless interfacing with external untyped data.
- **ESM imports** -- always use `.js` extensions in import paths (e.g., `./base-generator.js`).
- **No console.log** -- use `logger` from `src/utils/logger.ts` in library code. `console` is only for the CLI layer.
- **Types in `src/types/`** -- all shared interfaces and type aliases live in `src/types/index.ts`.
- **Formatting** -- run `bun run format` (Prettier) before committing.
- **Linting** -- run `bun run lint` (ESLint) before committing.

## Testing

```bash
# Run all tests
bun run test

# Watch mode
bun run test:watch

# Type check without emitting
bun run typecheck
```

Tests use Vitest. Place test files next to the source file with a `.test.ts` suffix.

## Pull Request Process

1. Fork the repo and create a feature branch from `main`.
2. Make your changes. Follow the code conventions above.
3. Add or update tests for your changes.
4. Run `bun run typecheck && bun run lint && bun run test` to verify.
5. Write a clear PR description explaining what changed and why.
6. Submit the PR. A maintainer will review it.
