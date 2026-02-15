/**
 * Coverit — Triage Prompt Construction & Response Parsing
 *
 * Builds the AI prompt for deciding what tests to write,
 * and parses the structured JSON response into a TriageResult.
 *
 * The AI receives file references (paths + stats) and uses the
 * Read tool to incrementally examine files it needs to analyze.
 * All filtering decisions are left entirely to the AI.
 */

import type { AIMessage } from "./types.js";
import type {
  ContextBundle,
  TestType,
  TriageResult,
  TriagePlan,
  TriageSkipped,
} from "../types/index.js";

/**
 * Build the triage prompt messages.
 * Sends file references (not content) — the AI uses Read tool to examine files.
 */
export function buildTriagePrompt(
  context: ContextBundle,
  options?: { testTypes?: TestType[]; scanMode?: "all" | "diff" },
): AIMessage[] {
  const isFullScan = options?.scanMode === "all";

  const systemDiff = `You are an expert test engineer deciding what tests to write for a code change.

You have access to the Read tool. Use it to examine any source files or test files you need to analyze. Do NOT try to decide based on file names alone — read the actual code.

## Your workflow:
1. Review the file list below (paths, status, line changes)
2. Use the Read tool to examine source files that look like they have significant changes
3. Use the Read tool to check existing test files to understand current coverage
4. Decide which files need new or additional tests
5. Output your triage plan as JSON

## Rules:
- Skip files with no testable runtime behavior (pure types, interfaces, enums, configs, styles, DTOs with only decorators, module files that just wire DI, schema definitions, constant files). You can Read them to verify before skipping.
- When an existing test file covers a source file AND was modified in this PR (marked **[IN THIS PR: +N lines]**), Read both files to check if the tests already cover the changes. SKIP if adequately covered.
- If an existing test file was NOT modified in this PR, create a plan only if the source has significant new behavior.
- Group related files into a single plan when they form a cohesive unit.
- For API routes/controllers, use "api" test type. For services/utilities, use "unit".
- Set priority: "critical" for major new logic, "high" for moderate, "medium" for minor, "low" for trivial.
- CRITICAL: Every plan MUST have a unique outputTestFile. If multiple files share a test file, merge into one plan with multiple targetFiles.
- Be selective — focus on files with significant new testable logic.
- Write specific descriptions mentioning the actual methods/features to test.
- IMPORTANT — Split large methods: If a single method or function is longer than ~150 lines, split it into multiple plans by logical concern (e.g., validation, business logic, error handling, side effects). Each sub-plan should have a unique outputTestFile (e.g., service.validation.spec.ts, service.payment.spec.ts). This ensures each generation call stays focused and completes within time limits.`;

  const systemAll = `You are an expert test engineer performing a full project coverage audit.

You have access to the Read tool. Use it to examine any source files or test files you need to analyze. Do NOT try to decide based on file names alone — read the actual code.

## Your workflow:
1. Review the file list below (all source files in the project)
2. Use the Read tool to examine source files that look like they have significant testable logic
3. Use the Read tool to check existing test files to understand current coverage
4. Identify files that are UNTESTED or have insufficient test coverage
5. Output your triage plan as JSON

## Rules:
- Focus on finding **untested** files — files with runtime behavior that have no corresponding test file.
- Skip files with no testable runtime behavior (pure types, interfaces, enums, configs, styles, DTOs with only decorators, module files that just wire DI, schema definitions, constant files). You can Read them to verify before skipping.
- If an existing test file already provides good coverage for a source file, skip it.
- Group related files into a single plan when they form a cohesive unit.
- For API routes/controllers, use "api" test type. For services/utilities, use "unit".
- Set priority: "critical" for core logic with no tests, "high" for important modules, "medium" for utilities, "low" for trivial.
- CRITICAL: Every plan MUST have a unique outputTestFile. If multiple files share a test file, merge into one plan with multiple targetFiles.
- Cap at 20 plans maximum — focus on the highest-value targets first.
- Write specific descriptions mentioning the actual methods/features to test.
- IMPORTANT — Split large files: If a source file is longer than ~300 lines, split it into multiple plans by logical concern. Each sub-plan should have a unique outputTestFile.`;

  const outputFormat = `

## Output format — after reading files and analyzing, respond with ONLY valid JSON:
{
  "plans": [{
    "targetFiles": ["src/services/user.service.ts"],
    "testTypes": ["unit"],
    "existingTestFile": "src/services/user.service.test.ts",
    "outputTestFile": "src/services/user.service.test.ts",
    "description": "Add tests for new createUser validation and deleteUser cascade logic",
    "priority": "critical",
    "environment": "local"
  }],
  "skipped": [
    { "path": "src/types/index.ts", "reason": "Type-only file, no runtime behavior" }
  ]
}`;

  const system = (isFullScan ? systemAll : systemDiff) + outputFormat;

  const userParts: string[] = [];

  // Project metadata
  userParts.push(`## Project`);
  userParts.push(`- Name: ${context.project.name}`);
  userParts.push(`- Framework: ${context.project.framework}`);
  userParts.push(`- Test framework: ${context.project.testFramework}`);
  userParts.push(`- Package manager: ${context.project.packageManager}`);
  userParts.push(`- Language: ${context.project.language}`);
  userParts.push("");

  // Build a set of test file paths that are part of the diff
  const testFilesInDiff = new Map<string, { additions: number; deletions: number }>();
  for (const file of context.changedFiles) {
    if (/\.(test|spec)\.[jt]sx?$/.test(file.path)) {
      testFilesInDiff.set(file.path, { additions: file.additions, deletions: file.deletions });
    }
  }

  // Source files — paths and stats only (no content)
  userParts.push(isFullScan ? `## Source Files` : `## Changed Source Files`);
  userParts.push(`Use the Read tool to examine files you need to analyze.`);
  userParts.push("");
  for (const file of context.changedFiles) {
    // Skip test files from the source list
    if (/\.(test|spec)\.[jt]sx?$/.test(file.path)) continue;
    if (isFullScan) {
      userParts.push(`- ${file.path} (${file.additions} lines)`);
    } else {
      userParts.push(`- ${file.path} (${file.status}, +${file.additions}/-${file.deletions})`);
    }
  }
  userParts.push("");

  // Existing test files — paths, stats, and coverage info
  if (context.existingTests.length > 0) {
    userParts.push(`## Existing Test Files`);
    userParts.push(`These test files already exist and cover the source files above.`);
    userParts.push(`Files marked [IN THIS PR] were already written/updated by the developer in this PR.`);
    userParts.push(`Use the Read tool to examine test files when you need to check coverage.`);
    userParts.push("");
    for (const test of context.existingTests) {
      const imports = test.importsFrom.length > 0
        ? ` (imports: ${test.importsFrom.join(", ")})`
        : "";
      const diffInfo = testFilesInDiff.get(test.path);
      const diffTag = diffInfo
        ? ` **[IN THIS PR: +${diffInfo.additions}/-${diffInfo.deletions} lines]**`
        : "";
      const lineCount = test.content.split("\n").length;
      userParts.push(`- ${test.path} (${lineCount} lines)${imports}${diffTag}`);
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
 * Merge plans that share the same outputTestFile into a single plan.
 * Prevents parallel sub-agents from writing to the same file.
 */
function deduplicatePlans(plans: TriagePlan[]): TriagePlan[] {
  const byOutput = new Map<string, TriagePlan[]>();
  for (const plan of plans) {
    const key = plan.outputTestFile;
    const group = byOutput.get(key);
    if (group) {
      group.push(plan);
    } else {
      byOutput.set(key, [plan]);
    }
  }

  const merged: TriagePlan[] = [];
  let idx = 0;
  for (const group of byOutput.values()) {
    idx++;
    if (group.length === 1) {
      merged.push({ ...group[0]!, id: `plan_${String(idx).padStart(3, "0")}` });
    } else {
      const targetFiles = [...new Set(group.flatMap((p) => p.targetFiles))];
      const testTypes = [...new Set(group.flatMap((p) => p.testTypes))] as TriagePlan["testTypes"];
      const descriptions = group.map((p) => p.description).join("; ");
      const priorityOrder: TriagePlan["priority"][] = ["critical", "high", "medium", "low"];
      const priority = priorityOrder.find((pr) => group.some((p) => p.priority === pr)) ?? "medium";

      merged.push({
        id: `plan_${String(idx).padStart(3, "0")}`,
        targetFiles,
        testTypes,
        existingTestFile: group[0]!.existingTestFile,
        outputTestFile: group[0]!.outputTestFile,
        description: descriptions,
        priority,
        environment: group[0]!.environment,
      });
    }
  }

  return merged;
}

/**
 * Try to extract a JSON object from text that may contain preamble
 * (e.g. from multi-turn tool use where the AI outputs intermediate text).
 * Walks backwards from the last } to find matching { pairs.
 */
function extractJSONFromText(text: string): unknown | null {
  const lastBrace = text.lastIndexOf("}");
  if (lastBrace < 0) return null;

  let depth = 0;
  for (let i = lastBrace; i >= 0; i--) {
    if (text[i] === "}") depth++;
    if (text[i] === "{") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(i, lastBrace + 1));
        } catch {
          // Not valid JSON at this position, keep searching
        }
      }
    }
  }

  return null;
}

/**
 * Parse the AI triage response JSON into a TriageResult.
 * Handles multi-turn responses where the AI may include preamble text
 * from tool use before the final JSON output.
 */
export function parseTriageResponse(response: string): TriageResult {
  let cleaned = response.trim();

  // Strip markdown fences if present
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch?.[1]) {
    cleaned = fenceMatch[1].trim();
  }

  // Try direct JSON parse first
  let parsed = tryParseJSON(cleaned);

  // If that fails, extract JSON from text with preamble
  if (!parsed) {
    parsed = extractJSONFromText(cleaned) as Record<string, unknown> | null;
  }

  if (!parsed) {
    return { plans: [], skipped: [] };
  }

  try {
    const data = parsed as {
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

    const rawPlans: TriagePlan[] = (data.plans ?? []).map((p, i) => ({
      id: `plan_${String(i + 1).padStart(3, "0")}`,
      targetFiles: p.targetFiles ?? [],
      testTypes: (p.testTypes ?? ["unit"]) as TestType[],
      existingTestFile: p.existingTestFile ?? null,
      outputTestFile: p.outputTestFile ?? `test_${i + 1}.test.ts`,
      description: p.description ?? "Generated test plan",
      priority: (p.priority as TriagePlan["priority"]) ?? "medium",
      environment: (p.environment as TriagePlan["environment"]) ?? "local",
    }));

    const plans = deduplicatePlans(rawPlans);

    const skipped: TriageSkipped[] = (data.skipped ?? []).map((s) => ({
      path: s.path ?? "unknown",
      reason: s.reason ?? "Skipped by AI triage",
    }));

    return { plans, skipped };
  } catch {
    return { plans: [], skipped: [] };
  }
}

function tryParseJSON(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}
