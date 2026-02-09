/**
 * Reporter — Aggregates execution results into a structured report with
 * terminal and markdown output formatters.
 *
 * The terminal formatter produces a polished, color-coded summary using
 * chalk. The markdown formatter produces a file-friendly version suitable
 * for CI artifacts or PR comments.
 */

import chalk from "chalk";
import { randomUUID } from "node:crypto";
import type {
  ProjectInfo,
  TestStrategy,
  ExecutionResult,
  CoveritReport,
  ReportSummary,
  CoverageResult,
  CoverageMetric,
  TestType,
  TypeSummary,
} from "../types/index.js";

// ── Report Generation ──────────────────────────────────────────

export function generateReport(
  project: ProjectInfo,
  strategy: TestStrategy,
  results: ExecutionResult[]
): CoveritReport {
  const summary = buildSummary(strategy, results);
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    duration: totalDuration,
    project,
    strategy,
    results,
    summary,
  };
}

function buildSummary(
  strategy: TestStrategy,
  results: ExecutionResult[]
): ReportSummary {
  let totalTests = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let errorCount = 0;

  const testsByType = initTestsByType();

  for (const result of results) {
    totalTests += result.totalTests;
    passed += result.passed;
    failed += result.failed;
    skipped += result.skipped;

    if (result.status === "error" || result.status === "timeout") {
      errorCount++;
    }

    // Map result back to its plan to get the test type
    const plan = strategy.plans.find((p) => p.id === result.planId);
    if (plan) {
      const entry = testsByType[plan.type];
      entry.total += result.totalTests;
      entry.passed += result.passed;
      entry.failed += result.failed;
      entry.duration += result.duration;
    }
  }

  const coverage = mergeCoverage(results);

  const status: ReportSummary["status"] =
    errorCount > 0
      ? "has-errors"
      : failed > 0
        ? "has-failures"
        : "all-passed";

  return {
    totalPlans: strategy.plans.length,
    totalTests,
    passed,
    failed,
    skipped,
    errorCount,
    coverage,
    status,
    testsByType,
  };
}

function initTestsByType(): Record<TestType, TypeSummary> {
  const types: TestType[] = [
    "unit",
    "integration",
    "api",
    "e2e-browser",
    "e2e-mobile",
    "e2e-desktop",
    "snapshot",
    "performance",
  ];

  const map = {} as Record<TestType, TypeSummary>;
  for (const t of types) {
    map[t] = { total: 0, passed: 0, failed: 0, duration: 0 };
  }
  return map;
}

/**
 * Merge coverage from multiple execution results by summing totals/covered
 * and recomputing percentages.
 */
function mergeCoverage(results: ExecutionResult[]): CoverageResult | null {
  const coverages = results
    .map((r) => r.coverage)
    .filter((c): c is CoverageResult => c !== null);

  if (coverages.length === 0) return null;

  const merge = (key: keyof CoverageResult): CoverageMetric => {
    let total = 0;
    let covered = 0;
    for (const cov of coverages) {
      total += cov[key].total;
      covered += cov[key].covered;
    }
    return {
      total,
      covered,
      percentage: total > 0 ? (covered / total) * 100 : 0,
    };
  };

  return {
    lines: merge("lines"),
    branches: merge("branches"),
    functions: merge("functions"),
    statements: merge("statements"),
  };
}

// ── Terminal Formatter ──────────────────────────────────────────

export function formatTerminalReport(report: CoveritReport): string {
  const lines: string[] = [];
  const { summary, project, duration } = report;

  // Header
  lines.push("");
  lines.push(
    chalk.bold.cyan(
      `  COVERIT  ` +
        chalk.white(project.name) +
        chalk.gray(`  ${report.timestamp.split("T")[0]}`)
    )
  );
  lines.push(chalk.gray("  " + "-".repeat(58)));

  // Summary line
  const summaryParts: string[] = [];
  if (summary.passed > 0) {
    summaryParts.push(chalk.green.bold(`${summary.passed} passed`));
  }
  if (summary.failed > 0) {
    summaryParts.push(chalk.red.bold(`${summary.failed} failed`));
  }
  if (summary.skipped > 0) {
    summaryParts.push(chalk.yellow(`${summary.skipped} skipped`));
  }
  if (summary.errorCount > 0) {
    summaryParts.push(chalk.red(`${summary.errorCount} errors`));
  }

  lines.push(
    `  ${chalk.white.bold(String(summary.totalTests))} tests: ${summaryParts.join(chalk.gray(", "))}`
  );
  lines.push("");

  // Per-type breakdown
  const activeTypes = Object.entries(summary.testsByType).filter(
    ([, v]) => v.total > 0
  );

  if (activeTypes.length > 0) {
    lines.push(chalk.cyan("  Test Breakdown"));
    lines.push(
      chalk.gray(
        `  ${"Type".padEnd(16)} ${"Total".padStart(6)} ${"Pass".padStart(6)} ${"Fail".padStart(6)} ${"Time".padStart(8)}`
      )
    );

    for (const [type, data] of activeTypes) {
      const passStr =
        data.passed > 0
          ? chalk.green(String(data.passed).padStart(6))
          : String(data.passed).padStart(6);
      const failStr =
        data.failed > 0
          ? chalk.red(String(data.failed).padStart(6))
          : String(data.failed).padStart(6);

      lines.push(
        `  ${chalk.white(type.padEnd(16))} ${String(data.total).padStart(6)} ${passStr} ${failStr} ${chalk.gray(formatMs(data.duration).padStart(8))}`
      );
    }
    lines.push("");
  }

  // Coverage table
  if (summary.coverage) {
    lines.push(chalk.cyan("  Coverage"));
    lines.push(
      chalk.gray(
        `  ${"Metric".padEnd(14)} ${"Covered".padStart(8)} ${"Total".padStart(8)} ${"%".padStart(7)}  ${"Bar"}`
      )
    );

    const cov = summary.coverage;
    const metrics: [string, CoverageMetric][] = [
      ["Lines", cov.lines],
      ["Branches", cov.branches],
      ["Functions", cov.functions],
      ["Statements", cov.statements],
    ];

    for (const [name, metric] of metrics) {
      const pct = metric.percentage;
      const pctStr = pct.toFixed(1) + "%";
      const bar = renderBar(pct, 20);
      const color = pct >= 80 ? chalk.green : pct >= 50 ? chalk.yellow : chalk.red;

      lines.push(
        `  ${chalk.white(name.padEnd(14))} ${String(metric.covered).padStart(8)} ${String(metric.total).padStart(8)} ${color(pctStr.padStart(7))}  ${bar}`
      );
    }
    lines.push("");
  }

  // Failure details
  const allFailures = report.results.flatMap((r) =>
    r.failures.map((f) => ({ ...f, planId: r.planId }))
  );

  if (allFailures.length > 0) {
    lines.push(chalk.red.bold(`  Failures (${allFailures.length})`));
    lines.push("");

    for (const failure of allFailures.slice(0, 10)) {
      lines.push(chalk.red(`  x ${failure.testName}`));

      if (failure.message) {
        const msg = failure.message.split("\n")[0]?.slice(0, 120) ?? "";
        lines.push(chalk.gray(`    ${msg}`));
      }

      if (failure.expected && failure.actual) {
        lines.push(
          chalk.gray(`    Expected: `) +
            chalk.green(failure.expected.slice(0, 80))
        );
        lines.push(
          chalk.gray(`    Actual:   `) +
            chalk.red(failure.actual.slice(0, 80))
        );
      }

      if (failure.stack) {
        // Show first 3 lines of the stack trace
        const stackLines = failure.stack
          .split("\n")
          .slice(0, 3)
          .map((l) => `    ${l.trim()}`)
          .join("\n");
        lines.push(chalk.gray(stackLines));
      }

      lines.push("");
    }

    if (allFailures.length > 10) {
      lines.push(
        chalk.gray(`  ... and ${allFailures.length - 10} more failures`)
      );
      lines.push("");
    }
  }

  // Footer
  const statusIcon =
    summary.status === "all-passed"
      ? chalk.green("PASS")
      : summary.status === "has-failures"
        ? chalk.red("FAIL")
        : chalk.red("ERROR");

  lines.push(
    chalk.gray("  " + "-".repeat(58))
  );
  lines.push(
    `  ${statusIcon}  ${chalk.gray("Duration:")} ${chalk.white(formatMs(duration))}  ${chalk.gray("Plans:")} ${chalk.white(String(summary.totalPlans))}`
  );
  lines.push("");

  return lines.join("\n");
}

// ── Markdown Formatter ──────────────────────────────────────────

export function formatMarkdownReport(report: CoveritReport): string {
  const lines: string[] = [];
  const { summary, project, duration } = report;

  lines.push(`# Coverit Report: ${project.name}`);
  lines.push("");
  lines.push(`**Date:** ${report.timestamp}`);
  lines.push(`**Duration:** ${formatMs(duration)}`);
  lines.push(
    `**Status:** ${summary.status === "all-passed" ? "All Passed" : summary.status === "has-failures" ? "Has Failures" : "Has Errors"}`
  );
  lines.push("");

  // Summary
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total Tests | ${summary.totalTests} |`);
  lines.push(`| Passed | ${summary.passed} |`);
  lines.push(`| Failed | ${summary.failed} |`);
  lines.push(`| Skipped | ${summary.skipped} |`);
  lines.push(`| Errors | ${summary.errorCount} |`);
  lines.push("");

  // Type breakdown
  const activeTypes = Object.entries(summary.testsByType).filter(
    ([, v]) => v.total > 0
  );

  if (activeTypes.length > 0) {
    lines.push("## Test Breakdown");
    lines.push("");
    lines.push("| Type | Total | Passed | Failed | Duration |");
    lines.push("|------|-------|--------|--------|----------|");

    for (const [type, data] of activeTypes) {
      lines.push(
        `| ${type} | ${data.total} | ${data.passed} | ${data.failed} | ${formatMs(data.duration)} |`
      );
    }
    lines.push("");
  }

  // Coverage
  if (summary.coverage) {
    lines.push("## Coverage");
    lines.push("");
    lines.push("| Metric | Covered | Total | Percentage |");
    lines.push("|--------|---------|-------|------------|");

    const cov = summary.coverage;
    const metrics: [string, CoverageMetric][] = [
      ["Lines", cov.lines],
      ["Branches", cov.branches],
      ["Functions", cov.functions],
      ["Statements", cov.statements],
    ];

    for (const [name, metric] of metrics) {
      lines.push(
        `| ${name} | ${metric.covered} | ${metric.total} | ${metric.percentage.toFixed(1)}% |`
      );
    }
    lines.push("");
  }

  // Failures
  const allFailures = report.results.flatMap((r) =>
    r.failures.map((f) => ({ ...f, planId: r.planId }))
  );

  if (allFailures.length > 0) {
    lines.push("## Failures");
    lines.push("");

    for (const failure of allFailures) {
      lines.push(`### ${failure.testName}`);
      lines.push("");

      if (failure.message) {
        lines.push("```");
        lines.push(failure.message.slice(0, 500));
        lines.push("```");
      }

      if (failure.expected && failure.actual) {
        lines.push("");
        lines.push(`- **Expected:** \`${failure.expected.slice(0, 200)}\``);
        lines.push(`- **Actual:** \`${failure.actual.slice(0, 200)}\``);
      }

      if (failure.stack) {
        lines.push("");
        lines.push("<details><summary>Stack trace</summary>");
        lines.push("");
        lines.push("```");
        lines.push(failure.stack.slice(0, 1000));
        lines.push("```");
        lines.push("");
        lines.push("</details>");
      }

      lines.push("");
    }
  }

  lines.push("---");
  lines.push("*Generated by [coverit](https://github.com/coverit)*");

  return lines.join("\n");
}

// ── Helpers ─────────────────────────────────────────────────────

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = ((ms % 60_000) / 1000).toFixed(0);
  return `${mins}m ${secs}s`;
}

function renderBar(percentage: number, width: number): string {
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;
  const color =
    percentage >= 80 ? chalk.green : percentage >= 50 ? chalk.yellow : chalk.red;

  return color("\u2588".repeat(filled)) + chalk.gray("\u2591".repeat(empty));
}
