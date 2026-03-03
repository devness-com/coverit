/**
 * Coverit Cover — Stability Fix Prompts
 *
 * Builds prompts for the AI to fix stability/reliability gaps identified during scan.
 * The AI gets full tool access and autonomously navigates to each gap location,
 * applies the fix (error handling, timeouts, cleanup, etc.), and verifies
 * existing tests still pass.
 *
 * Input: module stability gaps from coverit.json
 * Output: AI fixes source code, returns summary of resolved gaps + new score
 */

import type { AIMessage } from "./types.js";
import type { ManifestProject, Complexity } from "../schema/coverit-manifest.js";

// ─── Types ───────────────────────────────────────────────────

export interface StabilityFixTarget {
  path: string;
  complexity: Complexity;
  score: number;
  gaps: string[]; // narrative descriptions from scan
}

export interface StabilityFixSummary {
  gapsFixed: number;
  gapsSkipped: number;
  resolvedGaps: string[]; // exact gap strings that were fixed
  newScore: number; // AI's reassessment of module stability (0-100)
  filesModified: string[];
  testsStillPassing: boolean;
}

// ─── Prompt Builder ─────────────────────────────────────────

/**
 * Build the AI prompt for fixing stability gaps in a single module.
 *
 * The AI will:
 * 1. Read each gap description to understand what's missing
 * 2. Navigate to the relevant code
 * 3. Apply targeted reliability improvements
 * 4. Run existing tests to verify nothing breaks
 * 5. Reassess the module's stability score
 * 6. Return a JSON summary
 */
export function buildStabilityFixPrompt(
  target: StabilityFixTarget,
  project: ManifestProject,
): AIMessage[] {
  const gapsList = target.gaps
    .map((g, i) => `  ${i + 1}. ${g}`)
    .join("\n");

  const system = `You are a senior reliability engineer improving error handling and stability in a ${project.language} project using ${project.framework}.

You have access to Read, Glob, Grep, Bash, Write, and Edit tools. Use them to navigate to each stability gap, understand the code, and apply fixes.

## Your Task

Fix stability gaps in the module at \`${target.path}/\` (current stability score: ${target.score}/100).

## Gaps to Fix

${gapsList}

## Fix Strategies by Gap Type

- **Missing error handling**: Add try/catch blocks around operations that can fail (DB queries, API calls, file I/O). Log errors with context (operation name, input parameters). Re-throw or return appropriate error responses.
- **Unhandled promise rejections**: Add .catch() handlers or wrap in try/catch with await. Never use .catch(() => {}) — always log the error.
- **Missing null/undefined checks**: Add guard clauses or optional chaining where values may be undefined. Add early returns for invalid inputs.
- **Missing timeouts**: Add timeouts to external HTTP calls, database queries, and inter-service communication. Use AbortController or library-specific timeout options.
- **Race conditions / non-atomic updates**: Use database transactions, optimistic locking, or mutex patterns. For read-modify-write patterns, use atomic operations.
- **Resource cleanup**: Add OnModuleDestroy/OnApplicationShutdown lifecycle hooks. Close connections, clear intervals, and release resources in finally blocks.
- **Silent error swallowing**: Replace empty .catch(() => {}) with proper error logging. At minimum, log the error with context.
- **Missing graceful degradation**: Add fallback behavior for non-critical operations. Use circuit breaker patterns for external services.

## Rules

1. **Read before fixing**: Always read the file and surrounding context before making changes.
2. **Minimal changes**: Fix only the stability issue. Do not refactor surrounding code.
3. **Preserve behavior**: The fix must not change the happy-path behavior of the code.
4. **Run tests after**: Run \`npx ${project.testFramework === "jest" ? "jest" : "vitest run"} --no-coverage\` in the module's test directory to verify nothing breaks.
5. **Skip if risky**: If a fix would require significant refactoring or could change business logic, skip it and report it as skipped.
6. **Reassess score**: After fixing, evaluate the module's overall stability on a 0-100 scale:
   - 90-100: Comprehensive error handling, all edge cases covered, proper cleanup
   - 70-89: Most error paths handled, minor gaps
   - 50-69: Basic handling but significant gaps remain
   - 30-49: Many unhandled paths
   - 0-29: Minimal error handling

## Output Format

After completing all work, output ONLY this JSON (no markdown fences, no extra text):

{"gapsFixed": <number>, "gapsSkipped": <number>, "resolvedGaps": ["<exact gap string>", ...], "newScore": <0-100>, "filesModified": ["<relative path>", ...], "testsStillPassing": <true|false>}`;

  const user = `Fix the ${target.gaps.length} stability gaps in ${target.path}/ (current score: ${target.score}/100). Start by reading the first gap's relevant files.`;

  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
}

// ─── Response Parser ────────────────────────────────────────

/**
 * Parse the AI's summary response from a stability fix session.
 */
export function parseStabilityFixResponse(raw: string): StabilityFixSummary {
  const jsonStr = extractJson(raw);

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    return {
      gapsFixed: typeof parsed["gapsFixed"] === "number" ? parsed["gapsFixed"] : 0,
      gapsSkipped: typeof parsed["gapsSkipped"] === "number" ? parsed["gapsSkipped"] : 0,
      resolvedGaps: parseStringArray(parsed["resolvedGaps"]),
      newScore: typeof parsed["newScore"] === "number" ? parsed["newScore"] : 0,
      filesModified: parseStringArray(parsed["filesModified"]),
      testsStillPassing: typeof parsed["testsStillPassing"] === "boolean" ? parsed["testsStillPassing"] : true,
    };
  } catch {
    return { gapsFixed: 0, gapsSkipped: 0, resolvedGaps: [], newScore: 0, filesModified: [], testsStillPassing: true };
  }
}

// ─── Helpers ────────────────────────────────────────────────

function extractJson(raw: string): string {
  let jsonStr = raw.trim();

  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1]!.trim();
  }

  const startIdx = jsonStr.lastIndexOf('{"gapsFixed"');
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

  return jsonStr;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter((f): f is string => typeof f === "string")
    : [];
}
