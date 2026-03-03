/**
 * Coverit Cover — Security Fix Prompts
 *
 * Builds prompts for the AI to fix security vulnerabilities identified during scan.
 * The AI gets full tool access (Read, Glob, Grep, Bash, Write, Edit) and
 * autonomously navigates to each finding location, applies the fix, and verifies
 * existing tests still pass.
 *
 * Input: module security findings from coverit.json
 * Output: AI fixes source code, returns summary of resolved findings
 */

import type { AIMessage } from "./types.js";
import type { ManifestProject, Complexity } from "../schema/coverit-manifest.js";

// ─── Types ───────────────────────────────────────────────────

export interface SecurityFixTarget {
  path: string;
  complexity: Complexity;
  findings: string[]; // "check-type:file:line" format from manifest
}

export interface SecurityFixSummary {
  findingsFixed: number;
  findingsSkipped: number;
  resolvedFindings: string[]; // exact finding strings that were fixed
  filesModified: string[];
  testsStillPassing: boolean;
}

// ─── Prompt Builder ─────────────────────────────────────────

/**
 * Build the AI prompt for fixing security vulnerabilities in a single module.
 *
 * The AI will:
 * 1. Navigate to each finding location (check-type:file:line)
 * 2. Read the surrounding code to understand the vulnerability
 * 3. Apply the appropriate fix
 * 4. Run existing tests to verify nothing breaks
 * 5. Return a JSON summary of what was fixed
 */
export function buildSecurityFixPrompt(
  target: SecurityFixTarget,
  project: ManifestProject,
): AIMessage[] {
  const findingsList = target.findings
    .map((f) => `  - ${f}`)
    .join("\n");

  const system = `You are a senior security engineer fixing vulnerabilities in a ${project.language} project using ${project.framework}.

You have access to Read, Glob, Grep, Bash, Write, and Edit tools. Use them to navigate to each vulnerability, understand the code, and apply fixes.

## Your Task

Fix security vulnerabilities in the module at \`${target.path}/\`. Each finding follows the format \`check-type:relative/file.ts:lineNumber\`.

## Findings to Fix

${findingsList}

## Fix Strategies by Check Type

- **injection**: Use parameterized queries, prepared statements, or ORM methods instead of string concatenation. For command injection, use safe APIs (e.g., execFile with argument arrays instead of exec with string interpolation).
- **auth-bypass**: Add proper authentication guards, role checks, or middleware. Ensure all sensitive endpoints require authentication.
- **secrets-exposure**: Move hardcoded credentials to environment variables. Use \`process.env.VAR_NAME\` with fallback validation.
- **xss**: Sanitize user input before rendering. Use framework-provided escaping (e.g., template engines, React JSX auto-escaping). For raw HTML, use a sanitization library.
- **insecure-config**: Fix security headers, enable HTTPS-only cookies, disable debug mode, strengthen CORS policies.
- **data-exposure**: Remove sensitive data from logs, error messages, and API responses. Add field filtering/projection.
- **ssrf**: Validate and whitelist URLs before making outbound requests. Block internal/private IP ranges.
- **cryptographic-failures**: Use strong hashing (bcrypt, argon2), secure RNG (crypto.randomBytes), and modern encryption (AES-256-GCM).
- **insecure-deserialization**: Validate and sanitize input before deserialization. Use schema validation (zod, joi).

## Rules

1. **Read before fixing**: Always read the file and surrounding context before making changes.
2. **Minimal changes**: Fix only the security issue. Do not refactor surrounding code.
3. **Preserve behavior**: The fix must not change the functional behavior of the code.
4. **Run tests after**: Run \`npx ${project.testFramework === "jest" ? "jest" : "vitest run"} --no-coverage\` in the module's test directory to verify nothing breaks.
5. **Skip if risky**: If a fix would require significant refactoring or you're unsure about the correct approach, skip it and report it as skipped.
6. **Report accurately**: Only list a finding as resolved if you actually changed the code to fix it.

## Output Format

After completing all work, output ONLY this JSON (no markdown fences, no extra text):

{"findingsFixed": <number>, "findingsSkipped": <number>, "resolvedFindings": ["<exact finding string>", ...], "filesModified": ["<relative path>", ...], "testsStillPassing": <true|false>}`;

  const user = `Fix the ${target.findings.length} security findings in ${target.path}/. Start by reading the first finding's file.`;

  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
}

// ─── Response Parser ────────────────────────────────────────

/**
 * Parse the AI's summary response from a security fix session.
 */
export function parseSecurityFixResponse(raw: string): SecurityFixSummary {
  const jsonStr = extractJson(raw);

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    return {
      findingsFixed: typeof parsed["findingsFixed"] === "number" ? parsed["findingsFixed"] : 0,
      findingsSkipped: typeof parsed["findingsSkipped"] === "number" ? parsed["findingsSkipped"] : 0,
      resolvedFindings: parseStringArray(parsed["resolvedFindings"]),
      filesModified: parseStringArray(parsed["filesModified"]),
      testsStillPassing: typeof parsed["testsStillPassing"] === "boolean" ? parsed["testsStillPassing"] : true,
    };
  } catch {
    return { findingsFixed: 0, findingsSkipped: 0, resolvedFindings: [], filesModified: [], testsStillPassing: true };
  }
}

// ─── Helpers ────────────────────────────────────────────────

function extractJson(raw: string): string {
  let jsonStr = raw.trim();

  // Strip markdown fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1]!.trim();
  }

  // Find JSON object by key
  const startIdx = jsonStr.lastIndexOf('{"findingsFixed"');
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
