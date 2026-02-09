/**
 * Prompt Templates for AI-Powered Test Generation
 *
 * These prompts combine AST analysis context with structured LLM
 * instructions to produce high-quality, runnable test files.
 * Each prompt is designed to be provider-agnostic — they work
 * identically whether sent to Claude, GPT, or a local model.
 */

import type { AIMessage } from "./types.js";
import type {
  CodeScanResult,
  TestType,
  TestFramework,
  TestFailure,
} from "../types/index.js";

// ─── Test Generation ─────────────────────────────────────────

export interface TestGenerationParams {
  sourceCode: string;
  scanResult: CodeScanResult;
  testType: TestType;
  framework: TestFramework;
  existingTests?: string[];
  projectContext?: string;
}

/**
 * Build the message array for generating tests from source code
 * and AST analysis results. The system message establishes the
 * persona and hard constraints; the user message provides all
 * the context needed to write tests.
 */
export function buildTestGenerationPrompt(
  params: TestGenerationParams,
): AIMessage[] {
  const {
    sourceCode,
    scanResult,
    testType,
    framework,
    existingTests,
    projectContext,
  } = params;

  const systemPrompt = buildSystemPrompt(framework);
  const userPrompt = buildUserPrompt(
    sourceCode,
    scanResult,
    testType,
    framework,
    existingTests,
    projectContext,
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
  sourceCode: string,
  scanResult: CodeScanResult,
  testType: TestType,
  framework: TestFramework,
  existingTests?: string[],
  projectContext?: string,
): string {
  const sections: string[] = [];

  // Project context (optional)
  if (projectContext) {
    sections.push(`## Project Context\n${projectContext}`);
  }

  // Source code
  sections.push(`## Source Code (${scanResult.file})\n\`\`\`${scanResult.language}\n${sourceCode}\n\`\`\``);

  // AST analysis — give the LLM structured insight into the code
  sections.push(`## Code Analysis (AST Scan Result)\n\`\`\`json\n${JSON.stringify(formatScanResult(scanResult), null, 2)}\n\`\`\``);

  // Test type instructions
  sections.push(`## Test Type: ${testType}\n${getTestTypeInstructions(testType, framework)}`);

  // Existing tests to avoid duplication
  if (existingTests && existingTests.length > 0) {
    sections.push(
      `## Existing Test Files (do NOT duplicate these)\nThe following test files already exist for this module. Do not re-test anything they already cover.\n\n${existingTests.map((t) => `- ${t}`).join("\n")}`,
    );
  }

  // Import guidance based on framework
  sections.push(`## Import Instructions\n${getImportInstructions(framework, scanResult)}`);

  return sections.join("\n\n");
}

/**
 * Format the scan result for prompt inclusion — strip noise and
 * keep only the fields the LLM needs to reason about test targets.
 */
function formatScanResult(
  scanResult: CodeScanResult,
): Record<string, unknown> {
  return {
    file: scanResult.file,
    language: scanResult.language,
    fileType: scanResult.fileType,
    exports: scanResult.exports.map((e) => ({
      name: e.name,
      kind: e.kind,
      isDefault: e.isDefault,
    })),
    functions: scanResult.functions.map((f) => ({
      name: f.name,
      params: f.params.map((p) => ({
        name: p.name,
        type: p.type,
        isOptional: p.isOptional,
      })),
      returnType: f.returnType,
      isAsync: f.isAsync,
      isExported: f.isExported,
      complexity: f.complexity,
    })),
    classes: scanResult.classes.map((c) => ({
      name: c.name,
      methods: c.methods.map((m) => ({
        name: m.name,
        params: m.params.length,
        isAsync: m.isAsync,
      })),
      isExported: c.isExported,
    })),
    endpoints: scanResult.endpoints.map((e) => ({
      method: e.method,
      path: e.path,
      handler: e.handler,
      middleware: e.middleware,
    })),
    components: scanResult.components.map((c) => ({
      name: c.name,
      props: c.props.map((p) => ({
        name: p.name,
        type: p.type,
        isOptional: p.isOptional,
      })),
      hooks: c.hooks,
      isPage: c.isPage,
    })),
  };
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
- State transitions and side effects`;

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

function getImportInstructions(
  framework: TestFramework,
  scanResult: CodeScanResult,
): string {
  const sourceFile = scanResult.file;

  // Compute a relative import path assuming the test file is co-located
  // or in a __tests__ directory adjacent to the source
  const importPath = `./${sourceFile.split("/").pop()?.replace(/\.(ts|tsx|js|jsx)$/, "")}`;

  const lines: string[] = [];

  switch (framework) {
    case "vitest":
      lines.push(
        `Import test utilities from "vitest": { describe, it, expect, vi, beforeEach, afterEach }`,
        `Import the module under test from "${importPath}" using relative path.`,
      );
      break;
    case "jest":
      lines.push(
        `Use global Jest functions: describe, it, expect, jest, beforeEach, afterEach`,
        `Import the module under test from "${importPath}" using relative path.`,
      );
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
      lines.push(
        `Import the module under test from "${importPath}".`,
        `Use the standard testing imports for ${framework}.`,
      );
  }

  return lines.join("\n");
}

// ─── Test Refinement ─────────────────────────────────────────

export interface TestRefinementParams {
  testCode: string;
  failures: TestFailure[];
  sourceCode: string;
}

/**
 * Build the message array for refining tests that failed.
 * This is used in the feedback loop: generate -> run -> failures -> refine -> run again.
 */
export function buildTestRefinementPrompt(
  params: TestRefinementParams,
): AIMessage[] {
  const { testCode, failures, sourceCode } = params;

  const systemPrompt = `You are an expert test engineer fixing failing tests.

HARD RULES:
1. Output ONLY the complete, corrected test file. No markdown fences, no explanations.
2. Fix the failing tests based on the error messages and stack traces provided.
3. Do NOT remove tests that fail — fix them so they pass against the actual source code behavior.
4. If a test assumption was wrong (the code behaves differently than expected), update the test to match the actual behavior.
5. If a test was testing the right thing but had an implementation error (wrong import, typo, incorrect assertion syntax), fix the implementation error.
6. Preserve all passing tests exactly as they are.
7. Do NOT add new tests — only fix the failing ones.`;

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
