/**
 * Coverit — Triage Prompt Construction & Response Parsing
 *
 * Builds the lightweight AI prompt for deciding what tests to write,
 * and parses the structured JSON response into a TriageResult.
 */

import type { AIMessage } from "./types.js";
import type {
  ContextBundle,
  TestType,
  TriageResult,
  TriagePlan,
  TriageSkipped,
} from "../types/index.js";

const FIRST_N_LINES = 30;

/**
 * Build the triage prompt messages. Lightweight (~3-5K tokens):
 * - Project metadata
 * - File list with status, additions/deletions, first ~30 lines
 * - Existing test file names + which source files they import
 * - Test type filters (if any)
 */
export function buildTriagePrompt(
  context: ContextBundle,
  options?: { testTypes?: TestType[] },
): AIMessage[] {
  const system = `You are an expert test engineer deciding what tests to write for a code change.

Analyze the changed files and decide:
1. Which files need tests (skip type-only files, configs, styles, generated files)
2. What kind of tests (unit, api, e2e-browser, etc.)
3. Whether to extend existing test files or create new ones
4. What output file path each test should have

RULES:
- Group related files into a single plan when they form a cohesive unit (e.g. a service + its types)
- When an existing test file already covers a changed source file, set existingTestFile to extend it
- Skip files that have no testable runtime behavior (pure types, interfaces, enums, configs, styles)
- For API routes/controllers, include "api" test type
- For React components, include "unit" (and optionally "e2e-browser" for pages)
- For services/utilities, include "unit"
- Set priority: "critical" for directly changed files, "high" for files depended on by changes

OUTPUT FORMAT — respond with ONLY valid JSON, no markdown fences, no commentary:
{
  "plans": [{
    "targetFiles": ["src/services/user.service.ts"],
    "testTypes": ["unit"],
    "existingTestFile": "src/services/user.service.test.ts",
    "outputTestFile": "src/services/user.service.test.ts",
    "description": "Add tests for new createUser and deleteUser methods",
    "priority": "critical",
    "environment": "local"
  }],
  "skipped": [
    { "path": "src/types/index.ts", "reason": "Type-only file, no runtime behavior" }
  ]
}`;

  const userParts: string[] = [];

  // Project metadata
  userParts.push(`## Project`);
  userParts.push(`- Name: ${context.project.name}`);
  userParts.push(`- Framework: ${context.project.framework}`);
  userParts.push(`- Test framework: ${context.project.testFramework}`);
  userParts.push(`- Package manager: ${context.project.packageManager}`);
  userParts.push(`- Language: ${context.project.language}`);
  userParts.push("");

  // Diff summary
  userParts.push(`## Diff Summary`);
  userParts.push(context.diffSummary);
  userParts.push("");

  // Changed files with first N lines
  userParts.push(`## Changed Files`);
  for (const file of context.changedFiles) {
    const firstLines = file.sourceCode
      .split("\n")
      .slice(0, FIRST_N_LINES)
      .join("\n");
    userParts.push(`### ${file.path} (${file.status}, +${file.additions}/-${file.deletions})`);
    userParts.push("```");
    userParts.push(firstLines);
    userParts.push("```");
    userParts.push("");
  }

  // Existing test files
  if (context.existingTests.length > 0) {
    userParts.push(`## Existing Test Files`);
    for (const test of context.existingTests) {
      const imports = test.importsFrom.length > 0
        ? ` (imports: ${test.importsFrom.join(", ")})`
        : "";
      userParts.push(`- ${test.path}${imports}`);
    }
    userParts.push("");
  }

  // Test type filter
  if (options?.testTypes && options.testTypes.length > 0) {
    userParts.push(`## Constraints`);
    userParts.push(`Only generate plans for these test types: ${options.testTypes.join(", ")}`);
    userParts.push("");
  }

  return [
    { role: "system", content: system },
    { role: "user", content: userParts.join("\n") },
  ];
}

/**
 * Parse the AI triage response JSON into a TriageResult.
 * Handles malformed responses gracefully.
 */
export function parseTriageResponse(response: string): TriageResult {
  // Strip markdown fences if present
  let cleaned = response.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch?.[1]) {
    cleaned = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(cleaned) as {
      plans?: Array<{
        targetFiles?: string[];
        testTypes?: string[];
        existingTestFile?: string | null;
        outputTestFile?: string;
        description?: string;
        priority?: string;
        environment?: string;
      }>;
      skipped?: Array<{
        path?: string;
        reason?: string;
      }>;
    };

    const plans: TriagePlan[] = (parsed.plans ?? []).map((p, i) => ({
      id: `plan_${String(i + 1).padStart(3, "0")}`,
      targetFiles: p.targetFiles ?? [],
      testTypes: (p.testTypes ?? ["unit"]) as TestType[],
      existingTestFile: p.existingTestFile ?? null,
      outputTestFile: p.outputTestFile ?? `test_${i + 1}.test.ts`,
      description: p.description ?? "Generated test plan",
      priority: (p.priority as TriagePlan["priority"]) ?? "medium",
      environment: (p.environment as TriagePlan["environment"]) ?? "local",
    }));

    const skipped: TriageSkipped[] = (parsed.skipped ?? []).map((s) => ({
      path: s.path ?? "unknown",
      reason: s.reason ?? "Skipped by AI triage",
    }));

    return { plans, skipped };
  } catch {
    // If JSON parsing fails, return an empty result
    return { plans: [], skipped: [] };
  }
}
