/**
 * Coverit Cover — AI-Driven Test Generation Prompts
 *
 * Builds prompts for the AI to generate tests for modules with coverage gaps.
 * The AI gets full tool access (Read, Glob, Grep, Bash, Write, Edit) and
 * autonomously writes test files, runs them, and fixes failures.
 *
 * Input: module gap info from coverit.json
 * Output: AI writes test files to disk, runs them, returns summary
 */

import type { AIMessage } from "./types.js";
import type { ManifestProject, FunctionalTestType } from "../schema/coverit-manifest.js";

// ─── Types ───────────────────────────────────────────────────

export interface ModuleGap {
  path: string;
  complexity: "low" | "medium" | "high";
  gaps: Partial<Record<FunctionalTestType, { expected: number; current: number; gap: number }>>;
  totalGap: number;
  existingTestFiles: string[];
}

export interface CoverAISummary {
  testsWritten: number;
  testsPassed: number;
  testsFailed: number;
  files: string[];
}

// ─── Prompt Builder ─────────────────────────────────────────

/**
 * Build the AI prompt for generating tests for a single module's gaps.
 *
 * The AI will:
 * 1. Explore the module's source code using tools
 * 2. Check existing tests to avoid duplication
 * 3. Write new test files
 * 4. Run the tests
 * 5. Fix any failures
 * 6. Return a JSON summary
 */
export function buildCoverPrompt(
  gap: ModuleGap,
  project: ManifestProject,
): AIMessage[] {
  const gapDescription = Object.entries(gap.gaps)
    .map(([type, info]) => `  - ${type}: need ${info!.gap} more (${info!.current}/${info!.expected})`)
    .join("\n");

  const existingFiles = gap.existingTestFiles.length > 0
    ? `\nExisting test files for this module:\n${gap.existingTestFiles.map(f => `  - ${f}`).join("\n")}`
    : "\nNo existing test files for this module.";

  const system = `You are a senior test engineer writing tests for a ${project.language} project.

You have access to Read, Glob, Grep, Bash, Write, and Edit tools. Use them to explore source code, write test files, and run tests.

## Your Task

Write tests for the module at \`${gap.path}/\` to fill coverage gaps. Write real, working tests — not stubs or placeholders.

## Workflow

1. **Explore**: Use Glob and Read to understand the module's source files, exported functions, classes, and their behavior.
2. **Check existing**: Read any existing test files to understand patterns and avoid duplication.${existingFiles}
3. **Write tests**: Use Write tool to create test files. Follow the project's existing test patterns.
4. **Run tests**: Use Bash to execute: \`npx ${project.testFramework === "jest" ? "jest" : "vitest run"} <test-file> --no-coverage\`
5. **Fix failures**: If tests fail, read the error output, fix the test code, and re-run. Iterate until tests pass.
6. **Output summary**: After all tests pass (or you've done your best), output the JSON summary.

## Project Context

- Language: ${project.language}
- Framework: ${project.framework}
- Test Framework: ${project.testFramework}
- Module: ${gap.path}/ (${gap.complexity} complexity)

## Coverage Gaps

${gapDescription}

## Test Writing Rules

- **${project.testFramework}**: Use ${project.testFramework === "jest" ? "describe/it/expect from @jest/globals or global jest" : "describe/it/expect from 'vitest'"}.
- **Unit tests**: Mock all external dependencies. Test functions in isolation.
- **Integration tests**: Use real dependencies where possible (DI containers, database connections, service layers).
- **API tests**: Use supertest or similar to make HTTP requests to the app.
- **File placement**: Place tests at \`${gap.path}/__tests__/<name>.test.ts\` or colocated as \`${gap.path}/<name>.test.ts\`, matching existing patterns.
- **Quality**: Each test should test real behavior, not just call functions. Assert meaningful outcomes.
- **Imports**: Use correct relative import paths from the test file to source files.
- **No stubs**: Every \`it()\` block must have real assertions. Never write \`it.todo()\` or empty tests.

## Output Format

After completing all work, output ONLY this JSON (no markdown fences, no extra text):

{"testsWritten": <number of test files created>, "testsPassed": <number passing>, "testsFailed": <number still failing>, "files": ["<relative path to each test file>"]}`;

  const user = `Generate tests for ${gap.path}/ to fill the ${gap.totalGap} test gaps. Start by exploring the source code.`;

  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
}

// ─── Response Parser ────────────────────────────────────────

/**
 * Parse the AI's summary response from the cover session.
 * The AI outputs a JSON summary after writing and running tests.
 */
export function parseCoverResponse(raw: string): CoverAISummary {
  // Try to find JSON in the response
  let jsonStr = raw.trim();

  // Strip markdown fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1]!.trim();
  }

  // Find JSON object boundaries
  const startIdx = jsonStr.lastIndexOf('{"testsWritten"');
  if (startIdx !== -1) {
    const endIdx = jsonStr.indexOf("}", startIdx);
    if (endIdx !== -1) {
      jsonStr = jsonStr.slice(startIdx, endIdx + 1);
    }
  } else if (!jsonStr.startsWith("{")) {
    // Try generic JSON extraction
    const genericStart = jsonStr.lastIndexOf("{");
    const genericEnd = jsonStr.lastIndexOf("}");
    if (genericStart !== -1 && genericEnd > genericStart) {
      jsonStr = jsonStr.slice(genericStart, genericEnd + 1);
    }
  }

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    return {
      testsWritten: typeof parsed["testsWritten"] === "number" ? parsed["testsWritten"] : 0,
      testsPassed: typeof parsed["testsPassed"] === "number" ? parsed["testsPassed"] : 0,
      testsFailed: typeof parsed["testsFailed"] === "number" ? parsed["testsFailed"] : 0,
      files: Array.isArray(parsed["files"])
        ? (parsed["files"] as unknown[]).filter((f): f is string => typeof f === "string")
        : [],
    };
  } catch {
    // If we can't parse, return zeros — the rescan will pick up any written files
    return { testsWritten: 0, testsPassed: 0, testsFailed: 0, files: [] };
  }
}
