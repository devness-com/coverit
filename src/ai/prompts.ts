/**
 * Prompt Templates for AI-Powered Test Generation
 *
 * These prompts combine raw source code, diff hunks, and existing tests
 * to produce high-quality, runnable test files.
 * Each prompt is designed to be provider-agnostic — they work
 * identically whether sent to Claude, GPT, or a local model.
 */

import type { AIMessage } from "./types.js";
import { dirname, relative } from "node:path";
import type {
  TestType,
  TestFramework,
  TestFailure,
  GenerationInput,
  DiffHunk,
} from "../types/index.js";

// ─── Test Generation ─────────────────────────────────────────

export type TestGenerationParams = GenerationInput;

/**
 * Build the message array for generating tests from source code,
 * diff hunks, and optional existing test files. The system message
 * establishes the persona and hard constraints; the user message
 * provides all context needed to write tests.
 */
export function buildTestGenerationPrompt(
  params: TestGenerationParams,
): AIMessage[] {
  const { plan, project, sourceFiles, existingTestContent, testTypes } = params;
  const framework = project.testFramework;

  const systemPrompt = buildSystemPrompt(framework);
  const userPrompt = buildUserPrompt(
    plan,
    project,
    sourceFiles,
    existingTestContent,
    testTypes,
    framework,
  );

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

function buildSystemPrompt(framework: TestFramework): string {
  return `You are an expert test engineer specializing in writing thorough, maintainable test suites.

FRAMEWORK: ${framework}

HARD RULES — follow these exactly:
1. Output ONLY the complete test file content. No markdown fences, no explanations, no commentary.
2. Write meaningful assertions that verify behavior. Never write trivial assertions like \`toBeDefined()\` or \`toBeTruthy()\` as the sole check for a test case.
3. Do NOT mock standard library modules (node:crypto, node:fs, node:path, etc.) unless you are specifically testing an error path that requires it.
4. Test behavior and public contracts, not implementation details. If a refactor would break the test but not the behavior, the test is wrong.
5. Each test case must have a clear, descriptive name that explains what behavior it verifies.
6. Group related tests using \`describe\` blocks that mirror the module's structure.
7. Include setup/teardown where needed, but keep tests isolated from each other.
8. Use realistic test data, not meaningless strings like "foo" and "bar".
9. Prefer \`toEqual\` for deep equality, \`toBe\` for primitives and references, \`toThrow\` for errors.
10. Handle async code correctly — always await promises and use proper async test patterns.`;
}

function buildUserPrompt(
  plan: TestGenerationParams["plan"],
  project: TestGenerationParams["project"],
  sourceFiles: TestGenerationParams["sourceFiles"],
  existingTestContent: string | null,
  testTypes: TestType[],
  framework: TestFramework,
): string {
  const sections: string[] = [];

  // Project context
  sections.push(
    `## Project\n- Framework: ${project.framework}\n- Test framework: ${framework}\n- Language: ${project.language}`,
  );

  // Plan description
  sections.push(`## Task\n${plan.description}`);

  // Source code for each target file
  // For large files (>30KB), send only the changed regions with context
  // to avoid exceeding AI token limits
  const SOURCE_SIZE_LIMIT = 15_000;

  for (const file of sourceFiles) {
    if (file.content.length <= SOURCE_SIZE_LIMIT || file.hunks.length === 0) {
      // Small file or no hunks: send full source
      sections.push(
        `## Source Code (${file.path})\n\`\`\`${project.language}\n${file.content}\n\`\`\``,
      );
    } else {
      // Large file: extract changed regions with surrounding context
      const excerpt = extractChangedRegions(file.content, file.hunks);
      sections.push(
        `## Source Code — changed regions with context (${file.path})\nThis file is large (${Math.round(file.content.length / 1024)}KB). Only the changed regions with surrounding context are shown.\n\n\`\`\`${project.language}\n${excerpt}\n\`\`\``,
      );
    }

    // Diff hunks — highlight what changed
    if (file.hunks.length > 0) {
      const hunkText = formatDiffHunks(file.hunks);
      sections.push(`## What Changed (${file.path})\n\`\`\`diff\n${hunkText}\n\`\`\``);
    }
  }

  // Existing test file — extend instead of creating new
  if (existingTestContent) {
    sections.push(
      `## Existing Tests — extend this file\nAdd new test cases to this existing file for the described changes. Do not remove or modify existing tests. Output the complete updated file.\n\n\`\`\`${project.language}\n${existingTestContent}\n\`\`\``,
    );
  }

  // Test type instructions
  for (const testType of testTypes) {
    sections.push(
      `## Test Type: ${testType}\n${getTestTypeInstructions(testType, framework)}`,
    );
  }

  // Import guidance
  if (sourceFiles.length > 0) {
    sections.push(
      `## Import Instructions\nThe test file will be at: ${plan.outputTestFile}\n${getImportInstructionsFromPaths(framework, sourceFiles.map((f) => f.path), plan.outputTestFile)}`,
    );
  }

  return sections.join("\n\n");
}

/**
 * Extract changed regions from source code using diff hunk line numbers.
 * Includes ~30 lines of context around each change for AI comprehension.
 */
function extractChangedRegions(source: string, hunks: DiffHunk[]): string {
  const lines = source.split("\n");
  const CONTEXT_LINES = 30;
  const regions: Array<{ start: number; end: number }> = [];

  for (const hunk of hunks) {
    // Parse hunk header: @@ -old,count +new,count @@
    const match = hunk.content.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    const startLine = parseInt(match[1]!, 10) - 1; // 0-indexed
    const count = parseInt(match[2] ?? "1", 10);
    const endLine = startLine + count;

    regions.push({
      start: Math.max(0, startLine - CONTEXT_LINES),
      end: Math.min(lines.length, endLine + CONTEXT_LINES),
    });
  }

  if (regions.length === 0) return source;

  // Merge overlapping regions
  regions.sort((a, b) => a.start - b.start);
  const merged: typeof regions = [regions[0]!];
  for (let i = 1; i < regions.length; i++) {
    const prev = merged[merged.length - 1]!;
    const curr = regions[i]!;
    if (curr.start <= prev.end) {
      prev.end = Math.max(prev.end, curr.end);
    } else {
      merged.push(curr);
    }
  }

  // Build excerpt with separators between non-adjacent regions
  const parts: string[] = [];
  for (const region of merged) {
    if (parts.length > 0) parts.push("\n// ... (lines omitted) ...\n");
    parts.push(lines.slice(region.start, region.end).join("\n"));
  }

  return parts.join("\n");
}

function formatDiffHunks(hunks: DiffHunk[]): string {
  return hunks
    .map((h) => h.content)
    .join("\n...\n");
}

function getTestTypeInstructions(
  testType: TestType,
  framework: TestFramework,
): string {
  switch (testType) {
    case "unit":
      return `Write unit tests for each exported function and class.

For each function/method, cover:
- Happy path with typical inputs
- Edge cases (empty strings, zero, null/undefined where applicable, boundary values)
- Error cases (invalid input, thrown exceptions)
- Return value correctness

For classes, test:
- Construction with valid and invalid arguments
- Each public method independently
- State transitions and side effects

IMPORTANT — Dependency Isolation:
- Mock ALL external dependencies (databases, message queues, HTTP clients, external services).
- For NestJS: use \`@nestjs/testing\` \`Test.createTestingModule()\` with mock providers for every injected dependency. Never bootstrap the full app module — only import the single class under test with its dependencies mocked.
- Never connect to real databases, Redis, RabbitMQ, or any external service.
- Use jest.fn() / vi.fn() for mock implementations. Provide minimal mock return values that satisfy the code paths.`;

    case "integration":
      return `Write integration tests that verify how multiple modules work together.

Focus on:
- Data flow between functions/services
- Database or external service interactions (mock at the boundary)
- Error propagation across module boundaries
- Real-world usage scenarios that exercise multiple code paths`;

    case "api":
      return `Write API endpoint tests for each route.

For each endpoint, test:
- Successful request with valid payload (2xx response)
- Validation failures with invalid/missing fields (4xx response)
- Authentication/authorization errors if middleware is present
- Correct response shape and status codes
- Edge cases in request parameters

Use ${framework === "vitest" || framework === "jest" ? "supertest or the framework's test client" : "the appropriate HTTP test client"} to make requests.`;

    case "e2e-browser":
      return `Write end-to-end browser tests using ${framework === "playwright" ? "Playwright" : framework === "cypress" ? "Cypress" : "the browser test framework"}.

Test complete user flows:
- Page navigation and URL verification
- Form filling, submission, and validation feedback
- Button clicks, modal interactions, and dynamic content
- Loading states and error states
- Responsive behavior if applicable

Use realistic user actions — click, type, navigate — not internal API calls.`;

    case "e2e-mobile":
      return `Write mobile end-to-end tests.

Test:
- Screen rendering and layout
- Navigation between screens (stack, tab, drawer)
- Touch gestures (tap, swipe, long press)
- Form inputs and keyboard interactions
- Platform-specific behavior where relevant`;

    case "e2e-desktop":
      return `Write desktop application end-to-end tests.

Test:
- Window creation and management
- Tauri commands and IPC communication
- Menu interactions and keyboard shortcuts
- File system operations through the app
- Native dialog interactions
- Window state (minimize, maximize, close)`;

    case "snapshot":
      return `Write snapshot tests for the component/module output.

- Capture rendered output or serialized state
- Cover different prop/input combinations
- Include edge cases that affect rendering
- Each snapshot should have a descriptive test name`;

    case "performance":
      return `Write performance benchmark tests.

- Measure execution time for key operations
- Set reasonable performance budgets
- Test with realistic data sizes
- Compare against baseline expectations
- Use ${framework}'s timing utilities or performance.now()`;
  }
}

function getImportInstructionsFromPaths(
  framework: TestFramework,
  sourcePaths: string[],
  testFilePath: string,
): string {
  const lines: string[] = [];

  // Compute relative import paths from the test file to each source file
  const testDir = dirname(testFilePath);
  const importPaths = sourcePaths.map((p) => {
    const rel = relative(testDir, p).replace(/\.(ts|tsx|js|jsx)$/, "");
    // Ensure it starts with ./ or ../
    return rel.startsWith(".") ? rel : `./${rel}`;
  });

  switch (framework) {
    case "vitest":
      lines.push(
        `Import test utilities from "vitest": { describe, it, expect, vi, beforeEach, afterEach }`,
      );
      for (const ip of importPaths) {
        lines.push(`Import the module under test from "${ip}" using relative path.`);
      }
      break;
    case "jest":
      lines.push(
        `Use global Jest functions: describe, it, expect, jest, beforeEach, afterEach`,
      );
      for (const ip of importPaths) {
        lines.push(`Import the module under test from "${ip}" using relative path.`);
      }
      break;
    case "playwright":
      lines.push(
        `Import from "@playwright/test": { test, expect }`,
        `Use test.describe for grouping, test() for individual tests.`,
      );
      break;
    case "cypress":
      lines.push(
        `Use global Cypress functions: describe, it, cy`,
        `Use cy.visit(), cy.get(), cy.contains() for interactions.`,
      );
      break;
    default:
      for (const ip of importPaths) {
        lines.push(`Import the module under test from "${ip}".`);
      }
      lines.push(`Use the standard testing imports for ${framework}.`);
  }

  return lines.join("\n");
}

// ─── Test Refinement ─────────────────────────────────────────

export interface TestRefinementParams {
  testCode: string;
  failures: TestFailure[];
  sourceCode: string;
}

type FailurePattern =
  | "di_resolution"
  | "timeout"
  | "real_connection"
  | "query_chain"
  | "mock_hoisting"
  | "module_not_found"
  | "path_alias"
  | "parse_error"
  | "oom";

function classifyFailures(failures: TestFailure[]): Set<FailurePattern> {
  const patterns = new Set<FailurePattern>();

  for (const f of failures) {
    const text = `${f.message}\n${f.stack ?? ""}`;

    // DI resolution failures — NestJS, Angular, InversifyJS, tsyringe, awilix, etc.
    if (
      /Nest\s*(can.t|could\s*not)\s*resolve/i.test(text) ||
      /please\s*make\s*sure.*available.*context/i.test(text) ||
      /No\s+provider\s+for/i.test(text) ||
      /Error:\s+inject\b/i.test(text) ||
      /ServiceIdentifier.*not\s+found/i.test(text) ||
      /cannot\s+resolve.*dependency/i.test(text)
    ) {
      patterns.add("di_resolution");
    }
    if (/timed?\s*out/i.test(text) || /exceeded\s*timeout/i.test(text)) {
      patterns.add("timeout");
    }
    // Real connection attempts — database, cache, message queue, HTTP
    if (
      /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|connect\s+ECONNRESET/i.test(text) ||
      /MongoServerSelectionError|Redis|AMQP|SequelizeConnectionError|PrismaClientInitializationError/i.test(text) ||
      /getaddrinfo|Connection\s+refused/i.test(text)
    ) {
      patterns.add("real_connection");
    }
    // Chainable query/builder errors — Mongoose, Knex, Sequelize, Prisma, TypeORM, Drizzle
    if (
      /\.(exec|lean|populate|sort|limit|skip|select|where|orderBy|groupBy|toPromise|getMany|getOne)\(\)/i.test(text) &&
      /not\s+a\s+function|undefined|is\s+not/i.test(text)
    ) {
      patterns.add("query_chain");
    }
    if (/vi\.mock|jest\.mock/i.test(text) && /hoist|before.*import|ReferenceError/i.test(text)) {
      patterns.add("mock_hoisting");
    }
    if (/Cannot\s+find\s+module|Module\s+not\s+found/i.test(text)) {
      patterns.add("module_not_found");
    }
    if (/@app\/|@src\/|@lib\/|@shared\/|@\w+\//i.test(text) && /Cannot\s+find|not\s+found/i.test(text)) {
      patterns.add("path_alias");
    }
    if (/SyntaxError|Unexpected\s+token|Parse\s+error/i.test(text)) {
      patterns.add("parse_error");
    }
    if (/heap|out\s+of\s+memory|allocation\s+failed|OOM/i.test(text)) {
      patterns.add("oom");
    }
  }

  return patterns;
}

function buildPatternSpecificGuidance(patterns: Set<FailurePattern>): string {
  if (patterns.size === 0) return "";

  const sections: string[] = ["\nPATTERN-SPECIFIC FIX GUIDANCE (based on detected failure patterns):"];

  if (patterns.has("di_resolution") || patterns.has("timeout") || patterns.has("real_connection")) {
    sections.push(`
**Dependency Injection / Timeout / Connection Errors:**
The tests are trying to bootstrap real services or connect to external resources. Fix by isolating the unit under test:
- Mock ALL injected dependencies (services, repositories, clients, config, models)
- NEVER import a root/app module that bootstraps the full application
- For DI frameworks (NestJS, Angular, InversifyJS, tsyringe): create a minimal test module with only the class under test and mock providers for each dependency
- For non-DI code: mock external modules (database clients, HTTP clients, queues) at the module level using jest.mock()/vi.mock()
- Ensure no test triggers real network calls, database connections, or message queue subscriptions`);
  }

  if (patterns.has("query_chain")) {
    sections.push(`
**Query Builder / Chainable API Errors:**
The code uses a chainable query API (e.g. ORM or query builder) and the mock is incomplete. Fix by mocking the FULL method chain:
- Create a mock object where each chainable method returns \`this\` (mockReturnThis) and the terminal method (exec, getMany, toPromise, etc.) returns the expected data
- Example: \`const mockQuery = { where: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(data) };\`
- The entry method (find, findOne, createQueryBuilder, etc.) should return this mockQuery object`);
  }

  if (patterns.has("mock_hoisting")) {
    sections.push(`
**Mock Hoisting Errors:**
- \`jest.mock()\` / \`vi.mock()\` calls MUST be at the TOP LEVEL of the file, before any imports that use the mocked modules
- Do NOT put jest.mock() inside describe/beforeEach blocks
- For variables used in mock factories, use \`jest.fn()\` directly in the factory, not external variables`);
  }

  if (patterns.has("module_not_found") || patterns.has("path_alias")) {
    sections.push(`
**Module / Path Resolution Errors:**
- Replace ALL path aliases (\`@app/\`, \`@src/\`, \`@lib/\`, \`@shared/\`, or any custom \`@prefix/\`) with relative paths from the test file
- Use \`../\` notation to navigate from the test file to the source file
- Check that file extensions match (.js vs .ts) based on the project's module system
- Verify the module name is spelled correctly and the package is installed`);
  }

  if (patterns.has("parse_error")) {
    sections.push(`
**Parse / Syntax Errors:**
- Check for mismatched braces, brackets, or parentheses
- Ensure ESM syntax (import/export) vs CJS (require/module.exports) matches the project config
- Verify TypeScript-specific syntax is supported by the test runner's transform config`);
  }

  if (patterns.has("oom")) {
    sections.push(`
**Out-of-Memory Errors:**
- Mock large dependency trees at the MODULE level using jest.mock()/vi.mock() to prevent loading heavy modules
- Avoid importing large source files directly — mock the module and only test the interface
- Reduce test data size if creating large arrays/objects`);
  }

  return sections.join("\n");
}

/**
 * Build the message array for refining tests that failed.
 * This is used in the feedback loop: generate -> run -> failures -> refine -> run again.
 */
export function buildTestRefinementPrompt(
  params: TestRefinementParams,
): AIMessage[] {
  const { testCode, failures, sourceCode } = params;

  const patternGuidance = buildPatternSpecificGuidance(classifyFailures(failures));

  const systemPrompt = `You are an expert test engineer fixing failing tests.

HARD RULES:
1. Output ONLY the complete, corrected test file. No markdown fences, no explanations.
2. Fix the failing tests based on the error messages and stack traces provided.
3. Do NOT remove tests that fail — fix them so they pass against the actual source code behavior.
4. If a test assumption was wrong (the code behaves differently than expected), update the test to match the actual behavior.
5. If a test was testing the right thing but had an implementation error (wrong import, typo, incorrect assertion syntax), fix the implementation error.
6. Preserve all passing tests exactly as they are.
7. Do NOT add new tests — only fix the failing ones.

COMMON FIXES:
- If a test TIMED OUT, it likely tried to connect to a real database/service. Rewrite it to mock ALL external dependencies (database clients, HTTP services, queues, config). Never bootstrap the full application module.
- If a test had a PARSE ERROR, check imports and TypeScript syntax match the project's tsconfig/jest config.
- If a test had a MODULE NOT FOUND error, fix the import paths to be relative from the test file location.${patternGuidance}`;

  const failureDetails = failures
    .map((f, i) => {
      const parts = [`### Failure ${i + 1}: ${f.testName}`, `Message: ${f.message}`];
      if (f.expected) parts.push(`Expected: ${f.expected}`);
      if (f.actual) parts.push(`Actual: ${f.actual}`);
      if (f.stack) parts.push(`Stack:\n${f.stack}`);
      return parts.join("\n");
    })
    .join("\n\n");

  const userPrompt = `## Failing Test File\n\`\`\`\n${testCode}\n\`\`\`

## Test Failures\n${failureDetails}

## Original Source Code Being Tested\n\`\`\`\n${sourceCode}\n\`\`\`

Fix the failing tests so they pass against the source code above. Output the complete corrected test file.`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

// ─── Simplified Generation (for retry after initial failure) ─

export type SimplifiedGenerationParams = GenerationInput;

/**
 * Build a compact prompt for retrying generation after initial failure.
 * Uses only diff hunks (not full source) and a minimal system prompt
 * to stay within token limits that caused the first attempt to fail.
 */
export function buildSimplifiedGenerationPrompt(
  params: SimplifiedGenerationParams,
): AIMessage[] {
  const { plan, project, sourceFiles, existingTestContent, testTypes } = params;
  const framework = project.testFramework;

  const systemPrompt = `You are a test engineer. Write a complete, runnable test file.
Output ONLY code — no fences, no commentary. Mock all external dependencies.
Framework: ${framework}`;

  const sections: string[] = [];

  sections.push(`## Task\n${plan.description}`);

  const EXCERPT_LIMIT = 3000;
  const MAX_HUNK_SIZE = 5000;
  for (const file of sourceFiles) {
    if (file.hunks.length > 0) {
      let hunkText = file.hunks.map((h) => h.content).join("\n...\n");
      if (hunkText.length > MAX_HUNK_SIZE) {
        hunkText = hunkText.slice(0, MAX_HUNK_SIZE) + "\n// ... (remaining hunks omitted for brevity)";
      }
      sections.push(`## Changes (${file.path})\n\`\`\`diff\n${hunkText}\n\`\`\``);
    } else {
      const excerpt = file.content.slice(0, EXCERPT_LIMIT);
      const suffix = file.content.length > EXCERPT_LIMIT ? "\n// ... (truncated)" : "";
      sections.push(`## Source excerpt (${file.path})\n\`\`\`${project.language}\n${excerpt}${suffix}\n\`\`\``);
    }
  }

  if (existingTestContent) {
    // Cap existing test content to avoid bloating the simplified prompt
    const maxTestContent = existingTestContent.length > MAX_HUNK_SIZE
      ? existingTestContent.slice(0, MAX_HUNK_SIZE) + "\n// ... (truncated)"
      : existingTestContent;
    sections.push(`## Existing Tests — extend this file\n\`\`\`${project.language}\n${maxTestContent}\n\`\`\``);
  }

  for (const testType of testTypes) {
    sections.push(`## Test Type: ${testType}\n${getTestTypeInstructions(testType, framework)}`);
  }

  if (sourceFiles.length > 0) {
    sections.push(
      `## Import Instructions\nTest file: ${plan.outputTestFile}\n${getImportInstructionsFromPaths(framework, sourceFiles.map((f) => f.path), plan.outputTestFile)}`,
    );
  }

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: sections.join("\n\n") },
  ];
}
