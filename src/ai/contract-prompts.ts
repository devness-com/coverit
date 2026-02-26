/**
 * Contract / Schema Validation Test Prompt Builder
 *
 * Specialized prompts for generating tests that validate API
 * contracts haven't broken. Focuses on request/response schema
 * validation, DTO decorator rules, backwards compatibility,
 * and edge cases around field presence and types.
 */

import { dirname, relative } from "node:path";
import type { AIMessage } from "./types.js";
import type { TestFramework, Language, ProjectInfo } from "../types/index.js";

export interface ContractPromptParams {
  /** Module path being tested */
  modulePath: string;
  /** Source file contents (DTOs, schemas, validators) */
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
 * Build a prompt optimized for contract/schema validation tests.
 * Tests DTO shapes, validation rules, and backwards compatibility.
 */
export function buildContractPrompt(
  params: ContractPromptParams,
): AIMessage[] {
  const { project } = params;
  const framework = project.testFramework;

  const system = buildContractSystemPrompt(framework, project.language, project.framework);
  const user = buildContractUserPrompt(params, framework);

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function buildContractSystemPrompt(
  framework: TestFramework,
  language: Language,
  appFramework: string,
): string {
  const validationLib = resolveValidationLib(appFramework);

  return `You are an expert test engineer writing CONTRACT and SCHEMA VALIDATION tests.

FRAMEWORK: ${framework}
LANGUAGE: ${language}
VALIDATION LIBRARY: ${validationLib}

CONTRACT TEST PHILOSOPHY:
- Validate request and response schemas to catch breaking changes.
- Test that API contracts haven't broken (backwards compatibility).
- Validate DTO decorators and validation rules work correctly.
- Test edge cases: missing fields, extra fields, wrong types, null vs undefined.

HARD RULES:
1. Output ONLY the complete test file content. No markdown fences, no explanations.
2. For each DTO/schema, test:
   a. Valid data passes validation (happy path)
   b. Each required field: missing -> validation error
   c. Each typed field: wrong type -> validation error
   d. Optional fields: absent -> passes, null -> check behavior
   e. Extra/unknown fields: verify stripped or rejected per config
   f. Boundary values: min/max length, min/max value, pattern regex
3. For response schemas, validate the shape matches the documented contract.
4. Use realistic field values that match the domain (emails, dates, IDs, etc.).
5. Group tests by DTO/schema class name.
6. Test nested objects and arrays thoroughly — each level of nesting.
7. If class-validator decorators are present, test each decorator's constraint.
8. If Zod/Joi/Yup schemas are used, test the schema's parse/validate directly.
9. Do NOT test business logic — only test that the contract is enforced.
10. Include a "snapshot" or "shape" test that verifies the complete valid response shape.`;
}

function buildContractUserPrompt(
  params: ContractPromptParams,
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

  sections.push(`## Contract Test Goal\n${gapDescription}`);
  sections.push(
    `Generate approximately ${expectedTests} contract validation test(s) for module "${modulePath}".`,
  );

  for (const file of sourceFiles) {
    sections.push(
      `## Source Code (${file.path})\n\`\`\`${project.language}\n${truncateSource(file.content)}\n\`\`\``,
    );
  }

  sections.push(`## Test File Location\n${outputTestFile}`);
  sections.push(
    buildImportHints(framework, sourceFiles, outputTestFile, project.framework),
  );

  return sections.join("\n\n");
}

// ─── Framework-Specific Resolution ─────────────────────────

function resolveValidationLib(appFramework: string): string {
  switch (appFramework) {
    case "nestjs":
      return "class-validator + class-transformer (instantiate DTO, call validate())";
    case "hono":
      return "Zod (if used) or manual validation";
    case "express":
      return "Joi, Zod, express-validator, or class-validator — check the source";
    case "fastify":
      return "Ajv (Fastify's built-in JSON schema validation) or Zod";
    default:
      return "the project's validation library — check imports in the source files";
  }
}

// ─── Shared Utilities ──────────────────────────────────────

const SOURCE_LIMIT = 15_000;

function truncateSource(content: string): string {
  if (content.length <= SOURCE_LIMIT) return content;
  return (
    content.slice(0, SOURCE_LIMIT) +
    "\n// ... (truncated — focus on DTO definitions, decorators, and validation schemas)"
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
      `Import test utilities from "vitest": { describe, it, expect, beforeEach }`,
    );
  } else if (framework === "jest") {
    lines.push(
      `Use global Jest functions: describe, it, expect, beforeEach`,
    );
  }

  if (appFramework === "nestjs") {
    lines.push(`Import from "class-validator": { validate }`);
    lines.push(`Import from "class-transformer": { plainToInstance }`);
    lines.push(`Import the DTO classes to validate.`);
  }

  for (const file of sourceFiles) {
    const rel = relative(testDir, file.path).replace(/\.(ts|tsx|js|jsx)$/, "");
    const importPath = rel.startsWith(".") ? rel : `./${rel}`;
    lines.push(`Import from "${importPath}" using relative path.`);
  }

  return lines.join("\n");
}
