/**
 * API Endpoint Test Prompt Builder
 *
 * Specialized prompts for generating HTTP endpoint tests that
 * exercise real request/response cycles. Uses supertest or the
 * framework's native testing utilities to validate status codes,
 * response schemas, auth flows, and error handling.
 */

import { dirname, relative } from "node:path";
import type { AIMessage } from "./types.js";
import type { TestFramework, Language, ProjectInfo } from "../types/index.js";

export interface ApiPromptParams {
  /** Module path being tested */
  modulePath: string;
  /** Source file contents (controllers, routes, handlers) */
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
 * Build a prompt optimized for API endpoint test generation.
 * Covers HTTP methods, status codes, validation, auth, and
 * response schema correctness.
 */
export function buildApiPrompt(params: ApiPromptParams): AIMessage[] {
  const { project } = params;
  const framework = project.testFramework;

  const system = buildApiSystemPrompt(framework, project.language, project.framework);
  const user = buildApiUserPrompt(params, framework);

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function buildApiSystemPrompt(
  framework: TestFramework,
  language: Language,
  appFramework: string,
): string {
  const httpClient = resolveHttpTestClient(framework, appFramework);

  return `You are an expert test engineer writing API ENDPOINT tests.

FRAMEWORK: ${framework}
LANGUAGE: ${language}
APP FRAMEWORK: ${appFramework}
HTTP TEST CLIENT: ${httpClient}

API TEST PHILOSOPHY:
- Test HTTP endpoints with real request/response cycles.
- Use ${httpClient} to send actual HTTP requests to the app.
- Test all relevant HTTP methods, status codes, and error responses.
- Validate response schemas match DTOs/interfaces.
- Test authentication and authorization boundaries.

HARD RULES:
1. Output ONLY the complete test file content. No markdown fences, no explanations.
2. For each endpoint, test AT MINIMUM:
   a. Successful request with valid payload (2xx response)
   b. Validation failures with invalid/missing required fields (400)
   c. Authentication errors when auth middleware exists (401)
   d. Authorization errors for protected resources (403)
   e. Not-found for invalid resource IDs (404)
3. Validate both the status code AND the response body shape.
4. Use realistic request payloads — not placeholder strings.
5. Group tests by endpoint (e.g., describe("POST /api/users", ...)).
6. Mock only external services (email, payment) — let the API layer run with real routing.
7. Test Content-Type headers and accept headers where relevant.
8. For paginated endpoints, test pagination parameters and response metadata.
9. For file uploads, test multipart form data handling.
10. Include edge cases: empty strings, boundary values, oversized payloads.`;
}

function buildApiUserPrompt(
  params: ApiPromptParams,
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

  sections.push(`## API Test Goal\n${gapDescription}`);
  sections.push(
    `Generate approximately ${expectedTests} API test(s) for module "${modulePath}".`,
  );

  for (const file of sourceFiles) {
    sections.push(
      `## Source Code (${file.path})\n\`\`\`${project.language}\n${truncateSource(file.content)}\n\`\`\``,
    );
  }

  sections.push(`## Test File Location\n${outputTestFile}`);
  sections.push(buildImportHints(framework, sourceFiles, outputTestFile, project.framework));

  return sections.join("\n\n");
}

// ─── Framework-Specific Resolution ─────────────────────────

function resolveHttpTestClient(
  testFramework: TestFramework,
  appFramework: string,
): string {
  // NestJS has its own testing module with supertest integration
  if (appFramework === "nestjs") {
    return "supertest via @nestjs/testing (Test.createTestingModule + app.getHttpServer())";
  }

  // Express, Hono, Fastify all work well with supertest
  if (["express", "hono", "fastify"].includes(appFramework)) {
    return "supertest";
  }

  // Default fallback
  if (testFramework === "vitest" || testFramework === "jest") {
    return "supertest or native fetch";
  }

  return "the framework's HTTP test utilities";
}

// ─── Shared Utilities ──────────────────────────────────────

const SOURCE_LIMIT = 15_000;

function truncateSource(content: string): string {
  if (content.length <= SOURCE_LIMIT) return content;
  return (
    content.slice(0, SOURCE_LIMIT) +
    "\n// ... (truncated — focus on route definitions, DTOs, and middleware)"
  );
}

function buildImportHints(
  framework: TestFramework,
  sourceFiles: Array<{ path: string }>,
  outputTestFile: string,
  appFramework: string,
): string {
  const testDir = dirname(outputTestFile);
  const lines: string[] = ["## Import Instructions"];

  if (framework === "vitest") {
    lines.push(
      `Import test utilities from "vitest": { describe, it, expect, vi, beforeAll, afterAll, beforeEach }`,
    );
  } else if (framework === "jest") {
    lines.push(
      `Use global Jest functions: describe, it, expect, jest, beforeAll, afterAll, beforeEach`,
    );
  }

  if (appFramework === "nestjs") {
    lines.push(`Import from "@nestjs/testing": { Test, TestingModule }`);
    lines.push(`Import from "supertest": default as request`);
    lines.push(`Import the module under test and its controller/service.`);
  } else if (["express", "hono", "fastify"].includes(appFramework)) {
    lines.push(`Import from "supertest": default as request`);
    lines.push(`Import the app instance or router to test.`);
  }

  for (const file of sourceFiles) {
    const rel = relative(testDir, file.path).replace(/\.(ts|tsx|js|jsx)$/, "");
    const importPath = rel.startsWith(".") ? rel : `./${rel}`;
    lines.push(`Import from "${importPath}" using relative path.`);
  }

  return lines.join("\n");
}
