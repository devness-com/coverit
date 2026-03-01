/**
 * Coverit Conformance — AI-Driven Coding Standards Analysis Prompts
 *
 * Builds the prompt for the AI to assess coding standards compliance
 * and architectural consistency across all modules. The AI explores
 * source code looking for pattern violations, layer breaches, naming
 * inconsistencies, and dead code.
 *
 * Each module gets a 0-100 conformance score and a list of specific violations.
 */

import type { AIMessage } from "./types.js";
import type { ProjectInfo } from "../types/index.js";
import type { ModuleEntry } from "../schema/coverit-manifest.js";

// ─── Types ───────────────────────────────────────────────────

/**
 * The structured JSON the AI must return.
 * Parsed and validated before applying to modules.
 */
export interface ConformanceAIResponse {
  modules: ConformanceAIModule[];
}

export interface ConformanceAIModule {
  path: string;
  score: number;
  violations: string[];
}

// ─── Prompt Builder ─────────────────────────────────────────

/**
 * Build the AI prompt for coding standards / conformance analysis.
 *
 * The AI reads source code in each module and evaluates how well
 * it follows consistent patterns, respects architectural layers,
 * and maintains clean code.
 */
export function buildConformancePrompt(
  projectInfo: ProjectInfo,
  modules: ModuleEntry[],
): AIMessage[] {
  const moduleList = modules
    .map((m) => `  - ${m.path} (${m.files} files, ${m.complexity} complexity)`)
    .join("\n");

  const system = `You are a senior software architect performing a codebase conformance audit.

You have access to Glob, Grep, Read, and Bash tools. Use them to explore the actual source code thoroughly.

## Your Task

Assess the coding standards compliance and architectural consistency of every module in this project. You MUST read the actual source code — do not guess.

## Modules to Analyze

${moduleList}

## Conformance Checks

For each module, evaluate these aspects:

### 1. Pattern Compliance
- Does the module follow the same patterns as other modules in the project?
- Are dependency injection, error handling, logging patterns consistent?
- Do similar operations follow the same approach (e.g., all services use the same base class or pattern)?
- Is the module structured similarly to its peers (same file organization, naming)?

### 2. Layer Violations
- Do controllers/routes import directly from other controllers? (violation)
- Do services import from route handlers or controllers? (violation)
- Does business logic leak into controllers or utility layers? (violation)
- Are data access patterns confined to the appropriate layer (repositories, DAOs)?

### 3. Naming Conventions
- Are file names consistent across the project? (e.g., all kebab-case or all camelCase)
- Do class/function names follow a consistent pattern?
- Are test files named consistently?
- Do exported identifiers follow the project's convention?

### 4. Dead Code
- Are there unused exports (functions/classes exported but never imported)?
- Are there commented-out code blocks that should be removed?
- Are there unreachable code paths (code after return/throw)?
- Are there unused imports?

## Scoring Guide

Score each module 0-100 based on conformance:

- **90-100**: Excellent — consistent patterns, clean architecture, no dead code, consistent naming
- **70-89**: Good — mostly consistent, minor deviations from project patterns
- **50-69**: Adequate — noticeable inconsistencies but functional, some dead code or pattern drift
- **30-49**: Poor — significant pattern violations, layer breaches, inconsistent naming
- **0-29**: Critical — chaotic structure, no consistent patterns, major architectural violations

## Violation Descriptions

Write concise, specific violations:
- GOOD: "Layer violation: UserController imports directly from OrderController"
- GOOD: "Inconsistent naming: uses camelCase while rest of project uses kebab-case for files"
- GOOD: "Dead code: exportedHelper() in utils.ts is never imported anywhere"
- BAD: "Code could be cleaner" (too vague)
- BAD: "Not enough comments" (comments are not a conformance concern)

## Important

- Judge conformance relative to THE PROJECT'S OWN patterns, not an external standard
- First explore several modules to understand the project's conventions, then assess each module against those conventions
- A module that deviates from the project's established patterns scores lower, even if its approach is technically valid
- Focus on structural/architectural concerns, not style preferences (leave formatting to linters)

## Output Format

Return ONLY a valid JSON object with no surrounding markdown, no explanation, no commentary:

{
  "modules": [
    {
      "path": "<module path>",
      "score": <0-100>,
      "violations": ["<specific violation description>", ...]
    }
  ]
}

Include ALL modules in the response. Modules with excellent conformance should have high scores and empty violations arrays.
Return ONLY the JSON. No markdown code fences. No explanatory text.`;

  const user = `Analyze the coding standards and architectural conformance of this ${projectInfo.framework} project.

Project: ${projectInfo.name}
Root: ${projectInfo.root}
Language: ${projectInfo.language}
Framework: ${projectInfo.framework}

Start by exploring several modules to understand the project's conventions, then assess each module.`;

  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
}

// ─── Response Parser ────────────────────────────────────────

/**
 * Extract and parse the JSON response from the AI.
 * Handles responses that may be wrapped in markdown code fences.
 */
export function parseConformanceResponse(raw: string): ConformanceAIResponse {
  let jsonStr = raw.trim();

  // Strip markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1]!.trim();
  }

  // Try to find JSON object boundaries if there's surrounding text
  if (!jsonStr.startsWith("{")) {
    const startIdx = jsonStr.indexOf("{");
    const endIdx = jsonStr.lastIndexOf("}");
    if (startIdx !== -1 && endIdx !== -1) {
      jsonStr = jsonStr.slice(startIdx, endIdx + 1);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(
      `Failed to parse conformance AI response as JSON: ${e instanceof Error ? e.message : String(e)}\n\nRaw response (first 500 chars): ${raw.slice(0, 500)}`,
    );
  }

  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj["modules"])) {
    throw new Error(
      "Conformance AI response missing 'modules' array. Got: " +
        JSON.stringify(Object.keys(obj)),
    );
  }

  const modules = (obj["modules"] as Array<Record<string, unknown>>).map(
    validateConformanceModule,
  );

  return { modules };
}

// ─── Validation Helpers ─────────────────────────────────────

function validateConformanceModule(raw: Record<string, unknown>): ConformanceAIModule {
  const path = typeof raw["path"] === "string" ? raw["path"] : "";
  const score =
    typeof raw["score"] === "number"
      ? Math.max(0, Math.min(100, Math.round(raw["score"])))
      : 0;

  const violations: string[] = [];
  if (Array.isArray(raw["violations"])) {
    for (const v of raw["violations"] as unknown[]) {
      if (typeof v === "string" && v.trim().length > 0) {
        violations.push(v.trim());
      }
    }
  }

  return { path, score, violations };
}
