/**
 * Targeted Generator — Gap-Driven Test Generation
 *
 * Generates tests for specific gaps identified by the gap analyzer.
 * Selects the appropriate prompt builder based on test type and
 * delegates to the AI provider. Validates output with the same
 * guards used by the existing AIGenerator (looksLikeTestCode, etc.).
 *
 * This replaces the "AI decides everything" flow with a deterministic
 * pipeline: manifest -> gaps -> targeted prompts -> validated output.
 */

import { readFile } from "node:fs/promises";
import { join, basename, dirname, extname } from "node:path";
import { readdir, stat } from "node:fs/promises";
import type { AIProvider, AIMessage } from "../ai/types.js";
import type {
  GeneratedTest,
  GeneratorResult,
  SkippedItem,
  TestFramework,
  TestType,
  ProjectInfo,
} from "../types/index.js";
import type { FunctionalTestType } from "../schema/coverit-manifest.js";
import type { Gap } from "./gap-analyzer.js";
import { buildTestGenerationPrompt } from "../ai/prompts.js";
import { buildIntegrationPrompt } from "../ai/integration-prompts.js";
import { buildApiPrompt } from "../ai/api-prompts.js";
import { buildContractPrompt } from "../ai/contract-prompts.js";

// ─── Public API ────────────────────────────────────────────

/**
 * Generate tests for a set of prioritized gaps. Processes gaps
 * sequentially to avoid overwhelming the AI provider with
 * concurrent requests.
 */
export async function generateForGaps(
  gaps: Gap[],
  projectRoot: string,
  aiProvider: AIProvider,
  project: ProjectInfo,
): Promise<GeneratorResult> {
  const tests: GeneratedTest[] = [];
  const warnings: string[] = [];
  const skipped: SkippedItem[] = [];

  for (const gap of gaps) {
    try {
      const result = await generateForSingleGap(
        gap,
        projectRoot,
        aiProvider,
        project,
      );
      tests.push(...result.tests);
      warnings.push(...result.warnings);
      skipped.push(...result.skipped);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(
        `Failed to generate ${gap.testType} tests for ${gap.modulePath}: ${msg}`,
      );
    }
  }

  return { tests, warnings, skipped };
}

// ─── Single Gap Generation ─────────────────────────────────

async function generateForSingleGap(
  gap: Gap,
  projectRoot: string,
  aiProvider: AIProvider,
  project: ProjectInfo,
): Promise<GeneratorResult> {
  const tests: GeneratedTest[] = [];
  const warnings: string[] = [];
  const skipped: SkippedItem[] = [];

  // Resolve and read source files for this gap's module
  const sourceContents = await readSourceFiles(gap.sourceFiles, projectRoot);

  if (sourceContents.length === 0) {
    skipped.push({
      target: gap.modulePath,
      reason: `No readable source files found for module "${gap.modulePath}"`,
    });
    return { tests, warnings, skipped };
  }

  const outputTestFile = resolveOutputTestFile(gap, project);
  const messages = buildPromptForGap(gap, sourceContents, outputTestFile, project);

  const response = await aiProvider.generate(messages, {
    temperature: 0.2,
    maxTokens: 16384,
  });

  let content = response.content.trim();
  if (!content) {
    warnings.push(
      `AI returned empty response for ${gap.testType} tests in ${gap.modulePath}`,
    );
    return { tests, warnings, skipped };
  }

  let code = extractCodeFromResponse(content);

  if (!looksLikeTestCode(code)) {
    // Check for token limit errors and retry with truncated source
    if (isPromptTooLongError(content)) {
      console.warn(
        `[coverit] Prompt too long for ${gap.modulePath}, retrying with truncated source...`,
      );
      const truncatedSources = sourceContents.map((s) => ({
        ...s,
        content: s.content.slice(0, 5_000),
      }));
      const retryMessages = buildPromptForGap(
        gap,
        truncatedSources,
        outputTestFile,
        project,
      );
      const retryResponse = await aiProvider.generate(retryMessages, {
        temperature: 0.2,
        maxTokens: 16384,
      });
      const retryContent = retryResponse.content.trim();
      if (retryContent) {
        code = extractCodeFromResponse(retryContent);
      }
      if (!looksLikeTestCode(code)) {
        warnings.push(
          `AI returned non-code response for ${gap.testType} in ${gap.modulePath} (even after retry)`,
        );
        return { tests, warnings, skipped };
      }
    } else {
      warnings.push(
        `AI returned non-code response for ${gap.testType} in ${gap.modulePath}: ${content.slice(0, 120)}`,
      );
      return { tests, warnings, skipped };
    }
  }

  // Handle truncation by attempting auto-close
  if (isTruncated(code)) {
    const repaired = autoCloseBraces(code);
    if (repaired && !isTruncated(repaired)) {
      warnings.push(
        `AI generation for ${gap.modulePath} was truncated — auto-closed braces`,
      );
      code = repaired;
    } else {
      warnings.push(
        `AI generation for ${gap.modulePath} was truncated beyond repair`,
      );
      return { tests, warnings, skipped };
    }
  }

  const testCount = countTestCases(code);
  const framework = resolveTestFramework(project.testFramework);

  tests.push({
    planId: `gap_${gap.modulePath}_${gap.testType}`,
    filePath: outputTestFile,
    content: code,
    testType: mapFunctionalToTestType(gap.testType),
    testCount,
    framework,
  });

  return { tests, warnings, skipped };
}

// ─── Prompt Routing ────────────────────────────────────────

/**
 * Select the appropriate prompt builder based on the gap's test type.
 * Each test type has specialized instructions that produce better
 * results than a generic "write tests" prompt.
 */
function buildPromptForGap(
  gap: Gap,
  sourceFiles: Array<{ path: string; content: string }>,
  outputTestFile: string,
  project: ProjectInfo,
): AIMessage[] {
  const commonParams = {
    modulePath: gap.modulePath,
    sourceFiles,
    outputTestFile,
    project,
    gapDescription: gap.description,
    expectedTests: gap.missing,
  };

  switch (gap.testType) {
    case "integration":
      return buildIntegrationPrompt(commonParams);

    case "api":
      return buildApiPrompt(commonParams);

    case "contract":
      return buildContractPrompt(commonParams);

    case "unit":
      // Reuse the existing generation prompt by constructing a TriagePlan-like input
      return buildTestGenerationPrompt({
        plan: {
          id: `gap_${gap.modulePath}_unit`,
          targetFiles: sourceFiles.map((f) => f.path),
          testTypes: ["unit"],
          existingTestFile: null,
          outputTestFile,
          description: gap.description,
          priority: gap.priority,
          environment: "local",
        },
        project,
        sourceFiles: sourceFiles.map((f) => ({
          path: f.path,
          content: f.content,
          hunks: [],
        })),
        existingTestContent: null,
        testTypes: ["unit"],
      });

    case "e2e":
      // E2E uses the existing prompt with e2e-browser type
      return buildTestGenerationPrompt({
        plan: {
          id: `gap_${gap.modulePath}_e2e`,
          targetFiles: sourceFiles.map((f) => f.path),
          testTypes: ["e2e-browser"],
          existingTestFile: null,
          outputTestFile,
          description: gap.description,
          priority: gap.priority,
          environment: "local",
        },
        project,
        sourceFiles: sourceFiles.map((f) => ({
          path: f.path,
          content: f.content,
          hunks: [],
        })),
        existingTestContent: null,
        testTypes: ["e2e-browser"],
      });
  }
}

// ─── Output File Resolution ────────────────────────────────

/**
 * Determine where to write the generated test file based on
 * the gap's module path and test type.
 */
function resolveOutputTestFile(gap: Gap, project: ProjectInfo): string {
  // For journey/contract meta-gaps, use a dedicated test directory
  if (gap.modulePath === "(journey)") {
    return `test/e2e/journey.e2e.test.${getExtension(project.language)}`;
  }
  if (gap.modulePath === "(contracts)") {
    return `test/contracts/api-contracts.test.${getExtension(project.language)}`;
  }

  // For module gaps, place tests alongside or in __tests__
  const suffixMap: Record<FunctionalTestType, string> = {
    unit: "test",
    integration: "integration.test",
    api: "api.test",
    e2e: "e2e.test",
    contract: "contract.test",
  };

  const suffix = suffixMap[gap.testType];

  // If we have a specific source file, derive from it
  if (gap.sourceFiles.length > 0 && gap.sourceFiles[0] !== gap.modulePath) {
    const sourceFile = gap.sourceFiles[0]!;
    const dir = dirname(sourceFile);
    const ext = extname(sourceFile);
    const name = basename(sourceFile, ext);
    return `${dir}/${name}.${suffix}${ext}`;
  }

  // Fallback: use module path as basis
  const ext = `.${getExtension(project.language)}`;
  const moduleName = basename(gap.modulePath);
  return `${gap.modulePath}/${moduleName}.${suffix}${ext}`;
}

function getExtension(language: string): string {
  if (language === "typescript") return "ts";
  if (language === "javascript") return "js";
  return "ts";
}

// ─── File I/O ──────────────────────────────────────────────

/**
 * Read source files from disk. Handles both individual file paths
 * and directory paths (globs for *.ts/*.js files in the directory).
 */
async function readSourceFiles(
  sourcePaths: string[],
  projectRoot: string,
): Promise<Array<{ path: string; content: string }>> {
  const results: Array<{ path: string; content: string }> = [];

  for (const sourcePath of sourcePaths) {
    const absolutePath = join(projectRoot, sourcePath);

    try {
      const fileStat = await stat(absolutePath);

      if (fileStat.isFile()) {
        const content = await readFile(absolutePath, "utf-8");
        results.push({ path: sourcePath, content });
      } else if (fileStat.isDirectory()) {
        // Read all source files in the directory (non-recursive)
        const entries = await readdir(absolutePath);
        for (const entry of entries) {
          if (!isSourceFile(entry)) continue;
          const entryPath = join(absolutePath, entry);
          const entryStat = await stat(entryPath);
          if (!entryStat.isFile()) continue;
          const content = await readFile(entryPath, "utf-8");
          results.push({ path: `${sourcePath}/${entry}`, content });
        }
      }
    } catch {
      // File/directory not readable — skip silently, caller handles empty results
    }
  }

  return results;
}

function isSourceFile(filename: string): boolean {
  return /\.(ts|tsx|js|jsx)$/.test(filename) && !/\.(test|spec|d)\./i.test(filename);
}

// ─── Type Mapping ──────────────────────────────────────────

/**
 * Map manifest's FunctionalTestType to the core TestType union.
 * The manifest uses "e2e" while the core type system uses "e2e-browser".
 */
function mapFunctionalToTestType(ft: FunctionalTestType): TestType {
  if (ft === "e2e") return "e2e-browser";
  // "unit", "integration", "api" exist in both unions
  return ft as TestType;
}

// ─── Code Validation Utilities ─────────────────────────────
// Replicated from ai-generator.ts to avoid coupling to the class

function extractCodeFromResponse(raw: string): string {
  // Try anchored first (entire response is a code fence)
  const anchoredMatch = raw.match(
    /^```(?:typescript|ts|javascript|js|tsx|jsx)?\s*\n([\s\S]*?)\n```\s*$/,
  );
  if (anchoredMatch?.[1]) return anchoredMatch[1].trim();

  // Fallback: find the largest code fence anywhere in the response
  const fenceMatches = [
    ...raw.matchAll(
      /```(?:typescript|ts|javascript|js|tsx|jsx)?\s*\n([\s\S]*?)\n```/g,
    ),
  ];
  if (fenceMatches.length > 0) {
    const longest = fenceMatches.reduce((a, b) =>
      (a[1]?.length ?? 0) >= (b[1]?.length ?? 0) ? a : b,
    );
    if (longest[1]) return longest[1].trim();
  }

  return stripPreamble(raw);
}

function stripPreamble(raw: string): string {
  const lines = raw.split("\n");
  const codePattern =
    /^\s*(import\s|export\s|const\s|let\s|var\s|function\s|class\s|\/\/|\/\*|describe\s*\(|it\s*\(|test\s*\(|['"]use\s)/;
  for (let i = 0; i < lines.length; i++) {
    if (codePattern.test(lines[i]!)) {
      if (i === 0) return raw;
      return lines.slice(i).join("\n");
    }
  }
  return raw;
}

function looksLikeTestCode(code: string): boolean {
  const hasImports = /\b(import\s+[{*\w]|require\s*\()/.test(code);
  const hasTests = /\b(describe|it|test|expect)\s*\(/.test(code);
  return hasImports && hasTests;
}

function isPromptTooLongError(text: string): boolean {
  return /prompt\s+(is\s+)?too\s+long|context\s+(length|window)\s+exceeded|maximum\s+context|token\s+limit/i.test(
    text,
  );
}

function isTruncated(code: string): boolean {
  let braces = 0;
  let backticks = 0;
  let inStr = false;
  let strCh = "";
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    const prev = code[i - 1] ?? "";
    if (inStr) {
      if (ch === strCh && prev !== "\\") inStr = false;
      continue;
    }
    if (ch === "`") {
      backticks++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      strCh = ch;
      continue;
    }
    if (ch === "{") braces++;
    if (ch === "}") braces--;
  }
  return braces > 0 || backticks % 2 !== 0;
}

function autoCloseBraces(code: string): string | null {
  const openers: string[] = [];
  let inStr = false;
  let strCh = "";
  let backticks = 0;

  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    const prev = code[i - 1] ?? "";
    if (inStr) {
      if (ch === strCh && prev !== "\\") inStr = false;
      continue;
    }
    if (ch === "`") {
      backticks++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      strCh = ch;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") {
      openers.push(ch);
    } else if (ch === "}" || ch === "]" || ch === ")") {
      openers.pop();
    }
  }

  if (backticks % 2 !== 0) {
    code += "`";
  }

  const imbalance = openers.length;
  if (imbalance === 0) return code;
  if (imbalance > 5) return null;

  const closerMap: Record<string, string> = { "{": "}", "[": "]", "(": ")" };
  const closers = openers.reverse().map((o) => closerMap[o] ?? "}");
  return code + "\n" + closers.join("\n") + "\n";
}

function countTestCases(code: string): number {
  const itCount = (code.match(/\bit\s*\(/g) || []).length;
  const testCount = (code.match(/\btest\s*\(/g) || []).length;
  return Math.max(itCount + testCount, 1);
}

function resolveTestFramework(fw: TestFramework): TestFramework {
  if (fw === "playwright" || fw === "detox") return "vitest";
  return fw;
}
