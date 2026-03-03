/**
 * Coverit Cover — Conformance Fix Prompts
 *
 * Builds prompts for the AI to fix conformance violations identified during scan.
 * The AI gets full tool access and autonomously fixes SAFE violations (dead code,
 * naming, unused imports) while explicitly SKIPPING risky ones (layer violations,
 * architectural drift).
 *
 * Input: module conformance violations from coverit.json
 * Output: AI fixes source code, returns summary of resolved violations + new score
 */

import type { AIMessage } from "./types.js";
import type { ManifestProject, Complexity } from "../schema/coverit-manifest.js";

// ─── Types ───────────────────────────────────────────────────

export interface ConformanceFixTarget {
  path: string;
  complexity: Complexity;
  score: number;
  violations: string[]; // narrative descriptions from scan
}

export interface ConformanceFixSummary {
  violationsFixed: number;
  violationsSkipped: number;
  resolvedViolations: string[]; // exact violation strings that were fixed
  skippedReasons: string[]; // why certain violations were skipped
  newScore: number; // AI's reassessment of module conformance (0-100)
  filesModified: string[];
  testsStillPassing: boolean;
}

// ─── Prompt Builder ─────────────────────────────────────────

/**
 * Build the AI prompt for fixing conformance violations in a single module.
 *
 * The AI will:
 * 1. Read each violation description
 * 2. Categorize it as safe-to-fix or skip
 * 3. Fix safe violations (dead code, naming, unused imports)
 * 4. Skip risky violations (layer violations, architectural changes)
 * 5. Run existing tests to verify nothing breaks
 * 6. Reassess the module's conformance score
 * 7. Return a JSON summary
 */
export function buildConformanceFixPrompt(
  target: ConformanceFixTarget,
  project: ManifestProject,
): AIMessage[] {
  const violationsList = target.violations
    .map((v, i) => `  ${i + 1}. ${v}`)
    .join("\n");

  const system = `You are a senior software engineer improving code quality and conformance in a ${project.language} project using ${project.framework}.

You have access to Read, Glob, Grep, Bash, Write, and Edit tools. Use them to navigate to each violation, understand the code, and apply safe fixes.

## Your Task

Fix conformance violations in the module at \`${target.path}/\` (current conformance score: ${target.score}/100).

## Violations Found

${violationsList}

## SAFE to Fix (DO these)

- **Dead code**: Remove commented-out code blocks, unused imports, unused exports, unreachable code paths, TODO placeholders that are stale.
- **Naming conventions**: Rename files, functions, or variables to match the project's established patterns (camelCase, PascalCase, kebab-case as appropriate).
- **Unused imports**: Remove import statements that are not referenced in the file.
- **Inconsistent test placement**: Move test files to match the project's primary test directory convention (if clear and safe to do).

## SKIP these (do NOT fix)

- **Layer violations**: Do NOT move business logic between controllers and services. This requires architectural understanding and could break the application.
- **Architectural drift**: Do NOT refactor cross-layer imports, circular dependencies, or module boundaries.
- **Pattern compliance** (structural): Do NOT change DI patterns, error handling patterns, or logging patterns across the module.

For each skipped violation, provide a brief reason (e.g., "Layer violation — requires architectural refactoring").

## Rules

1. **Read before fixing**: Always read the file and surrounding context before making changes.
2. **Conservative approach**: When in doubt, skip. It's better to leave a violation unfixed than to break the application.
3. **Preserve behavior**: Fixes must not change the runtime behavior of the code.
4. **Run tests after**: Run \`npx ${project.testFramework === "jest" ? "jest" : "vitest run"} --no-coverage\` in the module's test directory to verify nothing breaks.
5. **Reassess score**: After fixing, evaluate the module's overall conformance on a 0-100 scale:
   - 90-100: Consistent patterns, clean architecture, no dead code
   - 70-89: Mostly consistent, minor deviations
   - 50-69: Noticeable inconsistencies but functional
   - 30-49: Significant pattern violations
   - 0-29: Chaotic structure

## Output Format

After completing all work, output ONLY this JSON (no markdown fences, no extra text):

{"violationsFixed": <number>, "violationsSkipped": <number>, "resolvedViolations": ["<exact violation string>", ...], "skippedReasons": ["<reason>", ...], "newScore": <0-100>, "filesModified": ["<relative path>", ...], "testsStillPassing": <true|false>}`;

  const user = `Fix safe conformance violations in ${target.path}/ (current score: ${target.score}/100). Start by reading the first violation's relevant files.`;

  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
}

// ─── Response Parser ────────────────────────────────────────

/**
 * Parse the AI's summary response from a conformance fix session.
 */
export function parseConformanceFixResponse(raw: string): ConformanceFixSummary {
  const jsonStr = extractJson(raw);

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    return {
      violationsFixed: typeof parsed["violationsFixed"] === "number" ? parsed["violationsFixed"] : 0,
      violationsSkipped: typeof parsed["violationsSkipped"] === "number" ? parsed["violationsSkipped"] : 0,
      resolvedViolations: parseStringArray(parsed["resolvedViolations"]),
      skippedReasons: parseStringArray(parsed["skippedReasons"]),
      newScore: typeof parsed["newScore"] === "number" ? parsed["newScore"] : 0,
      filesModified: parseStringArray(parsed["filesModified"]),
      testsStillPassing: typeof parsed["testsStillPassing"] === "boolean" ? parsed["testsStillPassing"] : true,
    };
  } catch {
    return {
      violationsFixed: 0, violationsSkipped: 0, resolvedViolations: [],
      skippedReasons: [], newScore: 0, filesModified: [], testsStillPassing: true,
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────

function extractJson(raw: string): string {
  let jsonStr = raw.trim();

  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1]!.trim();
  }

  const startIdx = jsonStr.lastIndexOf('{"violationsFixed"');
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
