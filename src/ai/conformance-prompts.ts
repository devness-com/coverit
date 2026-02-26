/**
 * Coverit — Conformance Analysis Prompt Construction & Response Parsing
 *
 * Builds the AI prompt for identifying pattern compliance and architectural
 * violations in source code, and parses the structured JSON response.
 *
 * Conformance maps to ISO/IEC 25010:2023 "Maintainability" — ensuring code
 * follows established project patterns, respects layer boundaries, and
 * adheres to naming conventions.
 */

import type { AIMessage } from "./types.js";
import type { ConformanceCheck } from "../schema/coverit-manifest.js";
import type { DetectedPatterns } from "../conformance/pattern-detector.js";

// ─── Finding Types ──────────────────────────────────────────

export interface ConformanceFinding {
  file: string;
  line: number;
  check: ConformanceCheck;
  severity: "high" | "medium" | "low";
  description: string;
  /** The expected pattern the code should follow */
  pattern: string;
  /** What was actually found in the code */
  actual: string;
}

export interface ConformanceResult {
  findings: ConformanceFinding[];
  filesScanned: number;
  score: number;
}

// ─── Prompt Construction ────────────────────────────────────

const VALID_CHECKS: ReadonlySet<string> = new Set<ConformanceCheck>([
  "pattern-compliance",
  "layer-violations",
  "naming-conventions",
  "dead-code",
  "architectural-drift",
]);

const VALID_SEVERITIES: ReadonlySet<string> = new Set([
  "high",
  "medium",
  "low",
]);

/**
 * Build the message array for conformance analysis.
 *
 * Includes detected project patterns so the AI can evaluate code
 * against the established conventions rather than generic rules.
 * This makes the analysis project-specific and actionable.
 */
export function buildConformancePrompt(
  files: Array<{ path: string; content: string }>,
  enabledChecks: ConformanceCheck[],
  detectedPatterns: DetectedPatterns,
): AIMessage[] {
  const patternContext = formatDetectedPatterns(detectedPatterns);
  const checkDescriptions = buildCheckDescriptions(enabledChecks);

  const systemPrompt = `You are an expert software architect reviewing code for pattern compliance and architectural consistency.

Analyze the provided source code against the project's established patterns. Return ONLY a JSON array of findings.

Each finding MUST have this exact shape:
{ "file": "relative/path.ts", "line": number, "check": "${enabledChecks.join('" | "')}", "severity": "high" | "medium" | "low", "description": "...", "pattern": "expected pattern", "actual": "what was found" }

## Established Project Patterns
${patternContext}

## Checks to Perform
${checkDescriptions}

SEVERITY GUIDE:
- "high": Breaks architectural boundaries (controller importing repository directly, bypassing service layer) or introduces architectural drift
- "medium": Inconsistent with established patterns (not using DI when the project uses DI, inconsistent naming)
- "low": Minor convention mismatch (slightly different naming style, unused export)

RULES:
1. Only flag violations of the project's OWN patterns — do not impose external conventions.
2. Be specific — reference actual import paths, class names, and line numbers.
3. The "pattern" field should describe what the project convention expects.
4. The "actual" field should describe what the code actually does.
5. Limit to 30 most important findings, prioritized by severity.
6. If no issues are found, return an empty array: []
7. Return ONLY the JSON array — no markdown fences, no commentary.`;

  const userParts: string[] = [];

  for (const file of files) {
    userParts.push(`## ${file.path}\n\`\`\`\n${file.content}\n\`\`\``);
  }

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userParts.join("\n\n") },
  ];
}

/**
 * Format detected patterns into a human-readable context block
 * for the AI prompt.
 */
function formatDetectedPatterns(patterns: DetectedPatterns): string {
  const sections: string[] = [];

  if (patterns.dependencyInjection) {
    sections.push(
      "- **Dependency Injection**: Project uses constructor injection. All services should receive dependencies via constructor parameters, not direct imports of concrete implementations.",
    );
  } else {
    sections.push(
      "- **No DI**: Project does NOT use dependency injection. Direct module imports are the convention.",
    );
  }

  if (patterns.layerArchitecture) {
    sections.push(
      "- **Layer Architecture**: Project follows controller -> service -> repository layers. Controllers must not import repositories directly. Services must not import controllers.",
    );
  }

  const nc = patterns.namingConventions;
  sections.push(
    `- **Naming Conventions**: Files: ${nc.files}, Classes: ${nc.classes}, Functions: ${nc.functions}`,
  );

  if (patterns.frameworkPatterns.length > 0) {
    sections.push(
      `- **Framework Patterns**: ${patterns.frameworkPatterns.join(", ")}`,
    );
  }

  return sections.join("\n");
}

/**
 * Build human-readable descriptions of each enabled conformance check.
 */
function buildCheckDescriptions(checks: ConformanceCheck[]): string {
  const descriptions: Record<ConformanceCheck, string> = {
    "pattern-compliance":
      "1. Pattern compliance -- Code does not follow the project's established patterns (e.g., service not using DI when the project convention is DI, not following the established error handling pattern)",
    "layer-violations":
      "2. Layer violations -- Direct imports across layer boundaries (controller importing repository, utility importing service, bypassing the established dependency direction)",
    "naming-conventions":
      "3. Naming conventions -- File names, class names, or function names that do not match the project's detected naming conventions",
    "dead-code":
      "4. Dead code -- Exported functions, classes, or constants that are not imported or used anywhere in the provided files (only flag when confident based on the provided context)",
    "architectural-drift":
      "5. Architectural drift -- New patterns being introduced that conflict with established conventions (e.g., using event emitters when the project uses direct method calls, introducing a new ORM when one is already established)",
  };

  return checks
    .map((check) => descriptions[check])
    .join("\n");
}

// ─── Response Parsing ───────────────────────────────────────

/**
 * Parse the AI conformance analysis response into typed findings.
 *
 * Handles the same response format quirks as other prompt parsers:
 * markdown fences, preamble text, invalid fields.
 */
export function parseConformanceResponse(
  response: string,
  scannedFiles: string[],
): ConformanceResult {
  const findings = extractFindings(response, scannedFiles);
  const score = computeConformanceScore(findings);

  return {
    findings,
    filesScanned: scannedFiles.length,
    score,
  };
}

function extractFindings(
  response: string,
  validFiles: string[],
): ConformanceFinding[] {
  let cleaned = response.trim();

  // Strip markdown fences
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch?.[1]) {
    cleaned = fenceMatch[1].trim();
  }

  let parsed = tryParseJSON(cleaned);

  if (!parsed) {
    parsed = extractJSONArray(cleaned);
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const validFileSet = new Set(validFiles);

  const findings: ConformanceFinding[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;

    const item = raw as Record<string, unknown>;
    const file = String(item["file"] ?? "");
    const line = Number(item["line"] ?? 0);
    const check = String(item["check"] ?? "");
    const severity = String(item["severity"] ?? "");
    const description = String(item["description"] ?? "");
    const pattern = String(item["pattern"] ?? "");
    const actual = String(item["actual"] ?? "");

    if (!file || !description) continue;
    if (!VALID_CHECKS.has(check)) continue;
    if (!VALID_SEVERITIES.has(severity)) continue;

    // Skip findings referencing files not in the scan set
    if (validFileSet.size > 0 && !validFileSet.has(file)) continue;

    findings.push({
      file,
      line: Math.max(0, Math.round(line)),
      check: check as ConformanceCheck,
      severity: severity as "high" | "medium" | "low",
      description,
      pattern,
      actual,
    });
  }

  return findings;
}

// ─── Scoring ────────────────────────────────────────────────

const SEVERITY_DEDUCTIONS: Record<string, number> = {
  high: 15,
  medium: 8,
  low: 3,
};

/**
 * Compute a 0-100 conformance score from findings.
 * Same deduction-based approach as stability scoring.
 */
function computeConformanceScore(findings: ConformanceFinding[]): number {
  let deduction = 0;
  for (const f of findings) {
    deduction += SEVERITY_DEDUCTIONS[f.severity] ?? 0;
  }
  return Math.max(0, Math.min(100, 100 - deduction));
}

// ─── JSON Utilities ─────────────────────────────────────────

function tryParseJSON(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function extractJSONArray(text: string): unknown[] | null {
  const lastBracket = text.lastIndexOf("]");
  if (lastBracket < 0) return null;

  let depth = 0;
  for (let i = lastBracket; i >= 0; i--) {
    if (text[i] === "]") depth++;
    if (text[i] === "[") {
      depth--;
      if (depth === 0) {
        try {
          const result = JSON.parse(text.slice(i, lastBracket + 1));
          if (Array.isArray(result)) return result as unknown[];
          return null;
        } catch {
          // Not valid at this position
        }
      }
    }
  }

  return null;
}
