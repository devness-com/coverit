/**
 * Security Scanner — AI-powered vulnerability analysis of changed files
 *
 * Reads each changed file, sends it through the AI provider with a
 * security-focused prompt, and parses the structured response into
 * typed SecurityFinding objects. The scanner is provider-agnostic:
 * it accepts any AIProvider implementation (Claude CLI, OpenAI, Ollama, etc.).
 *
 * Flow:
 *   1. Read file contents from disk
 *   2. Build security prompt (see ai/security-prompts.ts)
 *   3. Send to AI provider
 *   4. Parse JSON response into findings
 *   5. Normalize check types and assign OWASP categories
 *
 * Non-parseable AI responses are treated as zero findings with a
 * warning logged, not as fatal errors — the scanner is resilient
 * to model hallucination or truncated output.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AIProvider } from "../ai/types.js";
import type { SecurityCheck } from "../schema/coverit-manifest.js";
import { buildSecurityPrompt } from "../ai/security-prompts.js";
import { formatOwaspRef } from "./owasp-mapping.js";
import { severityForCheck } from "./severity.js";
import type { SecurityFinding } from "./owasp-mapping.js";
import { logger } from "../utils/logger.js";

// ─── Result Types ───────────────────────────────────────────

export interface SecurityScanResult {
  findings: SecurityFinding[];
  filesScanned: number;
  /** Total scan duration in milliseconds */
  duration: number;
  /** Files that were scanned but had no findings */
  cleanFiles: string[];
  /** Warnings from non-parseable AI responses */
  warnings: string[];
}

// ─── Valid Check Types ──────────────────────────────────────

const VALID_CHECK_TYPES = new Set<SecurityCheck>([
  "injection",
  "auth-bypass",
  "secrets-exposure",
  "xss",
  "insecure-config",
  "data-exposure",
  "dependency-vulns",
  "ssrf",
  "cryptographic-failures",
  "insecure-deserialization",
]);

const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low"]);

// ─── AI Response Type Alias (pre-validation) ────────────────

interface RawFinding {
  line?: unknown;
  type?: unknown;
  severity?: unknown;
  description?: unknown;
  recommendation?: unknown;
}

// ─── Scanner ────────────────────────────────────────────────

/**
 * Scan changed files for security vulnerabilities using an AI provider.
 *
 * @param projectRoot - Absolute path to the project root
 * @param changedFiles - Relative file paths to scan (from project root)
 * @param aiProvider - Any AIProvider implementation
 * @returns Structured scan results with findings, timing, and warnings
 */
export async function scanSecurity(
  projectRoot: string,
  changedFiles: string[],
  aiProvider: AIProvider,
): Promise<SecurityScanResult> {
  const startTime = Date.now();
  const allFindings: SecurityFinding[] = [];
  const cleanFiles: string[] = [];
  const warnings: string[] = [];

  for (const filePath of changedFiles) {
    const absolutePath = join(projectRoot, filePath);

    let content: string;
    try {
      content = await readFile(absolutePath, "utf-8");
    } catch {
      warnings.push(`Could not read file: ${filePath}`);
      continue;
    }

    // Skip empty files and binary files (heuristic: null bytes)
    if (content.length === 0 || content.includes("\0")) {
      cleanFiles.push(filePath);
      continue;
    }

    // Cap file size to avoid blowing AI token limits.
    // For very large files, send only the first 30KB and note truncation.
    const MAX_CONTENT_SIZE = 30_000;
    const truncated = content.length > MAX_CONTENT_SIZE;
    const scanContent = truncated
      ? content.slice(0, MAX_CONTENT_SIZE)
      : content;

    if (truncated) {
      logger.debug(
        `Truncated ${filePath} from ${content.length} to ${MAX_CONTENT_SIZE} bytes for security scan`,
      );
    }

    const messages = buildSecurityPrompt(scanContent, filePath);

    let responseText: string;
    try {
      const response = await aiProvider.generate(messages, {
        temperature: 0.1,
        maxTokens: 4096,
      });
      responseText = response.content;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      warnings.push(`AI provider error scanning ${filePath}: ${message}`);
      continue;
    }

    const fileFindings = parseSecurityResponse(responseText, filePath);

    if (fileFindings === null) {
      warnings.push(
        `Non-parseable AI response for ${filePath} — treating as zero findings`,
      );
      cleanFiles.push(filePath);
      continue;
    }

    if (fileFindings.length === 0) {
      cleanFiles.push(filePath);
    } else {
      allFindings.push(...fileFindings);
    }
  }

  return {
    findings: allFindings,
    filesScanned: changedFiles.length,
    duration: Date.now() - startTime,
    cleanFiles,
    warnings,
  };
}

// ─── Response Parsing ───────────────────────────────────────

/**
 * Parse the AI's JSON response into validated SecurityFinding objects.
 * Returns null if the response is not parseable JSON at all (warning case).
 * Returns empty array if the AI validly reported no findings.
 */
function parseSecurityResponse(
  response: string,
  filePath: string,
): SecurityFinding[] | null {
  const cleaned = stripMarkdownFences(response.trim());

  // Try direct JSON parse
  let parsed = tryParseJSON(cleaned);

  // If that fails, try to extract JSON array from surrounding text
  if (parsed === null) {
    parsed = extractJSONArray(cleaned);
  }

  if (parsed === null) {
    return null;
  }

  // Handle case where AI returns an object with a "findings" key
  if (!Array.isArray(parsed) && typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj["findings"])) {
      parsed = obj["findings"];
    } else {
      return null;
    }
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  return (parsed as RawFinding[])
    .map((raw) => normalizeRawFinding(raw, filePath))
    .filter((f): f is SecurityFinding => f !== null);
}

/**
 * Normalize a raw AI finding into a typed SecurityFinding.
 * Returns null for malformed entries rather than throwing,
 * since a single bad entry should not invalidate the entire response.
 */
function normalizeRawFinding(
  raw: RawFinding,
  filePath: string,
): SecurityFinding | null {
  if (typeof raw !== "object" || raw === null) return null;

  const line = typeof raw.line === "number" ? raw.line : 0;
  const rawType = typeof raw.type === "string" ? raw.type : "";
  const rawSeverity =
    typeof raw.severity === "string" ? raw.severity.toLowerCase() : "";
  const description =
    typeof raw.description === "string" ? raw.description : "";
  const recommendation =
    typeof raw.recommendation === "string" ? raw.recommendation : "";

  // Skip entries with no description — likely noise
  if (description.length === 0) return null;

  // Normalize the check type to a valid SecurityCheck
  const checkType = normalizeCheckType(rawType);
  if (checkType === null) return null;

  // Use the canonical severity for the check type if the AI's severity
  // is invalid. If valid, use the AI's reported severity since it has
  // more context about the specific instance.
  const severity = VALID_SEVERITIES.has(rawSeverity)
    ? (rawSeverity as SecurityFinding["severity"])
    : severityForCheck(checkType);

  const finding: SecurityFinding = {
    file: filePath,
    line,
    checkType,
    severity,
    description,
    owaspCategory: "",
    recommendation,
  };

  // Populate the OWASP reference string
  finding.owaspCategory = formatOwaspRef(finding);

  return finding;
}

/**
 * Map AI-reported type strings to valid SecurityCheck values.
 * Handles common variations and abbreviations the AI might produce.
 */
function normalizeCheckType(raw: string): SecurityCheck | null {
  const lower = raw.toLowerCase().replace(/[\s_]+/g, "-");

  // Direct match
  if (VALID_CHECK_TYPES.has(lower as SecurityCheck)) {
    return lower as SecurityCheck;
  }

  // Common AI variations
  const aliases: Record<string, SecurityCheck> = {
    "sql-injection": "injection",
    "nosql-injection": "injection",
    "command-injection": "injection",
    "os-injection": "injection",
    "ldap-injection": "injection",
    "code-injection": "injection",
    auth: "auth-bypass",
    authentication: "auth-bypass",
    authorization: "auth-bypass",
    "missing-auth": "auth-bypass",
    "broken-access-control": "auth-bypass",
    secrets: "secrets-exposure",
    "hardcoded-secrets": "secrets-exposure",
    "hardcoded-credentials": "secrets-exposure",
    "exposed-secrets": "secrets-exposure",
    "cross-site-scripting": "xss",
    "reflected-xss": "xss",
    "stored-xss": "xss",
    "dom-xss": "xss",
    misconfiguration: "insecure-config",
    "security-misconfiguration": "insecure-config",
    config: "insecure-config",
    "pii-exposure": "data-exposure",
    "information-disclosure": "data-exposure",
    "sensitive-data-exposure": "data-exposure",
    "server-side-request-forgery": "ssrf",
    "crypto-failures": "cryptographic-failures",
    "weak-crypto": "cryptographic-failures",
    deserialization: "insecure-deserialization",
    "unsafe-deserialization": "insecure-deserialization",
    "dependency-vulnerability": "dependency-vulns",
    "vulnerable-dependency": "dependency-vulns",
  };

  return aliases[lower] ?? null;
}

// ─── JSON Helpers ───────────────────────────────────────────

function stripMarkdownFences(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  return fenceMatch?.[1]?.trim() ?? text;
}

function tryParseJSON(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Extract a JSON array from text that may contain surrounding prose.
 * Finds the outermost [...] pair and attempts to parse it.
 */
function extractJSONArray(text: string): unknown[] | null {
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");

  if (firstBracket < 0 || lastBracket <= firstBracket) return null;

  try {
    const parsed = JSON.parse(text.slice(firstBracket, lastBracket + 1));
    return Array.isArray(parsed) ? (parsed as unknown[]) : null;
  } catch {
    return null;
  }
}
