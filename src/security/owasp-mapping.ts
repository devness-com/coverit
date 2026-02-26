/**
 * OWASP Top 10 (2021) Mapping — Maps security findings to their
 * corresponding OWASP category for standardized reporting.
 *
 * Reference: https://owasp.org/Top10/
 *
 * Each SecurityCheck type maps to exactly one OWASP category.
 * The mapping uses the 2021 edition which reorganized categories
 * (e.g., Injection moved from A1 to A03, XSS merged into A03).
 */

import type { SecurityCheck } from "../schema/coverit-manifest.js";

// ─── OWASP Category Definition ──────────────────────────────

export interface OwaspCategory {
  /** OWASP identifier, e.g. "A01:2021" */
  id: string;
  /** Category name, e.g. "Broken Access Control" */
  name: string;
  /** Brief description of the vulnerability class */
  description: string;
}

// ─── SecurityFinding (local to security module) ─────────────

export interface SecurityFinding {
  file: string;
  line: number;
  checkType: SecurityCheck;
  severity: "critical" | "high" | "medium" | "low";
  description: string;
  owaspCategory: string;
  recommendation: string;
}

// ─── Full OWASP Top 10 (2021) Catalog ───────────────────────

export const OWASP_TOP_10: readonly OwaspCategory[] = [
  {
    id: "A01:2021",
    name: "Broken Access Control",
    description:
      "Failures in enforcing access policies so users can act outside their intended permissions. Includes missing authentication, broken authorization, IDOR, and privilege escalation.",
  },
  {
    id: "A02:2021",
    name: "Cryptographic Failures",
    description:
      "Failures related to cryptography that expose sensitive data. Includes hardcoded secrets, weak algorithms, missing encryption, and improper key management.",
  },
  {
    id: "A03:2021",
    name: "Injection",
    description:
      "User-supplied data sent to an interpreter as part of a command or query. Includes SQL, NoSQL, OS command, LDAP injection, and XSS.",
  },
  {
    id: "A04:2021",
    name: "Insecure Design",
    description:
      "Missing or ineffective control design. Focuses on risks related to design and architectural flaws, not implementation bugs.",
  },
  {
    id: "A05:2021",
    name: "Security Misconfiguration",
    description:
      "Missing or incorrect security hardening. Includes unnecessary features enabled, default accounts, overly permissive CORS, verbose errors, and debug mode in production.",
  },
  {
    id: "A06:2021",
    name: "Vulnerable and Outdated Components",
    description:
      "Using components with known vulnerabilities. Includes unpatched libraries, frameworks, and other software dependencies.",
  },
  {
    id: "A07:2021",
    name: "Identification and Authentication Failures",
    description:
      "Failures in confirming user identity, authentication, and session management. Includes weak passwords, missing MFA, and session fixation.",
  },
  {
    id: "A08:2021",
    name: "Software and Data Integrity Failures",
    description:
      "Failures related to code and infrastructure that do not protect against integrity violations. Includes insecure deserialization and untrusted CI/CD pipelines.",
  },
  {
    id: "A09:2021",
    name: "Security Logging and Monitoring Failures",
    description:
      "Insufficient logging, detection, monitoring, and active response. Without proper logging, breaches cannot be detected.",
  },
  {
    id: "A10:2021",
    name: "Server-Side Request Forgery",
    description:
      "SSRF flaws occur when a web application fetches a remote resource without validating the user-supplied URL, allowing attackers to reach internal services.",
  },
] as const;

// ─── SecurityCheck to OWASP Mapping ─────────────────────────
// Each check type maps to the most specific OWASP category.
// XSS is merged into A03 (Injection) per OWASP 2021 reclassification.

const CHECK_TO_OWASP: Record<SecurityCheck, string> = {
  injection: "A03:2021",
  "auth-bypass": "A01:2021",
  "secrets-exposure": "A02:2021",
  xss: "A03:2021",
  "insecure-config": "A05:2021",
  "data-exposure": "A04:2021",
  "dependency-vulns": "A06:2021",
  ssrf: "A10:2021",
  "cryptographic-failures": "A02:2021",
  "insecure-deserialization": "A08:2021",
};

// Pre-index for O(1) lookup by OWASP ID
const OWASP_BY_ID = new Map<string, OwaspCategory>(
  OWASP_TOP_10.map((cat) => [cat.id, cat]),
);

/**
 * Map a security finding to its OWASP Top 10 (2021) category.
 * Returns the full category object including ID, name, and description.
 *
 * Falls back to A03 (Injection) for unknown check types, since injection
 * is the broadest and most common vulnerability class.
 */
export function mapToOwasp(finding: SecurityFinding): OwaspCategory {
  const owaspId = CHECK_TO_OWASP[finding.checkType] ?? "A03:2021";
  return OWASP_BY_ID.get(owaspId) ?? OWASP_TOP_10[2]!;
}

/**
 * Get the OWASP category for a given check type without a full finding.
 * Useful for configuration display and documentation.
 */
export function getOwaspForCheck(check: SecurityCheck): OwaspCategory {
  const owaspId = CHECK_TO_OWASP[check];
  return OWASP_BY_ID.get(owaspId) ?? OWASP_TOP_10[2]!;
}

/**
 * Format a finding's OWASP reference as a human-readable string.
 * Example: "A03:2021 Injection"
 */
export function formatOwaspRef(finding: SecurityFinding): string {
  const category = mapToOwasp(finding);
  return `${category.id} ${category.name}`;
}
