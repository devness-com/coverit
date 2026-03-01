/**
 * Coverit Security — AI-Driven Security Scanning Prompts
 *
 * Builds the prompt for the AI to perform OWASP-mapped vulnerability scanning.
 * The AI gets tool access (Glob, Grep, Read, Bash) and explores the codebase
 * looking for security issues across all modules.
 *
 * Finding format: "check-type:relative/path/to/file.ts:lineNumber"
 * This matches the scoring engine's findingSeverityPoints() parser.
 */

import type { AIMessage } from "./types.js";
import type { ProjectInfo } from "../types/index.js";
import type { ModuleEntry } from "../schema/coverit-manifest.js";

// ─── Types ───────────────────────────────────────────────────

/**
 * The structured JSON the AI must return.
 * Parsed and validated before applying to modules.
 */
export interface SecurityAIResponse {
  modules: SecurityAIModule[];
}

export interface SecurityAIModule {
  path: string;
  issues: number;
  resolved: number;
  findings: string[];
}

// ─── Prompt Builder ─────────────────────────────────────────

/**
 * Build the AI prompt for security vulnerability scanning.
 *
 * The AI explores source code in each module looking for OWASP-mapped
 * vulnerabilities. It produces findings in the format expected by the
 * scoring engine: "check-type:file:line".
 */
export function buildSecurityPrompt(
  projectInfo: ProjectInfo,
  modules: ModuleEntry[],
  existingModules?: ModuleEntry[],
): AIMessage[] {
  const moduleList = modules
    .map((m) => `  - ${m.path} (${m.files} files, ${m.complexity} complexity)`)
    .join("\n");

  const system = `You are a senior application security engineer performing a vulnerability audit.

You have access to Glob, Grep, Read, and Bash tools. Use them to explore the actual source code thoroughly.

## Your Task

Scan every module in this project for security vulnerabilities. You MUST read the actual source code — do not guess from file names.

## Modules to Scan

${moduleList}

## Vulnerability Categories (OWASP-mapped)

For each module, check for these vulnerability types:

1. **injection** — SQL injection (string concatenation in queries), command injection (unsanitized input in exec/spawn), path traversal (user input in file paths)
2. **auth-bypass** — Missing authentication checks on routes/endpoints, broken access control (missing role checks), insecure direct object references
3. **secrets-exposure** — Hardcoded API keys, passwords, tokens, or credentials in source code (not env vars)
4. **xss** — Unsanitized user input rendered in HTML responses, missing output encoding, innerHTML usage with user data
5. **insecure-config** — Debug mode enabled in production config, overly permissive CORS (origin: *), missing rate limiting on sensitive endpoints, disabled security headers
6. **data-exposure** — Sensitive data (passwords, tokens, PII) logged or included in error messages/responses, verbose error messages exposing internals

## Workflow

1. For each module, use Glob to find source files
2. Use Grep to search for common vulnerability patterns (e.g., \`exec(\`, \`innerHTML\`, \`password\`, SQL string concatenation)
3. Read suspicious files to verify actual vulnerabilities (not false positives)
4. Record confirmed findings with exact file path and line number
5. Do NOT report issues in test files, config files, or type definitions — only production source code

## Finding Format

Each finding MUST follow this exact format: \`check-type:relative/path/to/file.ts:lineNumber\`

Examples:
- \`injection:src/services/booking.service.ts:142\`
- \`auth-bypass:src/controllers/admin.controller.ts:28\`
- \`secrets-exposure:src/config/database.ts:15\`
- \`xss:src/views/profile.tsx:89\`
- \`insecure-config:src/app.ts:34\`
- \`data-exposure:src/services/auth.service.ts:67\`

## Important

- Only report REAL vulnerabilities you can verify by reading the code
- False positives damage trust — when in doubt, don't report it
- Environment variable usage (process.env.SECRET) is NOT secrets-exposure
- Parameterized queries are NOT injection
- Properly sanitized output is NOT xss

## Output Format

Return ONLY a valid JSON object with no surrounding markdown, no explanation, no commentary:

{
  "modules": [
    {
      "path": "<module path>",
      "issues": <number of unresolved issues>,
      "resolved": 0,
      "findings": ["<check-type:file:line>", ...]
    }
  ]
}

Include ALL modules in the response, even those with zero findings (empty findings array).
Return ONLY the JSON. No markdown code fences. No explanatory text.`;

  const previousAnalysis = buildSecurityPreviousAnalysis(existingModules);

  const user = `Scan this ${projectInfo.framework} project for security vulnerabilities.

Project: ${projectInfo.name}
Root: ${projectInfo.root}
Language: ${projectInfo.language}
Framework: ${projectInfo.framework}
${previousAnalysis}
Start by exploring each module's source files to find vulnerabilities.`;

  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
}

/**
 * Build the "Previous Analysis" section for incremental security scans.
 * Gives the AI previous findings as a starting point so it can focus on
 * changes and verify whether old findings are still valid.
 */
function buildSecurityPreviousAnalysis(existingModules?: ModuleEntry[]): string {
  if (!existingModules?.length) return "";

  const modulesWithFindings = existingModules.filter(
    (m) => m.security && (m.security.findings.length > 0 || m.security.issues > 0),
  );

  if (modulesWithFindings.length === 0) return "";

  const summary = modulesWithFindings.map((m) => ({
    path: m.path,
    issues: m.security!.issues,
    resolved: m.security!.resolved,
    findings: m.security!.findings,
  }));

  return `

## Previous Security Analysis

A prior security scan found the following. Use it as your starting point — do NOT start from scratch.

- **Verify** whether each previous finding is still present in the code (it may have been fixed).
- **Add** new findings for vulnerabilities introduced since the last scan.
- **Remove** findings that are no longer valid (code was fixed or file was deleted).
- **Preserve** findings that are still present — do not lose previously discovered issues.

Previous findings (${modulesWithFindings.length} modules with issues):

${JSON.stringify(summary, null, 2)}
`;
}

// ─── Response Parser ────────────────────────────────────────

/**
 * Extract and parse the JSON response from the AI.
 * Handles responses that may be wrapped in markdown code fences.
 */
export function parseSecurityResponse(raw: string): SecurityAIResponse {
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
      `Failed to parse security AI response as JSON: ${e instanceof Error ? e.message : String(e)}\n\nRaw response (first 500 chars): ${raw.slice(0, 500)}`,
    );
  }

  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj["modules"])) {
    throw new Error(
      "Security AI response missing 'modules' array. Got: " +
        JSON.stringify(Object.keys(obj)),
    );
  }

  const modules = (obj["modules"] as Array<Record<string, unknown>>).map(
    validateSecurityModule,
  );

  return { modules };
}

// ─── Validation Helpers ─────────────────────────────────────

const VALID_CHECK_TYPES = new Set([
  "injection",
  "auth-bypass",
  "secrets-exposure",
  "xss",
  "insecure-config",
  "data-exposure",
  "ssrf",
  "cryptographic-failures",
  "insecure-deserialization",
  "dependency-vulns",
]);

function validateSecurityModule(raw: Record<string, unknown>): SecurityAIModule {
  const path = typeof raw["path"] === "string" ? raw["path"] : "";
  const issues = typeof raw["issues"] === "number" ? raw["issues"] : 0;
  const resolved = typeof raw["resolved"] === "number" ? raw["resolved"] : 0;

  const findings: string[] = [];
  if (Array.isArray(raw["findings"])) {
    for (const f of raw["findings"] as unknown[]) {
      if (typeof f !== "string") continue;
      // Validate finding format: check-type:file:line
      const checkType = f.split(":")[0] ?? "";
      if (VALID_CHECK_TYPES.has(checkType)) {
        findings.push(f);
      }
    }
  }

  return {
    path,
    issues: issues > 0 ? issues : findings.length,
    resolved,
    findings,
  };
}
