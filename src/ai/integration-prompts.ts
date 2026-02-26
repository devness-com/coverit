/**
 * Integration Test Prompt Builder
 *
 * Specialized prompts for generating integration tests that verify
 * real component interactions with minimal mocking. The philosophy:
 * mock external services (HTTP APIs, email, payment gateways) but
 * use real or in-memory versions of everything else (databases,
 * caches, queues when feasible).
 */

import { dirname, relative } from "node:path";
import type { AIMessage } from "./types.js";
import type { TestFramework, Language, ProjectInfo } from "../types/index.js";

export interface IntegrationPromptParams {
  /** Module path being tested */
  modulePath: string;
  /** Source file contents to test */
  sourceFiles: Array<{ path: string; content: string }>;
  /** Output test file path (for import resolution) */
  outputTestFile: string;
  /** Project metadata */
  project: ProjectInfo;
  /** Human-readable description of what gaps to fill */
  gapDescription: string;
  /** Number of tests expected */
  expectedTests: number;
}

/**
 * Build a prompt optimized for integration test generation.
 * Emphasizes real dependencies over mocks and tests the full
 * data flow through the system.
 */
export function buildIntegrationPrompt(
  params: IntegrationPromptParams,
): AIMessage[] {
  const { project } = params;
  const framework = project.testFramework;

  const system = buildIntegrationSystemPrompt(framework, project.language);
  const user = buildIntegrationUserPrompt(params, framework);

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function buildIntegrationSystemPrompt(
  framework: TestFramework,
  language: Language,
): string {
  return `You are an expert test engineer writing INTEGRATION tests — not unit tests.

FRAMEWORK: ${framework}
LANGUAGE: ${language}

INTEGRATION TEST PHILOSOPHY:
- Test real component interactions, NOT isolated units.
- Use real database connections or in-memory databases when possible.
- Minimize mocking — only mock external services (HTTP APIs, email, payment gateways, SMS, etc.).
- Test the full flow: input -> service -> repository -> database -> response.
- Include setup/teardown for test data.

HARD RULES:
1. Output ONLY the complete test file content. No markdown fences, no explanations.
2. Write meaningful assertions that verify actual data flow between components.
3. Each test must exercise at least TWO real components working together.
4. Group tests by the flow they verify (e.g., "create -> read -> update -> delete").
5. Use descriptive test names that explain the integration scenario.
6. Handle async operations correctly — await all promises.
7. Clean up test data in afterEach/afterAll to prevent test pollution.
8. Use realistic test data that reflects production-like scenarios.
9. DO NOT mock internal services, repositories, or modules — they are the integration point.
10. DO mock: HTTP clients (axios, fetch wrappers), email services, cloud storage, payment gateways, third-party APIs.

SETUP PATTERNS:
- For NestJS: Use \`Test.createTestingModule()\` with REAL providers for internal services and mock providers only for external boundaries.
- For Express/Hono/Fastify: Initialize the real app/router with an in-memory or test database.
- Database: Use a test database, in-memory SQLite, or the framework's built-in test DB support.
- Transactions: Wrap each test in a transaction and rollback for isolation when possible.`;
}

function buildIntegrationUserPrompt(
  params: IntegrationPromptParams,
  framework: TestFramework,
): string {
  const {
    project,
    sourceFiles,
    outputTestFile,
    gapDescription,
    modulePath,
    expectedTests,
  } = params;
  const sections: string[] = [];

  sections.push(
    `## Project\n- Framework: ${project.framework}\n- Test framework: ${framework}\n- Language: ${project.language}`,
  );

  sections.push(`## Integration Test Goal\n${gapDescription}`);
  sections.push(
    `Generate approximately ${expectedTests} integration test(s) for module "${modulePath}".`,
  );

  for (const file of sourceFiles) {
    sections.push(
      `## Source Code (${file.path})\n\`\`\`${project.language}\n${truncateSource(file.content)}\n\`\`\``,
    );
  }

  sections.push(`## Test File Location\n${outputTestFile}`);
  sections.push(
    buildImportHints(framework, sourceFiles, outputTestFile),
  );

  return sections.join("\n\n");
}

// ─── Shared Utilities ──────────────────────────────────────

/** Truncate source to avoid token limits — keep first 15K chars */
const SOURCE_LIMIT = 15_000;

function truncateSource(content: string): string {
  if (content.length <= SOURCE_LIMIT) return content;
  return (
    content.slice(0, SOURCE_LIMIT) +
    "\n// ... (truncated for brevity — focus on the public API and key methods)"
  );
}

function buildImportHints(
  framework: TestFramework,
  sourceFiles: Array<{ path: string }>,
  outputTestFile: string,
): string {
  const testDir = dirname(outputTestFile);
  const lines: string[] = ["## Import Instructions"];

  if (framework === "vitest") {
    lines.push(
      `Import test utilities from "vitest": { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll }`,
    );
  } else if (framework === "jest") {
    lines.push(
      `Use global Jest functions: describe, it, expect, jest, beforeEach, afterEach, beforeAll, afterAll`,
    );
  }

  for (const file of sourceFiles) {
    const rel = relative(testDir, file.path).replace(/\.(ts|tsx|js|jsx)$/, "");
    const importPath = rel.startsWith(".") ? rel : `./${rel}`;
    lines.push(`Import from "${importPath}" using relative path.`);
  }

  return lines.join("\n");
}
