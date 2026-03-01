/**
 * Dashboard — Terminal quality dashboard renderer
 *
 * Renders a rich terminal dashboard from a CoveritManifest using chalk
 * for colors and Unicode box-drawing characters for layout.
 *
 * No AI, no filesystem — pure stdout rendering.
 */

import chalk, { type ChalkInstance } from "chalk";
import type {
  CoveritManifest,
  ModuleEntry,
  FunctionalTestType,
  DimensionScores,
  Dimension,
  GapSummary,
} from "../schema/coverit-manifest.js";
import { getScoreHealth } from "../schema/defaults.js";
import type { ScoreHealth } from "../schema/defaults.js";

// ─── Constants ──────────────────────────────────────────────

const BAR_WIDTH = 20;
const FILLED_CHAR = "\u2588"; // Full block
const EMPTY_CHAR = "\u2591"; // Light shade

const DIMENSION_LABELS: Record<Dimension, string> = {
  functionality: "Functionality",
  security: "Security",
  stability: "Stability",
  conformance: "Conformance",
  regression: "Regression",
};

const TEST_TYPE_LABELS: Record<FunctionalTestType, string> = {
  unit: "Unit",
  integration: "Intg",
  api: "API",
  e2e: "E2E",
  contract: "Cntr",
};

const TEST_TYPE_ORDER: FunctionalTestType[] = [
  "unit",
  "integration",
  "api",
  "e2e",
  "contract",
];

// ─── Public API ─────────────────────────────────────────────

/**
 * Render the full quality dashboard to stdout.
 */
export function renderDashboard(manifest: CoveritManifest): void {
  const { score, modules } = manifest;
  const scanned = score.scanned ?? {};
  const lines: string[] = [];

  lines.push("");
  lines.push(...renderHeader(score.overall));
  lines.push("");
  lines.push(...renderDimensions(score.breakdown, scanned));
  lines.push("");
  lines.push(...renderGaps(score.gaps, modules));
  lines.push("");
  lines.push(...renderModuleTable(modules));
  lines.push("");

  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}

// ─── Header ─────────────────────────────────────────────────

function renderHeader(overall: number): string[] {
  const health = getScoreHealth(overall);
  const indicator = healthIndicator(health);
  const colorFn = healthColor(health);

  const title = `coverit -- Quality Score: ${colorFn(`${overall}/100`)}  ${indicator}`;
  // Rough visible length for box sizing (strip ANSI)
  const visibleLen = stripAnsi(title).length;
  const boxWidth = Math.max(visibleLen + 4, 44);
  const pad = boxWidth - visibleLen - 4;

  return [
    `  ${chalk.gray("\u256D" + "\u2500".repeat(boxWidth) + "\u256E")}`,
    `  ${chalk.gray("\u2502")}  ${title}${" ".repeat(Math.max(0, pad))}  ${chalk.gray("\u2502")}`,
    `  ${chalk.gray("\u2570" + "\u2500".repeat(boxWidth) + "\u256F")}`,
  ];
}

// ─── Dimension Breakdown ────────────────────────────────────

function renderDimensions(
  breakdown: DimensionScores,
  scanned: Partial<Record<Dimension, string>>,
): string[] {
  const lines: string[] = [];
  lines.push(`  ${chalk.bold("Dimensions")}`);

  const dims = Object.keys(DIMENSION_LABELS) as Dimension[];

  for (let i = 0; i < dims.length; i++) {
    const dim = dims[i]!;
    const score = breakdown[dim];
    const isScanned = scanned[dim] != null;
    const label = DIMENSION_LABELS[dim].padEnd(16);
    const connector = i === dims.length - 1 ? "\u2514" : "\u251C";

    if (!isScanned) {
      // Unscanned dimension — show "pending" with appropriate guidance
      lines.push(
        `  ${chalk.gray(connector + "\u2500\u2500")} ${label} ${chalk.dim("pending".padStart(7))}  ${chalk.dim("coming soon")}`,
      );
    } else {
      const scoreStr = `${score}/100`.padStart(7);
      const bar = renderBar(score);
      const colorFn = scoreColor(score);
      lines.push(
        `  ${chalk.gray(connector + "\u2500\u2500")} ${label} ${colorFn(scoreStr)}  ${bar}`,
      );
    }
  }

  return lines;
}

// ─── Gap Summary ────────────────────────────────────────────

function renderGaps(gaps: GapSummary, modules: ModuleEntry[]): string[] {
  const lines: string[] = [];

  if (gaps.total === 0) {
    lines.push(`  ${chalk.bold("Gaps")}  ${chalk.green("None -- all clear")}`);
    return lines;
  }

  const criticalStr =
    gaps.critical > 0
      ? `, ${chalk.red(`${gaps.critical} critical`)}`
      : "";
  lines.push(
    `  ${chalk.bold("Gaps")} (${gaps.total} total${criticalStr})`,
  );

  // Collect specific gap items from modules, sorted by severity
  const gapItems = collectGapItems(modules);

  // Show up to 8 gap items
  const maxItems = 8;
  const displayed = gapItems.slice(0, maxItems);

  for (let i = 0; i < displayed.length; i++) {
    const item = displayed[i]!;
    const connector = i === displayed.length - 1 && gapItems.length <= maxItems
      ? "\u2514"
      : "\u251C";
    const icon = item.severity === "critical"
      ? chalk.red("\u25CF")
      : item.severity === "high"
        ? chalk.yellow("\u25CF")
        : chalk.blue("\u25CF");

    lines.push(
      `  ${chalk.gray(connector + "\u2500\u2500")} ${icon} ${item.dimension}: ${item.description}`,
    );
  }

  if (gapItems.length > maxItems) {
    lines.push(
      `  ${chalk.gray("\u2514\u2500\u2500")} ${chalk.dim(`... and ${gapItems.length - maxItems} more`)}`,
    );
  }

  return lines;
}

interface GapItem {
  dimension: string;
  severity: "critical" | "high" | "medium" | "low";
  description: string;
}

/**
 * Extract concrete gap descriptions from module data.
 * Security findings and stability gaps become individual items.
 * Functionality gaps are summarized per module.
 */
function collectGapItems(modules: ModuleEntry[]): GapItem[] {
  const items: GapItem[] = [];

  for (const mod of modules) {
    // Security findings
    for (const finding of mod.security.findings) {
      items.push({
        dimension: "Security",
        severity: finding.startsWith("injection") || finding.startsWith("auth-bypass")
          ? "critical"
          : "high",
        description: `${finding} in ${mod.path}`,
      });
    }

    // Stability gaps
    for (const gap of mod.stability.gaps) {
      items.push({
        dimension: "Stability",
        severity: mod.stability.score < 50 ? "high" : "medium",
        description: `${gap} in ${mod.path}`,
      });
    }

    // Conformance violations
    for (const violation of mod.conformance.violations) {
      items.push({
        dimension: "Conformance",
        severity: "medium",
        description: `${violation} in ${mod.path}`,
      });
    }

    // Functionality: summarize missing tests per module
    const missingTypes: string[] = [];
    for (const [type, coverage] of Object.entries(mod.functionality.tests)) {
      if (!coverage) continue;
      const deficit = coverage.expected - coverage.current;
      if (deficit > 0) {
        missingTypes.push(`${deficit} ${type}`);
      }
    }
    if (missingTypes.length > 0) {
      items.push({
        dimension: "Functionality",
        severity: missingTypes.some((t) => t.includes("integration"))
          ? "high"
          : "medium",
        description: `${missingTypes.join(", ")} tests missing for ${mod.path}`,
      });
    }
  }

  // Sort: critical first, then high, medium, low
  const severityOrder: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  items.sort(
    (a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3),
  );

  return items;
}

// ─── Module Table ───────────────────────────────────────────

function renderModuleTable(modules: ModuleEntry[]): string[] {
  const lines: string[] = [];

  if (modules.length === 0) {
    lines.push(`  ${chalk.bold("Modules")}  ${chalk.dim("(none)")}`);
    return lines;
  }

  lines.push(`  ${chalk.bold("Modules")} (${modules.length})`);

  // Column widths
  const colModule = 20;
  const colCmplx = 8;
  const colTest = 6;
  const colScore = 6;

  // Header
  const headerCells = [
    "Module".padEnd(colModule),
    "Cmplx".padEnd(colCmplx),
    ...TEST_TYPE_ORDER.map((t) => TEST_TYPE_LABELS[t].padStart(colTest)),
    "Score".padStart(colScore),
  ];

  const dividerCells = [
    "\u2500".repeat(colModule),
    "\u2500".repeat(colCmplx),
    ...TEST_TYPE_ORDER.map(() => "\u2500".repeat(colTest)),
    "\u2500".repeat(colScore),
  ];

  lines.push(
    `  ${chalk.gray("\u250C")}\u2500${headerCells.map((_, i) => chalk.gray(dividerCells[i])).join(chalk.gray("\u2500\u252C\u2500"))}\u2500${chalk.gray("\u2510")}`,
  );
  lines.push(
    `  ${chalk.gray("\u2502")} ${headerCells.map((c) => chalk.bold(c)).join(chalk.gray(" \u2502 "))} ${chalk.gray("\u2502")}`,
  );
  lines.push(
    `  ${chalk.gray("\u251C")}\u2500${dividerCells.map((d) => chalk.gray(d)).join(chalk.gray("\u2500\u253C\u2500"))}\u2500${chalk.gray("\u2524")}`,
  );

  // Data rows
  for (const mod of modules) {
    const cells: string[] = [];

    // Module name: truncate if needed
    const modName =
      mod.path.length > colModule
        ? mod.path.slice(0, colModule - 1) + "\u2026"
        : mod.path.padEnd(colModule);
    cells.push(modName);

    // Complexity
    const cmplxColor =
      mod.complexity === "high"
        ? chalk.red
        : mod.complexity === "medium"
          ? chalk.yellow
          : chalk.green;
    cells.push(cmplxColor(mod.complexity.padEnd(colCmplx)));

    // Test counts per type
    for (const testType of TEST_TYPE_ORDER) {
      const coverage = mod.functionality.tests[testType];
      if (!coverage) {
        cells.push(chalk.dim("-".padStart(colTest)));
      } else {
        const text = `${coverage.current}/${coverage.expected}`;
        const ratio =
          coverage.expected > 0 ? coverage.current / coverage.expected : 1;
        const colorFn = ratio >= 1 ? chalk.green : ratio >= 0.5 ? chalk.yellow : chalk.red;
        cells.push(colorFn(text.padStart(colTest)));
      }
    }

    // Module-level score: compute from functionality coverage ratio
    const moduleScore = computeModuleScore(mod);
    const scoreColorFn = scoreColor(moduleScore);
    cells.push(scoreColorFn(String(moduleScore).padStart(colScore)));

    lines.push(
      `  ${chalk.gray("\u2502")} ${cells.join(chalk.gray(" \u2502 "))} ${chalk.gray("\u2502")}`,
    );
  }

  // Bottom border
  lines.push(
    `  ${chalk.gray("\u2514")}\u2500${dividerCells.map((d) => chalk.gray(d)).join(chalk.gray("\u2500\u2534\u2500"))}\u2500${chalk.gray("\u2518")}`,
  );

  return lines;
}

/**
 * Compute a 0-100 score for a single module.
 *
 * Each test type is scored independently (capped at 100%), then
 * averaged. This prevents over-delivery in one type (e.g. 500 unit
 * tests) from masking zero coverage in another type (e.g. 0 integration).
 */
function computeModuleScore(mod: ModuleEntry): number {
  const typeScores: number[] = [];

  for (const coverage of Object.values(mod.functionality.tests)) {
    if (!coverage) continue;
    if (coverage.expected === 0) {
      typeScores.push(coverage.current > 0 ? 100 : 100);
    } else {
      typeScores.push(Math.min(100, (coverage.current / coverage.expected) * 100));
    }
  }

  if (typeScores.length === 0) return 0;

  const avg = typeScores.reduce((sum, s) => sum + s, 0) / typeScores.length;
  return Math.round(avg);
}

// ─── Rendering Helpers ──────────────────────────────────────

/**
 * Render a progress bar: filled blocks + empty blocks, colored by score.
 */
function renderBar(score: number): string {
  const filled = Math.round((score / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const colorFn = scoreColor(score);

  return colorFn(FILLED_CHAR.repeat(filled)) + chalk.gray(EMPTY_CHAR.repeat(empty));
}

/**
 * Get chalk color function based on score thresholds.
 */
function scoreColor(score: number): ChalkInstance {
  if (score >= 70) return chalk.green;
  if (score >= 50) return chalk.yellow;
  return chalk.red;
}

/**
 * Get chalk color function based on health status.
 */
function healthColor(health: ScoreHealth): ChalkInstance {
  switch (health) {
    case "healthy":
      return chalk.green;
    case "needs-attention":
      return chalk.yellow;
    case "at-risk":
      return chalk.red;
  }
}

/**
 * Get a colored circle indicator for the health status.
 */
function healthIndicator(health: ScoreHealth): string {
  switch (health) {
    case "healthy":
      return chalk.green("\u25CF");
    case "needs-attention":
      return chalk.yellow("\u25CF");
    case "at-risk":
      return chalk.red("\u25CF");
  }
}

/**
 * Strip ANSI escape codes for calculating visible string width.
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, "");
}
