/**
 * Coverit — Stability Test Generator
 *
 * Generates edge case and error path tests from stability findings.
 * Each finding produces a targeted test that verifies the code handles
 * the identified issue correctly (or exposes it as a regression guard).
 *
 * The generator uses AI to write test code because the test structure
 * depends on the specific finding context (framework, error type,
 * resource kind, etc.). Tests are returned as GeneratorResult so they
 * can be written to disk and executed by the standard pipeline.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { AIProvider, AIMessage } from "../ai/types.js";
import type { GeneratorResult, GeneratedTest, SkippedItem, ProjectInfo } from "../types/index.js";
import type { StabilityFinding } from "../ai/stability-prompts.js";
import { logger } from "../utils/logger.js";

// ─── Configuration ──────────────────────────────────────────

/** Maximum number of findings to generate tests for in a single run */
const MAX_FINDINGS_PER_RUN = 15;

/** Maximum file size to include as context in the generation prompt */
const MAX_SOURCE_SIZE = 30_000;

// ─── Public API ─────────────────────────────────────────────

/**
 * Generate edge case and error path tests from stability findings.
 *
 * Groups findings by file, reads the source code for context, and
 * produces one test file per source file. Findings for the same file
 * are combined into a single test suite.
 *
 * @param findings - Stability issues found by the analyzer
 * @param projectRoot - Absolute path to the project root
 * @param aiProvider - AI provider for test generation
 * @param project - Project metadata (framework, test runner, etc.)
 * @returns Generated test files, warnings, and skipped items
 */
export async function generateStabilityTests(
  findings: StabilityFinding[],
  projectRoot: string,
  aiProvider: AIProvider,
  project?: ProjectInfo,
): Promise<GeneratorResult> {
  const tests: GeneratedTest[] = [];
  const warnings: string[] = [];
  const skipped: SkippedItem[] = [];

  if (findings.length === 0) {
    return { tests, warnings, skipped };
  }

  // Prioritize high-severity findings and cap total
  const prioritized = prioritizeFindings(findings).slice(
    0,
    MAX_FINDINGS_PER_RUN,
  );

  if (prioritized.length < findings.length) {
    warnings.push(
      `Capped at ${MAX_FINDINGS_PER_RUN} findings (${findings.length} total). Remaining findings skipped.`,
    );
  }

  // Group findings by file for efficient test generation
  const byFile = groupByFile(prioritized);

  for (const [filePath, fileFindings] of byFile) {
    try {
      const result = await generateTestsForFile(
        filePath,
        fileFindings,
        projectRoot,
        aiProvider,
        project,
      );

      if (result) {
        tests.push(result);
      } else {
        skipped.push({
          target: filePath,
          reason: "AI returned non-code or empty response",
        });
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      warnings.push(`Failed to generate stability tests for ${filePath}: ${message}`);
    }
  }

  return { tests, warnings, skipped };
}

// ─── Per-File Generation ────────────────────────────────────

/**
 * Generate a stability test file for all findings in a single source file.
 */
async function generateTestsForFile(
  filePath: string,
  findings: StabilityFinding[],
  projectRoot: string,
  aiProvider: AIProvider,
  project?: ProjectInfo,
): Promise<GeneratedTest | null> {
  // Read source file for context
  const absolutePath = path.join(projectRoot, filePath);
  let sourceContent: string;

  try {
    sourceContent = await fs.readFile(absolutePath, "utf-8");
  } catch {
    logger.debug(`Cannot read source file for test generation: ${filePath}`);
    return null;
  }

  // Truncate large files to stay within token limits
  if (sourceContent.length > MAX_SOURCE_SIZE) {
    sourceContent =
      sourceContent.slice(0, MAX_SOURCE_SIZE) +
      "\n// ... (file truncated for analysis)";
  }

  const testFilePath = deriveTestFilePath(filePath);
  const framework = project?.testFramework ?? "jest";

  const messages = buildStabilityTestPrompt(
    filePath,
    sourceContent,
    findings,
    testFilePath,
    framework,
    project,
  );

  const response = await aiProvider.generate(messages, {
    temperature: 0.2,
    maxTokens: 12288,
  });

  const content = response.content.trim();
  if (!content) return null;

  const code = extractCodeFromResponse(content);
  if (!looksLikeTestCode(code)) {
    return null;
  }

  return {
    planId: `stability_${path.basename(filePath, path.extname(filePath))}`,
    filePath: testFilePath,
    content: code,
    testType: "unit",
    testCount: countTestCases(code),
    framework,
  };
}

// ─── Prompt Construction ────────────────────────────────────

function buildStabilityTestPrompt(
  filePath: string,
  sourceContent: string,
  findings: StabilityFinding[],
  testFilePath: string,
  framework: string,
  project?: ProjectInfo,
): AIMessage[] {
  const findingsList = findings
    .map(
      (f, i) =>
        `${i + 1}. [${f.severity.toUpperCase()}] Line ${f.line} — ${f.check}: ${f.description}\n   Recommendation: ${f.recommendation}`,
    )
    .join("\n");

  // Compute relative import path from test file to source file
  const testDir = path.dirname(testFilePath);
  const sourceDir = path.dirname(filePath);
  let relativePath = path.relative(testDir, sourceDir);
  const sourceBase = path.basename(filePath).replace(/\.[^.]+$/, "");
  if (!relativePath || relativePath === ".") {
    relativePath = `./${sourceBase}`;
  } else {
    relativePath = `${relativePath.startsWith(".") ? relativePath : "./" + relativePath}/${sourceBase}`;
  }

  const lang = project?.language ?? "typescript";
  const frameworkImport =
    framework === "vitest"
      ? `import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";`
      : `// Jest globals: describe, it, expect, jest, beforeEach, afterEach`;

  const systemPrompt = `You are an expert test engineer writing stability and edge case tests.

FRAMEWORK: ${framework}

HARD RULES:
1. Output ONLY the complete test file content. No markdown fences, no explanations.
2. Write tests that expose or guard against the specific stability issues listed below.
3. For error handling issues: test that errors are caught, propagated, or handled correctly.
4. For edge case issues: test boundary conditions (null, undefined, empty, zero, negative, max values).
5. For resource cleanup issues: test that resources are released in both success and error paths.
6. For graceful degradation issues: test behavior when dependencies fail (mock failures, timeouts).
7. Mock ALL external dependencies (databases, HTTP clients, queues, file system where appropriate).
8. Each test should have a clear name explaining what stability concern it validates.
9. Use realistic test data and meaningful assertions.`;

  const userPrompt = `## Source File: ${filePath}
\`\`\`${lang}
${sourceContent}
\`\`\`

## Stability Findings to Test
${findingsList}

## Test File Path: ${testFilePath}

## Import Setup
${frameworkImport}
Import the module under test from "${relativePath}".

Write a complete test file that covers each stability finding above. Group related tests in describe blocks. Focus on:
- Error paths and exception handling
- Boundary values and null/undefined inputs
- Resource cleanup verification
- Graceful handling of dependency failures`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Derive a stability test file path from the source file path.
 * Example: src/services/user.service.ts -> src/services/user.service.stability.test.ts
 */
function deriveTestFilePath(sourcePath: string): string {
  const ext = path.extname(sourcePath);
  const base = sourcePath.slice(0, -ext.length);
  return `${base}.stability.test${ext}`;
}

/**
 * Prioritize findings: high severity first, then medium, then low.
 */
function prioritizeFindings(
  findings: StabilityFinding[],
): StabilityFinding[] {
  const severityOrder: Record<string, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };

  return [...findings].sort(
    (a, b) =>
      (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3),
  );
}

/**
 * Group findings by their source file path.
 */
function groupByFile(
  findings: StabilityFinding[],
): Map<string, StabilityFinding[]> {
  const groups = new Map<string, StabilityFinding[]>();

  for (const finding of findings) {
    const existing = groups.get(finding.file);
    if (existing) {
      existing.push(finding);
    } else {
      groups.set(finding.file, [finding]);
    }
  }

  return groups;
}

/**
 * Extract code from AI response, stripping markdown fences if present.
 */
function extractCodeFromResponse(response: string): string {
  let code = response.trim();

  // Strip markdown code fences
  const fenceMatch = code.match(
    /```(?:typescript|javascript|ts|js)?\s*\n([\s\S]*?)\n```/,
  );
  if (fenceMatch?.[1]) {
    code = fenceMatch[1].trim();
  }

  return code;
}

/**
 * Heuristic check that the AI response actually contains test code
 * rather than an explanation or error message.
 */
function looksLikeTestCode(code: string): boolean {
  // Must contain test-related keywords
  const hasTestKeywords =
    /(?:describe|it|test|expect)\s*\(/.test(code);
  // Must contain import or require
  const hasImport =
    /(?:import\s|require\s*\()/.test(code) ||
    /(?:describe|it|test)\s*\(/.test(code);

  return hasTestKeywords && hasImport;
}

/**
 * Count test cases in generated code by matching it() and test() calls.
 */
function countTestCases(code: string): number {
  let count = 0;
  const lines = code.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    const matches = trimmed.match(
      /(?:^|[^.\w])(?:it|test)\s*(?:\.(?:each|only|skip|todo)\s*(?:\([^)]*\)\s*)?)?\s*\(/g,
    );
    if (matches) {
      count += matches.length;
    }
  }

  return Math.max(count, 1);
}
