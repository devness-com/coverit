/**
 * Coverit — Stability Analysis Prompt Construction & Response Parsing
 *
 * Builds the AI prompt for identifying reliability and stability issues
 * in source code, and parses the structured JSON response into findings.
 *
 * Stability maps to ISO/IEC 25010:2023 "Reliability" — error handling,
 * edge cases, resource cleanup, and graceful degradation.
 */

import type { AIMessage } from "./types.js";
import type { StabilityCheck } from "../schema/coverit-manifest.js";

// ─── Finding Types ──────────────────────────────────────────

export interface StabilityFinding {
  file: string;
  line: number;
  check: StabilityCheck;
  severity: "high" | "medium" | "low";
  description: string;
  recommendation: string;
}

export interface StabilityResult {
  findings: StabilityFinding[];
  filesScanned: number;
  score: number;
}

// ─── Prompt Construction ────────────────────────────────────

const VALID_CHECKS: ReadonlySet<string> = new Set<StabilityCheck>([
  "error-handling",
  "edge-cases",
  "resource-cleanup",
  "graceful-degradation",
  "timeout-handling",
  "concurrent-access",
]);

const VALID_SEVERITIES: ReadonlySet<string> = new Set([
  "high",
  "medium",
  "low",
]);

/**
 * Build the message array for stability analysis of source files.
 *
 * The AI receives file paths and uses Read tool access to examine code.
 * Checks enabled in the manifest config determine which categories
 * appear in the prompt — unused checks are excluded to reduce noise.
 */
export function buildStabilityPrompt(
  files: Array<{ path: string; content: string }>,
  enabledChecks: StabilityCheck[],
): AIMessage[] {
  const checkDescriptions = buildCheckDescriptions(enabledChecks);

  const systemPrompt = `You are an expert reliability engineer reviewing code for stability and resilience issues.

Analyze the provided source code for reliability problems. Return ONLY a JSON array of findings.

Each finding MUST have this exact shape:
{ "file": "relative/path.ts", "line": number, "check": "${enabledChecks.join('" | "')}", "severity": "high" | "medium" | "low", "description": "...", "recommendation": "..." }

Focus on these categories:
${checkDescriptions}

SEVERITY GUIDE:
- "high": Will cause production failures (unhandled errors at service boundaries, missing cleanup in critical paths, no timeout on external calls)
- "medium": May cause issues under load or edge conditions (missing null checks, incomplete error propagation, no retry on transient failures)
- "low": Code smell that reduces reliability (catch blocks that swallow errors, missing finally blocks on non-critical resources)

RULES:
1. Only report issues in the provided source code, not in test files.
2. Be specific — reference actual function/method names and line numbers.
3. Do NOT report style issues (naming, formatting) — focus only on reliability.
4. Limit to 30 most important findings, prioritized by severity.
5. If no issues are found, return an empty array: []
6. Return ONLY the JSON array — no markdown fences, no commentary.`;

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
 * Build human-readable descriptions of each enabled stability check
 * to include in the system prompt.
 */
function buildCheckDescriptions(checks: StabilityCheck[]): string {
  const descriptions: Record<StabilityCheck, string> = {
    "error-handling":
      "1. Error handling -- Missing try/catch at service boundaries, uncaught promise rejections, unhandled errors in async functions, catch blocks that swallow errors without logging or rethrowing",
    "edge-cases":
      "2. Edge cases -- No null/undefined checks on required parameters, missing boundary validation (empty arrays, zero values, negative numbers), no guard clauses for invalid state",
    "resource-cleanup":
      "3. Resource cleanup -- Database connections not closed in finally blocks, file handles not released, event listeners not removed on teardown, streams not properly ended",
    "graceful-degradation":
      "4. Graceful degradation -- No fallback when external service is unavailable, no circuit breaker pattern on flaky dependencies, no timeout on external HTTP/RPC calls, hard crashes instead of degraded responses",
    "timeout-handling":
      "5. Timeout handling -- No timeouts on database queries, missing abort signals on fetch calls, no deadline propagation in service-to-service calls",
    "concurrent-access":
      "6. Concurrent access -- Race conditions in shared state mutations, no locking on critical sections, concurrent writes without optimistic concurrency control",
  };

  return checks
    .map((check) => descriptions[check])
    .join("\n");
}

// ─── Response Parsing ───────────────────────────────────────

/**
 * Parse the AI stability analysis response into typed findings.
 *
 * Resilient to common AI response issues:
 *  - Markdown fences wrapping JSON
 *  - Preamble text before the JSON array
 *  - Invalid check types or severities (filtered out)
 *  - Completely unparseable responses (returns empty array)
 */
export function parseStabilityResponse(
  response: string,
  scannedFiles: string[],
): StabilityResult {
  const findings = extractFindings(response, scannedFiles);
  const score = computeStabilityScore(findings);

  return {
    findings,
    filesScanned: scannedFiles.length,
    score,
  };
}

function extractFindings(
  response: string,
  validFiles: string[],
): StabilityFinding[] {
  let cleaned = response.trim();

  // Strip markdown fences if present
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch?.[1]) {
    cleaned = fenceMatch[1].trim();
  }

  // Try direct parse
  let parsed = tryParseJSON(cleaned);

  // If that fails, try extracting array from text with preamble
  if (!parsed) {
    parsed = extractJSONArray(cleaned);
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const validFileSet = new Set(validFiles);

  // Validate and coerce each finding
  const findings: StabilityFinding[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;

    const item = raw as Record<string, unknown>;
    const file = String(item["file"] ?? "");
    const line = Number(item["line"] ?? 0);
    const check = String(item["check"] ?? "");
    const severity = String(item["severity"] ?? "");
    const description = String(item["description"] ?? "");
    const recommendation = String(item["recommendation"] ?? "");

    // Skip findings with invalid or unrecognized fields
    if (!file || !description) continue;
    if (!VALID_CHECKS.has(check)) continue;
    if (!VALID_SEVERITIES.has(severity)) continue;

    // Skip findings referencing files not in the scan set
    if (validFileSet.size > 0 && !validFileSet.has(file)) continue;

    findings.push({
      file,
      line: Math.max(0, Math.round(line)),
      check: check as StabilityCheck,
      severity: severity as "high" | "medium" | "low",
      description,
      recommendation,
    });
  }

  return findings;
}

// ─── Scoring ────────────────────────────────────────────────

/** Severity-based deduction points, aligned with the scoring engine */
const SEVERITY_DEDUCTIONS: Record<string, number> = {
  high: 15,
  medium: 8,
  low: 3,
};

/**
 * Compute a 0-100 stability score from findings.
 *
 * Starts at 100 and deducts points per finding based on severity.
 * Floor at 0 — heavy finding counts do not go negative.
 */
function computeStabilityScore(findings: StabilityFinding[]): number {
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

/**
 * Extract a JSON array from text that may contain preamble.
 * Finds the outermost [...] bracket pair.
 */
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
          // Not valid JSON at this position, keep searching
        }
      }
    }
  }

  return null;
}
