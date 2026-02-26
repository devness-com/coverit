/**
 * Severity Classification — Determines the impact level of security findings
 *
 * Severity is derived from the check type, following the same mapping used
 * by the scoring module (CHECK_TO_SEVERITY in weights.ts). This module
 * provides a typed interface specifically for the security scanner pipeline,
 * ensuring consistent severity assignment between scanning and scoring.
 *
 * Severity tiers and their point costs (from schema/defaults.ts):
 *   critical: 25 pts — Direct exploitation vectors (injection, auth bypass)
 *   high:     15 pts — Significant exposure (secrets, XSS, SSRF)
 *   medium:    8 pts — Configuration/design issues (data exposure, insecure config)
 *   low:       3 pts — Informational (dependency vulns)
 */

import type { SecurityCheck } from "../schema/coverit-manifest.js";
import type { SecurityFinding } from "./owasp-mapping.js";

export type Severity = "critical" | "high" | "medium" | "low";

/**
 * Canonical severity for each SecurityCheck type.
 * Mirrors the CHECK_TO_SEVERITY mapping in scoring/weights.ts
 * but with proper SecurityCheck keys and Severity values for type safety.
 */
const CHECK_SEVERITY: Record<SecurityCheck, Severity> = {
  injection: "critical",
  "auth-bypass": "critical",
  "secrets-exposure": "high",
  xss: "high",
  ssrf: "high",
  "insecure-deserialization": "high",
  "cryptographic-failures": "high",
  "data-exposure": "medium",
  "insecure-config": "medium",
  "dependency-vulns": "low",
};

/**
 * Classify the severity of a security finding based on its check type.
 * The finding's existing severity field is ignored — we derive severity
 * solely from the check type to ensure consistency with the scoring model.
 */
export function classifySeverity(finding: SecurityFinding): Severity {
  return CHECK_SEVERITY[finding.checkType] ?? "medium";
}

/**
 * Get the canonical severity for a check type directly.
 * Useful when constructing findings before the full SecurityFinding
 * object exists (e.g., during AI response parsing).
 */
export function severityForCheck(check: SecurityCheck): Severity {
  return CHECK_SEVERITY[check] ?? "medium";
}

/**
 * Sort order for severity levels: critical first, low last.
 * Returns a negative number if a is more severe, positive if b is.
 */
const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * Compare two severity levels for sorting.
 * Returns negative if `a` is more severe than `b`.
 */
export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_ORDER[a] - SEVERITY_ORDER[b];
}

/**
 * Check whether a severity level meets or exceeds a minimum threshold.
 * "critical" is the highest severity; "low" is the lowest.
 */
export function meetsThreshold(
  severity: Severity,
  minimum: Severity,
): boolean {
  return SEVERITY_ORDER[severity] <= SEVERITY_ORDER[minimum];
}
