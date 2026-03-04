/**
 * Coverit Fix — AI-Driven Test Fix Prompts
 *
 * Builds prompts for the AI to fix failing tests.
 * The AI gets tool access (Read, Glob, Grep, Bash, Edit) and
 * autonomously reads failing tests, fixes them, and re-runs.
 *
 * Input: test failure output and file paths
 * Output: AI edits test files to fix failures, returns summary
 */

import type { AIMessage } from "./types.js";
import type { ManifestProject } from "../schema/coverit-manifest.js";

// ─── Types ───────────────────────────────────────────────────

export interface FixSummary {
  fixed: number;
  filesModified: string[];
}

// ─── Prompt Builder ─────────────────────────────────────────

/**
 * Build the AI prompt for fixing failing tests.
 *
 * The AI will:
 * 1. Read the failing test output to understand errors
 * 2. Read the failing test files
 * 3. Read relevant source files
 * 4. Fix the test code
 * 5. Re-run to confirm the fix
 * 6. Return a JSON summary
 */
export function buildFixPrompt(
  failureOutput: string,
  failingFiles: string[],
  project: ManifestProject,
): AIMessage[] {
  const fileList = failingFiles.map((f) => `  - ${f}`).join("\n");

  const system = `You are a senior test engineer fixing failing tests in a ${project.language} project.

You have access to Read, Glob, Grep, Bash, and Edit tools. Use them to understand failures, read source code, fix tests, and re-run them.

## Your Task

Fix the failing tests listed below. Do NOT write new tests — only fix existing ones.

## Workflow

1. **Understand failures**: Read the test output provided in the user message to identify what's failing and why.
2. **Read test files**: Use Read to examine the failing test files.
3. **Read source files**: Use Read/Grep to understand the source code the tests are testing.
4. **Fix tests**: Use Edit to fix the test code. Common fixes include:
   - Updating expected values to match actual behavior
   - Fixing import paths
   - Updating mocks to match current API signatures
   - Adding missing setup/teardown
   - Fixing async/await issues
5. **Re-run tests**: Use Bash to execute: \`npx ${project.testFramework === "jest" ? "jest" : "vitest run"} <test-file> --no-coverage\`
6. **Iterate**: If tests still fail after fixing, read the new error output and fix again. Repeat until tests pass.
7. **Output summary**: After all tests pass (or you've done your best), output the JSON summary.

## Project Context

- Language: ${project.language}
- Framework: ${project.framework}
- Test Framework: ${project.testFramework}

## Rules

- **Only fix tests** — do NOT modify source code. If a test is wrong because the source API changed, update the test to match the current source.
- **Minimal changes** — make the smallest fix that gets the test passing. Don't refactor or rewrite tests.
- **Preserve intent** — keep the original test intent. If a test checks X, the fixed test should still check X.

## Output Format

After completing all work, output ONLY this JSON (no markdown fences, no extra text):

{"fixed": <number of tests fixed>, "filesModified": ["<relative path to each modified test file>"]}`;

  const user = `Fix the ${failingFiles.length} failing test file(s) listed below.

## Failing Test Files

${fileList}

## Test Output

\`\`\`
${failureOutput}
\`\`\`

Start by reading the test output above, then read and fix each file.`;

  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
}

// ─── Response Parser ────────────────────────────────────────

/**
 * Parse the AI's summary response from the fix session.
 */
export function parseFixResponse(raw: string): FixSummary {
  let jsonStr = raw.trim();

  // Strip markdown fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1]!.trim();
  }

  // Find JSON object boundaries
  const startIdx = jsonStr.lastIndexOf('{"fixed"');
  if (startIdx !== -1) {
    const endIdx = jsonStr.indexOf("}", startIdx);
    if (endIdx !== -1) {
      jsonStr = jsonStr.slice(startIdx, endIdx + 1);
    }
  } else if (!jsonStr.startsWith("{")) {
    const genericStart = jsonStr.lastIndexOf("{");
    const genericEnd = jsonStr.lastIndexOf("}");
    if (genericStart !== -1 && genericEnd > genericStart) {
      jsonStr = jsonStr.slice(genericStart, genericEnd + 1);
    }
  }

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    return {
      fixed: typeof parsed["fixed"] === "number" ? parsed["fixed"] : 0,
      filesModified: Array.isArray(parsed["filesModified"])
        ? (parsed["filesModified"] as unknown[]).filter(
            (f): f is string => typeof f === "string",
          )
        : [],
    };
  } catch {
    return { fixed: 0, filesModified: [] };
  }
}
