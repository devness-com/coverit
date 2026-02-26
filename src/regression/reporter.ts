/**
 * Regression Reporter — Formats regression results for terminal output.
 *
 * Renders a human-readable report showing:
 *   - Test counts (passing, failing, skipped)
 *   - New regressions with failure details
 *   - Pre-existing failures (informational, not actionable)
 *   - Newly fixed tests
 *   - Score impact estimate
 *
 * Uses chalk for terminal colors. All output goes to stdout.
 */

import chalk from "chalk";
import type { RegressionComparison } from "./comparator.js";
import type { RegressionFailure } from "./runner.js";

// ─── Public API ─────────────────────────────────────────────

/**
 * Render a formatted regression report to the terminal.
 *
 * The report is structured to surface actionable information first
 * (new regressions) and push informational context lower (pre-existing
 * failures, fixed tests).
 */
export function renderRegressionReport(comparison: RegressionComparison): void {
  const { currentTotal, newFailures, existingFailures, newPasses, status } = comparison;

  console.log("");
  console.log(chalk.bold(`  Regression Check (${currentTotal} tests)`));
  console.log("");

  // Summary line
  const passingLabel = chalk.green(`${comparison.currentPassing} passing`);
  const failingCount = newFailures.length + existingFailures.length;
  const failingLabel = failingCount > 0
    ? chalk.red(`${failingCount} failing`)
    : chalk.green("0 failing");
  const skippedLabel = chalk.gray(
    `${currentTotal - comparison.currentPassing - failingCount} skipped`,
  );

  console.log(`  ${passingLabel}  ${failingLabel}  ${skippedLabel}`);
  console.log("");

  // Status badge
  renderStatusBadge(status);

  // New regressions (most important — these are YOUR bugs)
  if (newFailures.length > 0) {
    console.log("");
    console.log(
      chalk.red.bold(`  NEW REGRESSION${newFailures.length > 1 ? "S" : ""} (${newFailures.length}):`),
    );
    for (const failure of newFailures) {
      renderFailure(failure, "regression");
    }
  }

  // Pre-existing failures (not your fault)
  if (existingFailures.length > 0) {
    console.log("");
    console.log(
      chalk.yellow.bold(`  PRE-EXISTING (${existingFailures.length}):`),
    );
    for (const failure of existingFailures) {
      renderFailure(failure, "existing");
    }
  }

  // Newly fixed tests
  if (newPasses.length > 0) {
    console.log("");
    console.log(
      chalk.green.bold(`  FIXED (${newPasses.length}):`),
    );
    for (const pass of newPasses) {
      console.log(`     ${chalk.green("+")} ${pass}`);
    }
  }

  // Score impact estimate
  renderScoreImpact(comparison);

  console.log("");
}

// ─── Internal Renderers ─────────────────────────────────────

function renderStatusBadge(status: RegressionComparison["status"]): void {
  switch (status) {
    case "all-passing":
      console.log(chalk.green("  All existing tests pass. No regressions detected."));
      break;
    case "has-regressions":
      console.log(chalk.red("  Regressions detected! Some previously passing tests are now failing."));
      break;
    case "improved":
      console.log(chalk.green("  Test health improved! Some previously failing tests are now passing."));
      break;
    case "no-baseline":
      console.log(chalk.gray("  No baseline data. This is the first regression check for this project."));
      break;
  }
}

/**
 * Render a single failure with indented details.
 * Context distinguishes "this is your fault" (regression) from
 * "this was already broken" (existing).
 */
function renderFailure(
  failure: RegressionFailure,
  context: "regression" | "existing",
): void {
  const icon = context === "regression" ? chalk.red("x") : chalk.yellow("!");
  const fileLabel = chalk.dim(failure.testFile);

  console.log(`     ${icon} ${fileLabel}`);
  console.log(`       ${chalk.white(`"${failure.testName}"`)}`);

  // Truncate long messages to keep output scannable
  const message = failure.message.length > 200
    ? failure.message.slice(0, 200) + "..."
    : failure.message;
  console.log(`       ${chalk.dim(message)}`);

  if (context === "regression") {
    console.log(chalk.red.dim("       This test was passing before your changes."));
  } else {
    console.log(chalk.yellow.dim("       Known failing test (not your fault)."));
  }
}

/**
 * Estimate and render the score impact of regressions.
 *
 * The regression dimension score is (passing/total)*100. We show
 * what the score would drop to based on new failures.
 */
function renderScoreImpact(comparison: RegressionComparison): void {
  if (comparison.status === "no-baseline") return;

  const { currentTotal, currentPassing, newFailures } = comparison;
  if (currentTotal === 0) return;

  const currentScore = Math.round((currentPassing / currentTotal) * 100);

  // Estimate what score would be without new regressions
  const withoutRegressions = currentTotal > 0
    ? Math.round(((currentPassing + newFailures.length) / currentTotal) * 100)
    : 100;

  console.log("");
  if (newFailures.length > 0) {
    console.log(
      `  Score impact: regression dimension ${chalk.green(String(withoutRegressions))} ${chalk.dim("->")} ${chalk.red(String(currentScore))}`,
    );
  } else if (comparison.status === "improved") {
    console.log(
      `  Score impact: regression dimension ${chalk.dim("->")} ${chalk.green(String(currentScore))}`,
    );
  } else {
    console.log(
      `  Score: regression dimension ${chalk.green(String(currentScore))}`,
    );
  }
}
