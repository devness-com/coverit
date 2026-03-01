/**
 * Coverit Stability — AI-Driven Reliability Analysis Prompts
 *
 * Builds the prompt for the AI to assess error handling and reliability
 * across all modules. The AI explores source code looking for gaps in
 * error handling, missing edge case coverage, resource leaks, and
 * missing graceful degradation patterns.
 *
 * Each module gets a 0-100 stability score and a list of specific gaps.
 */

import type { AIMessage } from "./types.js";
import type { ProjectInfo } from "../types/index.js";
import type { ModuleEntry } from "../schema/coverit-manifest.js";

// ─── Types ───────────────────────────────────────────────────

/**
 * The structured JSON the AI must return.
 * Parsed and validated before applying to modules.
 */
export interface StabilityAIResponse {
  modules: StabilityAIModule[];
}

export interface StabilityAIModule {
  path: string;
  score: number;
  gaps: string[];
}

// ─── Prompt Builder ─────────────────────────────────────────

/**
 * Build the AI prompt for stability/reliability analysis.
 *
 * The AI reads source code in each module and evaluates how well
 * it handles errors, edge cases, resource cleanup, and failures.
 */
export function buildStabilityPrompt(
  projectInfo: ProjectInfo,
  modules: ModuleEntry[],
  existingModules?: ModuleEntry[],
): AIMessage[] {
  const moduleList = modules
    .map((m) => `  - ${m.path} (${m.files} files, ${m.complexity} complexity)`)
    .join("\n");

  const system = `You are a senior reliability engineer performing a stability audit.

You have access to Glob, Grep, Read, and Bash tools. Use them to explore the actual source code thoroughly.

## Your Task

Assess the reliability and error handling quality of every module in this project. You MUST read the actual source code — do not guess.

## Modules to Analyze

${moduleList}

## Stability Checks

For each module, evaluate these reliability aspects:

### 1. Error Handling
- Are async operations wrapped in try/catch?
- Are Promise rejections handled (.catch or try/catch with await)?
- Are errors logged or re-thrown with context, not silently swallowed?
- Do error handlers distinguish between expected and unexpected errors?

### 2. Edge Cases
- Are null/undefined inputs handled for public functions?
- Are empty arrays/strings handled in iteration logic?
- Are boundary conditions checked (e.g., max lengths, zero values, negative numbers)?
- Are type narrowing guards used before accessing optional properties?

### 3. Resource Cleanup
- Are database connections/pools properly closed in finally blocks?
- Are file handles, streams, and event listeners cleaned up?
- Are timers (setTimeout/setInterval) cleared when no longer needed?
- Do try/finally blocks ensure cleanup even on error paths?

### 4. Graceful Degradation
- Do external service calls have timeouts configured?
- Are there fallback strategies when external services are unavailable?
- Do retry mechanisms exist for transient failures?
- Does the application degrade gracefully rather than crashing entirely?

## Scoring Guide

Score each module 0-100 based on how well it handles the above:

- **90-100**: Excellent — comprehensive error handling, all edge cases covered, proper cleanup, graceful degradation
- **70-89**: Good — most error paths handled, minor gaps in edge cases or cleanup
- **50-69**: Adequate — basic error handling present but significant gaps (e.g., missing cleanup, unhandled edge cases)
- **30-49**: Poor — many unhandled error paths, missing cleanup, no graceful degradation
- **0-29**: Critical — minimal error handling, likely to crash on unexpected input

## Gap Descriptions

Write concise, specific gap descriptions that identify the exact issue:
- GOOD: "No error handling in processPayment() for failed Stripe API calls"
- GOOD: "Database connection pool never closed on server shutdown"
- BAD: "Error handling could be improved" (too vague)
- BAD: "Missing tests" (this is about code, not tests)

## Output Format

Return ONLY a valid JSON object with no surrounding markdown, no explanation, no commentary:

{
  "modules": [
    {
      "path": "<module path>",
      "score": <0-100>,
      "gaps": ["<specific gap description>", ...]
    }
  ]
}

Include ALL modules in the response. Modules with excellent stability should have high scores and empty gaps arrays.
Return ONLY the JSON. No markdown code fences. No explanatory text.`;

  const previousAnalysis = buildStabilityPreviousAnalysis(existingModules);

  const user = `Analyze the stability and reliability of this ${projectInfo.framework} project.

Project: ${projectInfo.name}
Root: ${projectInfo.root}
Language: ${projectInfo.language}
Framework: ${projectInfo.framework}
${previousAnalysis}
Start by exploring each module's source files to assess error handling and reliability.`;

  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
}

/**
 * Build the "Previous Analysis" section for incremental stability scans.
 * Gives the AI previous scores and gaps as a starting point so it can
 * focus on changes and verify whether old gaps are still present.
 */
function buildStabilityPreviousAnalysis(existingModules?: ModuleEntry[]): string {
  if (!existingModules?.length) return "";

  const modulesWithData = existingModules.filter(
    (m) => m.stability && (m.stability.gaps.length > 0 || m.stability.score > 0),
  );

  if (modulesWithData.length === 0) return "";

  const summary = modulesWithData.map((m) => ({
    path: m.path,
    score: m.stability!.score,
    gaps: m.stability!.gaps,
  }));

  return `

## Previous Stability Analysis

A prior stability scan produced the following. Use it as your starting point — do NOT start from scratch.

- **Verify** whether each previous gap still exists in the code (it may have been fixed).
- **Add** new gaps for reliability issues introduced since the last scan.
- **Remove** gaps that are no longer valid (code was improved or file was deleted).
- **Update** scores to reflect the current state of error handling and reliability.
- **Preserve** gaps that are still present — do not lose previously identified issues.

Previous results (${modulesWithData.length} modules):

${JSON.stringify(summary, null, 2)}
`;
}

// ─── Response Parser ────────────────────────────────────────

/**
 * Extract and parse the JSON response from the AI.
 * Handles responses that may be wrapped in markdown code fences.
 */
export function parseStabilityResponse(raw: string): StabilityAIResponse {
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
      `Failed to parse stability AI response as JSON: ${e instanceof Error ? e.message : String(e)}\n\nRaw response (first 500 chars): ${raw.slice(0, 500)}`,
    );
  }

  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj["modules"])) {
    throw new Error(
      "Stability AI response missing 'modules' array. Got: " +
        JSON.stringify(Object.keys(obj)),
    );
  }

  const modules = (obj["modules"] as Array<Record<string, unknown>>).map(
    validateStabilityModule,
  );

  return { modules };
}

// ─── Validation Helpers ─────────────────────────────────────

function validateStabilityModule(raw: Record<string, unknown>): StabilityAIModule {
  const path = typeof raw["path"] === "string" ? raw["path"] : "";
  const score =
    typeof raw["score"] === "number"
      ? Math.max(0, Math.min(100, Math.round(raw["score"])))
      : 0;

  const gaps: string[] = [];
  if (Array.isArray(raw["gaps"])) {
    for (const g of raw["gaps"] as unknown[]) {
      if (typeof g === "string" && g.trim().length > 0) {
        gaps.push(g.trim());
      }
    }
  }

  return { path, score, gaps };
}
