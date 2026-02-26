/**
 * Security Reporter — Terminal output formatter for security scan results
 *
 * Renders a color-coded, structured report that clearly distinguishes
 * between code vulnerabilities (the developer's code has a security flaw)
 * and test issues (a test is missing security coverage). Uses chalk for
 * ANSI color output consistent with the rest of coverit's CLI.
 *
 * Output levels:
 *   Red circle:    CRITICAL — must fix before shipping
 *   Orange circle: HIGH — should fix soon
 *   Yellow circle: MEDIUM — fix when practical
 *   Blue circle:   LOW — informational
 *   Green check:   No issues found
 */

import chalk from "chalk";
import type { SecurityScanResult } from "./scanner.js";
import type { SecurityFinding } from "./owasp-mapping.js";
import { compareSeverity, type Severity } from "./severity.js";

// ─── Severity Display Config ────────────────────────────────

interface SeverityStyle {
  icon: string;
  label: string;
  colorize: (text: string) => string;
}

const SEVERITY_STYLES: Record<Severity, SeverityStyle> = {
  critical: {
    icon: "\u{1F534}",
    label: "CRITICAL",
    colorize: (t: string) => chalk.red.bold(t),
  },
  high: {
    icon: "\u{1F7E0}",
    label: "HIGH",
    colorize: (t: string) => chalk.hex("#FF8C00")(t),
  },
  medium: {
    icon: "\u{1F7E1}",
    label: "MEDIUM",
    colorize: (t: string) => chalk.yellow(t),
  },
  low: {
    icon: "\u{1F535}",
    label: "LOW",
    colorize: (t: string) => chalk.blue(t),
  },
};

// ─── Public API ─────────────────────────────────────────────

/**
 * Render a full security scan report to the terminal (stdout).
 * Findings are sorted by severity (critical first), then by file path.
 */
export function renderSecurityReport(results: SecurityScanResult): void {
  const { findings, filesScanned, duration, cleanFiles, warnings } = results;

  // Header
  console.log("");
  console.log(
    chalk.bold(`  Security Scan (${filesScanned} file${filesScanned !== 1 ? "s" : ""} scanned)`),
  );
  console.log(chalk.gray(`  Completed in ${formatDuration(duration)}`));
  console.log("");

  // Warnings from scanner (non-parseable responses, read failures)
  if (warnings.length > 0) {
    for (const warning of warnings) {
      console.log(chalk.yellow(`  \u26A0  ${warning}`));
    }
    console.log("");
  }

  if (findings.length === 0) {
    console.log(chalk.green("  \u2705 No security issues found"));
    console.log("");
    return;
  }

  // Sort: critical first, then by file for stable output
  const sorted = [...findings].sort((a, b) => {
    const severityDiff = compareSeverity(a.severity, b.severity);
    if (severityDiff !== 0) return severityDiff;
    return a.file.localeCompare(b.file);
  });

  // Group by category for the summary line
  const bySeverity = groupBySeverity(sorted);

  // Summary counts
  const summaryParts: string[] = [];
  for (const sev of ["critical", "high", "medium", "low"] as const) {
    const count = bySeverity[sev]?.length ?? 0;
    if (count > 0) {
      const style = SEVERITY_STYLES[sev];
      summaryParts.push(style.colorize(`${count} ${style.label.toLowerCase()}`));
    }
  }
  console.log(`  Found ${chalk.bold(String(findings.length))} issue${findings.length !== 1 ? "s" : ""}: ${summaryParts.join(", ")}`);
  console.log("");

  // Individual findings
  for (const finding of sorted) {
    renderFinding(finding);
  }

  // Clean files
  if (cleanFiles.length > 0) {
    console.log(
      chalk.green(`  \u2705 No issues: ${cleanFiles.join(", ")}`),
    );
    console.log("");
  }
}

/**
 * Render a compact one-line-per-finding summary.
 * Useful for CI output or when piped to other tools.
 */
export function renderCompactReport(results: SecurityScanResult): void {
  const { findings } = results;

  if (findings.length === 0) {
    console.log("[security] No issues found");
    return;
  }

  const sorted = [...findings].sort((a, b) =>
    compareSeverity(a.severity, b.severity),
  );

  for (const f of sorted) {
    const style = SEVERITY_STYLES[f.severity];
    console.log(
      `${style.icon} ${style.label} ${f.file}:${f.line} — ${f.description} [${f.owaspCategory}]`,
    );
  }
}

// ─── Internal Rendering ─────────────────────────────────────

function renderFinding(finding: SecurityFinding): void {
  const style = SEVERITY_STYLES[finding.severity];
  const location = chalk.gray(`${finding.file}:${finding.line}`);

  // Distinguish code vulnerabilities from test coverage gaps.
  // Test files (*.spec.ts, *.test.ts) are flagged differently because
  // a security issue in a test file is about test quality, not prod risk.
  const isTestFile = /\.(test|spec)\.[jt]sx?$/.test(finding.file);
  const categoryLabel = isTestFile
    ? chalk.gray("[test issue]")
    : chalk.gray("[code vulnerability]");

  console.log(
    `  ${style.icon} ${style.colorize(style.label)}: ${location} ${categoryLabel}`,
  );
  console.log(
    `     ${finding.checkType} ${chalk.dim("\u2014")} ${finding.description}`,
  );
  console.log(
    `     ${chalk.dim("OWASP:")} ${finding.owaspCategory}`,
  );
  console.log(
    `     ${chalk.dim("Fix:")} ${finding.recommendation}`,
  );
  console.log("");
}

// ─── Helpers ────────────────────────────────────────────────

function groupBySeverity(
  findings: SecurityFinding[],
): Partial<Record<Severity, SecurityFinding[]>> {
  const groups: Partial<Record<Severity, SecurityFinding[]>> = {};
  for (const f of findings) {
    const group = groups[f.severity];
    if (group) {
      group.push(f);
    } else {
      groups[f.severity] = [f];
    }
  }
  return groups;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = (ms / 1000).toFixed(1);
  return `${seconds}s`;
}
