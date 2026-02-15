/**
 * Coverit — AI Generator
 *
 * Unified generator that replaces all 5 per-type generators.
 * One AI call per plan, with full source code + existing tests.
 * Falls back gracefully when no AI provider is available.
 */

import { basename, dirname, extname } from "node:path";
import type { AIProvider } from "../ai/types.js";
import type {
  GeneratedTest,
  GeneratorResult,
  GenerationInput,
  ProjectInfo,
  SkippedItem,
  TestFailure,
  TestFramework,
  TestType,
} from "../types/index.js";
import {
  buildTestGenerationPrompt,
  buildTestRefinementPrompt,
  buildSimplifiedGenerationPrompt,
} from "../ai/prompts.js";

export class AIGenerator {
  constructor(
    private aiProvider: AIProvider | null,
    private project: ProjectInfo,
  ) {}

  async generate(input: GenerationInput): Promise<GeneratorResult> {
    const tests: GeneratedTest[] = [];
    const warnings: string[] = [];
    const skipped: SkippedItem[] = [];

    if (!this.aiProvider) {
      warnings.push("No AI provider available — cannot generate tests");
      return { tests, warnings, skipped };
    }

    // Warn if all source files have empty content
    const nonEmpty = input.sourceFiles.filter((f) => f.content.trim().length > 0);
    if (nonEmpty.length === 0 && input.sourceFiles.length > 0) {
      warnings.push(
        `All ${input.sourceFiles.length} source file(s) have empty content: ${input.sourceFiles.map((f) => f.path).join(", ")}`,
      );
    }

    try {
      const messages = buildTestGenerationPrompt({
        plan: input.plan,
        project: input.project,
        sourceFiles: input.sourceFiles,
        existingTestContent: input.existingTestContent,
        testTypes: input.testTypes,
      });

      const response = await this.aiProvider.generate(messages, {
        temperature: 0.2,
        maxTokens: 16384,
      });

      let content = response.content.trim();
      if (!content) {
        warnings.push("AI returned empty response");
        return { tests, warnings, skipped };
      }

      let code = extractCodeFromResponse(content);

      // Guard: if extraction produced non-code (e.g. error message), skip
      if (!looksLikeTestCode(code)) {
        // Detect "prompt too long" — try simplified prompt inline
        if (isPromptTooLongError(content)) {
          console.warn(`[coverit] Prompt too long, retrying with simplified prompt...`);
          return this.generateSimplified(input);
        }
        warnings.push(`AI returned non-code response: ${content.slice(0, 120)}`);
        return { tests, warnings, skipped };
      }

      // Detect truncation and retry with higher limit
      if (response.truncated || isTruncated(code)) {
        console.warn(`[coverit] AI generation truncated, retrying with higher limit...`);
        const retryResponse = await this.aiProvider.generate(messages, {
          temperature: 0.2,
          maxTokens: 32768,
        });
        const retryContent = retryResponse.content.trim();
        if (!retryContent) {
          warnings.push("AI retry returned empty response");
          return { tests, warnings, skipped };
        }
        const retryCode = extractCodeFromResponse(retryContent);
        if (retryResponse.truncated || isTruncated(retryCode)) {
          // Attempt to auto-close braces if the code looks salvageable
          if (looksLikeTestCode(retryCode)) {
            const repaired = autoCloseBraces(retryCode);
            if (repaired && !isTruncated(repaired)) {
              warnings.push("AI generation was truncated — auto-closed braces to salvage output");
              code = repaired;
            } else {
              warnings.push("AI generation still truncated after retry (unfixable imbalance)");
              return { tests, warnings, skipped };
            }
          } else {
            warnings.push("AI generation still truncated after retry");
            return { tests, warnings, skipped };
          }
        } else {
          code = retryCode;
        }
      }

      const testCount = countTestCases(code);
      const framework = resolveTestFramework(this.project.testFramework);

      tests.push({
        planId: input.plan.id,
        filePath: input.plan.outputTestFile,
        content: code,
        testType: input.plan.testTypes[0] ?? "unit",
        testCount,
        framework,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // If the error itself indicates prompt too long, try simplified
      if (isPromptTooLongError(msg)) {
        console.warn(`[coverit] Prompt too long (error), retrying with simplified prompt...`);
        return this.generateSimplified(input);
      }
      warnings.push(`AI generation failed: ${msg}`);
    }

    return { tests, warnings, skipped };
  }

  async refineWithAI(params: {
    testCode: string;
    failures: TestFailure[];
    sourceCode: string;
  }): Promise<string | null> {
    if (!this.aiProvider) return null;

    try {
      const messages = buildTestRefinementPrompt({
        testCode: params.testCode,
        failures: params.failures,
        sourceCode: params.sourceCode,
      });

      const response = await this.aiProvider.generate(messages, {
        temperature: 0.2,
        maxTokens: 16384,
      });

      const content = response.content.trim();
      if (!content) return null;

      let code = extractCodeFromResponse(content);

      // Guard: if extraction produced non-code, reject it
      if (!looksLikeTestCode(code)) {
        if (isPromptTooLongError(content)) {
          console.warn(`[coverit] Refinement prompt too long — cannot refine`);
        } else {
          console.warn(`[coverit] AI refinement returned non-code response: ${content.slice(0, 120)}`);
        }
        return null;
      }

      if (response.truncated || isTruncated(code)) {
        console.warn(`[coverit] AI refinement truncated, retrying with higher limit...`);
        const retryResponse = await this.aiProvider.generate(messages, {
          temperature: 0.2,
          maxTokens: 32768,
        });
        const retryContent = retryResponse.content.trim();
        if (!retryContent) return null;
        const retryCode = extractCodeFromResponse(retryContent);
        if (retryResponse.truncated || isTruncated(retryCode)) {
          if (looksLikeTestCode(retryCode)) {
            const repaired = autoCloseBraces(retryCode);
            if (repaired && !isTruncated(repaired)) {
              console.warn(`[coverit] AI refinement was truncated — auto-closed braces to salvage output`);
              code = repaired;
            } else {
              console.error(`[coverit] AI refinement still truncated after retry (unfixable imbalance)`);
              return null;
            }
          } else {
            console.error(`[coverit] AI refinement still truncated after retry`);
            return null;
          }
        } else {
          code = retryCode;
        }
      }

      return code;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[coverit] AI refinement failed: ${msg}`);
      return null;
    }
  }

  async generateSimplified(input: GenerationInput): Promise<GeneratorResult> {
    const tests: GeneratedTest[] = [];
    const warnings: string[] = [];
    const skipped: SkippedItem[] = [];

    if (!this.aiProvider) {
      warnings.push("No AI provider available — cannot generate tests");
      return { tests, warnings, skipped };
    }

    try {
      const messages = buildSimplifiedGenerationPrompt({
        plan: input.plan,
        project: input.project,
        sourceFiles: input.sourceFiles,
        existingTestContent: input.existingTestContent,
        testTypes: input.testTypes,
      });

      const response = await this.aiProvider.generate(messages, {
        temperature: 0.2,
        maxTokens: 16384,
      });

      const content = response.content.trim();
      if (!content) {
        warnings.push("AI simplified generation returned empty response");
        return { tests, warnings, skipped };
      }

      let code = extractCodeFromResponse(content);

      if (!looksLikeTestCode(code)) {
        warnings.push(`AI simplified generation returned non-code: ${content.slice(0, 120)}`);
        return { tests, warnings, skipped };
      }

      // No truncation retry — the simplified prompt is already compact
      if (isTruncated(code)) {
        const repaired = autoCloseBraces(code);
        if (repaired && !isTruncated(repaired)) {
          warnings.push("Simplified generation truncated — auto-closed braces");
          code = repaired;
        } else {
          warnings.push("Simplified generation truncated beyond repair");
          return { tests, warnings, skipped };
        }
      }

      const testCount = countTestCases(code);
      const framework = resolveTestFramework(this.project.testFramework);

      tests.push({
        planId: input.plan.id,
        filePath: input.plan.outputTestFile,
        content: code,
        testType: input.plan.testTypes[0] ?? "unit",
        testCount,
        framework,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`AI simplified generation failed: ${msg}`);
    }

    return { tests, warnings, skipped };
  }
}

// ─── Utility functions (extracted from base-generator) ───────

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
  const codePattern = /^\s*(import\s|export\s|const\s|let\s|var\s|function\s|class\s|\/\/|\/\*|describe\s*\(|it\s*\(|test\s*\(|['"]use\s)/;
  for (let i = 0; i < lines.length; i++) {
    if (codePattern.test(lines[i]!)) {
      if (i === 0) return raw;
      return lines.slice(i).join("\n");
    }
  }
  return raw;
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

  // Handle unclosed template literals
  if (backticks % 2 !== 0) {
    code += "`";
  }

  const imbalance = openers.length;
  if (imbalance === 0) return code;
  if (imbalance > 5) return null; // too damaged

  const closerMap: Record<string, string> = { "{": "}", "[": "]", "(": ")" };
  const closers = openers.reverse().map((o) => closerMap[o] ?? "}");
  return code + "\n" + closers.join("\n") + "\n";
}

function isPromptTooLongError(text: string): boolean {
  return /prompt\s+(is\s+)?too\s+long|context\s+(length|window)\s+exceeded|maximum\s+context|token\s+limit/i.test(text);
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

function looksLikeTestCode(code: string): boolean {
  // Must contain BOTH: import/require AND describe/it/test/expect
  // Requiring both prevents AI prose that mentions code patterns from passing
  const hasImports = /\b(import\s+[{*\w]|require\s*\()/.test(code);
  const hasTests = /\b(describe|it|test|expect)\s*\(/.test(code);
  return hasImports && hasTests;
}

function countTestCases(code: string): number {
  const itCount = (code.match(/\bit\s*\(/g) || []).length;
  const testCount = (code.match(/\btest\s*\(/g) || []).length;
  return Math.max(itCount + testCount, 1);
}

function resolveTestFramework(fw: TestFramework): TestFramework {
  // Playwright and Detox projects use vitest/jest for non-e2e tests
  if (fw === "playwright" || fw === "detox") return "vitest";
  return fw;
}

export function generateTestFileName(sourceFile: string, type: TestType): string {
  const dir = dirname(sourceFile);
  const ext = extname(sourceFile);
  const name = basename(sourceFile, ext);

  const suffixMap: Record<TestType, string> = {
    unit: "test",
    integration: "integration.test",
    api: "api.test",
    "e2e-browser": "e2e.test",
    "e2e-mobile": "mobile.test",
    "e2e-desktop": "desktop.test",
    snapshot: "snap.test",
    performance: "perf.test",
  };

  const suffix = suffixMap[type] ?? "test";
  return `${dir}/${name}.${suffix}${ext}`;
}
