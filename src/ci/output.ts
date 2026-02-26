/**
 * CI Output — Machine-readable output for CI/CD pipelines.
 *
 * Generates structured data that CI systems can parse for quality gates,
 * status badges, and trend tracking. Supports two formats:
 *
 *   - "json": Full structured data for custom integrations
 *   - "github": GitHub Actions workflow commands (::set-output, annotations)
 *
 * This module is pure — no side effects, no I/O. It returns strings
 * that the caller writes to stdout or files.
 */

import type {
  CoveritManifest,
  Dimension,
  DimensionScores,
  GapSummary,
} from "../schema/coverit-manifest.js";
import { SCORE_THRESHOLDS } from "../schema/defaults.js";

// ─── Public Types ───────────────────────────────────────────

export interface CIOutputData {
  score: number;
  previousScore: number | null;
  delta: number | null;
  status: "improved" | "stable" | "degraded" | "first-run";
  dimensions: DimensionScores;
  gaps: GapSummary;
  regressions: number;
  securityIssues: number;
  /** Whether the score meets the quality gate threshold */
  gatePassed: boolean;
  /** The threshold used for the gate check */
  threshold: number;
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Generate machine-readable CI output from a manifest.
 *
 * @param manifest - The current project manifest with computed scores
 * @param format - Output format: "json" for structured data, "github" for Actions commands
 * @param previousScore - Optional previous overall score for delta calculation
 * @returns Formatted string ready for stdout or file output
 */
export function generateCIOutput(
  manifest: CoveritManifest,
  format: "json" | "github",
  previousScore?: number,
): string {
  const data = buildOutputData(manifest, previousScore);

  switch (format) {
    case "json":
      return formatAsJson(data);
    case "github":
      return formatAsGitHub(data);
  }
}

/**
 * Determine the recommended exit code for CI pipelines.
 *
 * Returns 0 when the quality gate passes, 1 when it fails.
 * The gate fails when:
 *   - The overall score is below the threshold, OR
 *   - There are regressions (new test failures)
 */
export function getCIExitCode(manifest: CoveritManifest): number {
  const score = manifest.score.overall;
  const regressions = countRegressions(manifest);

  if (score < SCORE_THRESHOLDS.healthy || regressions > 0) {
    return 1;
  }
  return 0;
}

// ─── Data Building ──────────────────────────────────────────

function buildOutputData(
  manifest: CoveritManifest,
  previousScore?: number,
): CIOutputData {
  const score = manifest.score.overall;
  const delta = previousScore != null ? score - previousScore : null;

  let status: CIOutputData["status"];
  if (previousScore == null) {
    status = "first-run";
  } else if (delta! > 0) {
    status = "improved";
  } else if (delta! < 0) {
    status = "degraded";
  } else {
    status = "stable";
  }

  const securityIssues = countSecurityIssues(manifest);
  const regressions = countRegressions(manifest);
  const gatePassed = score >= SCORE_THRESHOLDS.healthy && regressions === 0;

  return {
    score,
    previousScore: previousScore ?? null,
    delta,
    status,
    dimensions: manifest.score.breakdown,
    gaps: manifest.score.gaps,
    regressions,
    securityIssues,
    gatePassed,
    threshold: SCORE_THRESHOLDS.healthy,
  };
}

// ─── JSON Format ────────────────────────────────────────────

function formatAsJson(data: CIOutputData): string {
  return JSON.stringify(data, null, 2);
}

// ─── GitHub Actions Format ──────────────────────────────────

/**
 * Generate GitHub Actions-compatible output.
 *
 * Uses:
 *   - `::set-output` commands for step outputs (legacy, still widely used)
 *   - `$GITHUB_OUTPUT` compatible key=value pairs
 *   - `::notice` / `::warning` / `::error` for annotations
 */
function formatAsGitHub(data: CIOutputData): string {
  const lines: string[] = [];

  // Step outputs (compatible with both legacy and new output methods)
  lines.push(`score=${data.score}`);
  lines.push(`status=${data.status}`);
  lines.push(`gate-passed=${data.gatePassed}`);
  lines.push(`regressions=${data.regressions}`);
  lines.push(`security-issues=${data.securityIssues}`);

  if (data.delta != null) {
    lines.push(`delta=${data.delta}`);
  }

  // Dimension scores as individual outputs
  const dimensions: Dimension[] = [
    "functionality",
    "security",
    "stability",
    "conformance",
    "regression",
  ];
  for (const dim of dimensions) {
    lines.push(`dimension-${dim}=${data.dimensions[dim]}`);
  }

  // Annotations for visibility in the GitHub Actions UI
  lines.push("");

  if (!data.gatePassed) {
    if (data.regressions > 0) {
      lines.push(
        `::error::Coverit: ${data.regressions} regression(s) detected. Score: ${data.score}/${data.threshold}`,
      );
    } else {
      lines.push(
        `::warning::Coverit: Quality score ${data.score} is below threshold ${data.threshold}`,
      );
    }
  } else {
    const deltaLabel = data.delta != null && data.delta !== 0
      ? ` (${data.delta > 0 ? "+" : ""}${data.delta})`
      : "";
    lines.push(
      `::notice::Coverit: Quality gate passed. Score: ${data.score}/100${deltaLabel}`,
    );
  }

  // Per-dimension warnings for at-risk scores
  for (const dim of dimensions) {
    const dimScore = data.dimensions[dim];
    if (dimScore < SCORE_THRESHOLDS.needsAttention) {
      lines.push(
        `::warning::Coverit: ${capitalize(dim)} dimension at risk (${dimScore}/100)`,
      );
    }
  }

  return lines.join("\n");
}

// ─── Helpers ────────────────────────────────────────────────

function countSecurityIssues(manifest: CoveritManifest): number {
  let count = 0;
  for (const mod of manifest.modules) {
    count += mod.security.issues;
  }
  return count;
}

/**
 * Count regressions as the gap between expected and current test counts
 * that result in a regression score below 100.
 *
 * This is an approximation — the true regression count comes from
 * the regression runner. But for CI output without running tests,
 * we derive it from the manifest's score data.
 */
function countRegressions(manifest: CoveritManifest): number {
  const regressionScore = manifest.score.breakdown.regression;
  if (regressionScore >= 100) return 0;

  // Reverse-engineer from the score: score = (passing/total)*100
  // regressions = total - passing = total * (1 - score/100)
  let totalTests = 0;
  for (const mod of manifest.modules) {
    const testEntries = Object.values(mod.functionality.tests);
    for (const coverage of testEntries) {
      totalTests += coverage.expected;
    }
  }

  if (totalTests === 0) return 0;
  return Math.round(totalTests * (1 - regressionScore / 100));
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
