#!/usr/bin/env node

/**
 * Coverit — CLI
 *
 * Interactive command-line interface for scanning, generating,
 * running tests, and viewing reports.
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { orchestrate, fixFailingTests, recheckTests } from "../agents/orchestrator.js";
import { detectProjectInfo } from "../utils/framework-detector.js";
import { isGitRepo } from "../utils/git.js";
import { resolveRunId, listRuns, getRunStatus, getRunDir, deleteRun, clearRuns } from "../utils/run-manager.js";
import { logger } from "../utils/logger.js";
import type { TestType, DiffSource, CoveritConfig, CoveritEvent } from "../types/index.js";

const VERSION = "0.1.0";
const BANNER = chalk.bold.cyan(`
  coverit v${VERSION}
  Your code, covered.
`);

// ─── Shared helpers ──────────────────────────────────────────

function parseTestTypes(raw?: string): TestType[] | undefined {
  if (!raw) return undefined;
  const valid: TestType[] = [
    "unit",
    "integration",
    "api",
    "e2e-browser",
    "e2e-mobile",
    "e2e-desktop",
    "snapshot",
    "performance",
  ];
  return raw
    .split(",")
    .map((t) => t.trim() as TestType)
    .filter((t) => valid.includes(t));
}

function resolveProjectRoot(pathArg?: string): string {
  return resolve(pathArg ?? process.cwd());
}

function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function parseDiffSource(opts: Record<string, unknown>): DiffSource | undefined {
  if (opts["staged"]) return { mode: "staged" };
  if (opts["base"]) return { mode: "base", branch: opts["base"] as string };
  if (opts["commit"]) return { mode: "commit", ref: opts["commit"] as string };
  if (opts["pr"] !== undefined && opts["pr"] !== false) {
    const num = opts["pr"] === true ? undefined : Number(opts["pr"]);
    return { mode: "pr", number: num };
  }
  if (opts["files"]) return { mode: "files", patterns: (opts["files"] as string).split(",").map((p) => p.trim()) };
  return undefined;
}

function createEventHandler(verbose: boolean): (event: CoveritEvent) => void {
  return (event: CoveritEvent) => {
    switch (event.type) {
      case "analysis:start":
        logger.info(`Analyzing ${event.data.files} changed files...`);
        break;
      case "analysis:complete":
        logger.success(
          `Strategy ready: ${event.data.strategy.plans.length} test plans`,
        );
        break;
      case "generation:start":
        if (verbose) {
          logger.info(`Generating: ${event.data.plan.description}`);
        }
        break;
      case "generation:complete": {
        const count = event.data.result.tests.length;
        logger.success(`Generated ${count} test file(s)`);
        break;
      }
      case "execution:start":
        if (verbose) {
          logger.info(
            `Running: ${event.data.plan.description} [${event.data.environment}]`,
          );
        }
        break;
      case "execution:complete": {
        const r = event.data.result;
        const status =
          r.status === "passed"
            ? chalk.green("PASSED")
            : chalk.red(r.status.toUpperCase());
        logger.info(
          `${status} — ${r.passed}/${r.totalTests} passed (${r.duration}ms)`,
        );
        break;
      }
      case "report:complete": {
        const runId = event.data.report.runId;
        logger.success(runId
          ? `Report saved to .coverit/runs/${runId}/report.json`
          : "Report saved");
        break;
      }
      case "error":
        logger.error(event.data.message);
        break;
    }
  };
}

// ─── CLI Program ─────────────────────────────────────────────

const program = new Command();

program
  .name("coverit")
  .version(VERSION)
  .description("AI-powered test generation and execution")
  .option("--type <types>", "Comma-separated test types (unit,api,e2e-browser,...)")
  .option("--env <env>", "Execution environment (local|cloud-sandbox)", "local")
  .option("--coverage", "Collect coverage data", false)
  .option("--dry-run", "Analyze and plan without generating or executing", false)
  .option("--verbose", "Show detailed progress output", false)
  .option("--base <branch>", "Diff against a specific base branch")
  .option("--commit <ref>", "Diff for a specific commit or range (e.g. HEAD~1, abc..def)")
  .option("--pr [number]", "Diff for a pull request (auto-detects base branch)")
  .option("--files <glob>", "Target specific files by glob pattern")
  .option("--staged", "Only analyze staged changes")
  .option("--plan-ids <ids>", "Comma-separated plan IDs to execute (from scan output)")
  .hook("preAction", (_thisCommand, actionCommand) => {
    // Don't print banner for MCP mode — it corrupts stdio transport
    if (actionCommand.name() !== "mcp") {
      console.log(BANNER);
    }
  });

// ─── scan ────────────────────────────────────────────────────

program
  .command("scan")
  .argument("[path]", "Project root path", ".")
  .description("Analyze codebase and display test strategy")
  .action(async (pathArg: string) => {
    const projectRoot = resolveProjectRoot(pathArg);
    const opts = program.opts();
    const spinner = ora("Scanning project...").start();

    try {
      if (!(await isGitRepo(projectRoot))) {
        spinner.warn("Not a git repository — analysis will be limited");
      }

      const projectInfo = await detectProjectInfo(projectRoot);
      spinner.text = "Building test strategy...";

      const config: CoveritConfig = {
        projectRoot,
        diffSource: parseDiffSource(opts),
        testTypes: parseTestTypes(opts["type"] as string | undefined),
        analyzeOnly: true,
      };

      const report = await orchestrate(config, createEventHandler(opts["verbose"] as boolean));
      spinner.stop();

      // Display results
      console.log(chalk.bold("\n  Project Info"));
      logger.table({
        Name: projectInfo.name,
        Framework: projectInfo.framework,
        "Test Framework": projectInfo.testFramework,
        "Package Manager": projectInfo.packageManager,
        Language: projectInfo.language,
        "Existing Tests": projectInfo.hasExistingTests ? "Yes" : "No",
      });

      console.log(chalk.bold("\n  Test Plans"));
      for (const plan of report.strategy.plans) {
        const priority =
          plan.priority === "critical"
            ? chalk.red(plan.priority)
            : plan.priority === "high"
              ? chalk.yellow(plan.priority)
              : chalk.gray(plan.priority);
        console.log(
          `  ${chalk.white(plan.type.padEnd(14))} ${priority.padEnd(20)} ${plan.description} (${chalk.cyan(`~${plan.estimatedTests} tests`)})`,
        );
      }

      console.log(
        chalk.bold(
          `\n  Total estimated tests: ${chalk.cyan(String(report.strategy.plans.reduce((s, p) => s + p.estimatedTests, 0)))}`,
        ),
      );
      console.log(
        chalk.bold(
          `  Execution phases: ${chalk.cyan(String(report.strategy.executionOrder.length))}`,
        ),
      );
    } catch (err) {
      spinner.fail("Scan failed");
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── generate ────────────────────────────────────────────────

program
  .command("generate")
  .argument("[path]", "Project root path", ".")
  .description("Generate test files")
  .action(async (pathArg: string) => {
    const projectRoot = resolveProjectRoot(pathArg);
    const opts = program.opts();
    const spinner = ora("Analyzing and generating tests...").start();

    try {
      const config: CoveritConfig = {
        projectRoot,
        diffSource: parseDiffSource(opts),
        testTypes: parseTestTypes(opts["type"] as string | undefined),
        generateOnly: true,
      };

      const report = await orchestrate(
        config,
        createEventHandler(opts["verbose"] as boolean),
      );
      spinner.stop();

      console.log(chalk.bold("\n  Generated Tests"));
      for (const result of report.results) {
        const icon = result.status === "skipped" ? chalk.yellow("○") : chalk.green("●");
        console.log(
          `  ${icon} Plan ${result.planId}: ${result.totalTests} test(s)`,
        );
      }

      logger.success(
        `\nTest files written colocated next to source files`,
      );
    } catch (err) {
      spinner.fail("Generation failed");
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── run ─────────────────────────────────────────────────────

program
  .command("run")
  .argument("[path]", "Project root path", ".")
  .description("Full pipeline: analyze, generate, run, and report")
  .action(async (pathArg: string) => {
    const projectRoot = resolveProjectRoot(pathArg);
    const opts = program.opts();
    const spinner = ora("Starting full pipeline...").start();

    try {
      const planIdsRaw = opts["planIds"] as string | undefined;
      const config: CoveritConfig = {
        projectRoot,
        diffSource: parseDiffSource(opts),
        testTypes: parseTestTypes(opts["type"] as string | undefined),
        planIds: planIdsRaw ? planIdsRaw.split(",").map((id) => id.trim()) : undefined,
        environment: (opts["env"] as CoveritConfig["environment"]) ?? "local",
        coverageThreshold: opts["coverage"] ? 0 : undefined,
      };

      spinner.text = "Analyzing...";

      const report = await orchestrate(config, (event) => {
        // Update spinner text based on pipeline progress
        switch (event.type) {
          case "analysis:start":
            spinner.text = `Analyzing ${event.data.files} files...`;
            break;
          case "analysis:complete":
            spinner.text = "Generating tests...";
            break;
          case "execution:start":
            spinner.text = `Running: ${event.data.plan.description}`;
            break;
          case "execution:complete":
            spinner.text = "Processing results...";
            break;
          case "report:complete":
            spinner.stop();
            break;
          default:
            break;
        }
        // Also forward to standard handler for verbose output
        if (opts["verbose"]) {
          createEventHandler(true)(event);
        }
      });

      spinner.stop();

      // Display summary
      console.log(chalk.bold("\n  Results Summary"));
      const s = report.summary;
      const statusColor =
        s.status === "all-passed"
          ? chalk.green
          : s.status === "has-failures"
            ? chalk.red
            : chalk.yellow;

      logger.table({
        Status: statusColor(s.status),
        "Total Tests": s.totalTests,
        Passed: chalk.green(String(s.passed)),
        Failed: s.failed > 0 ? chalk.red(String(s.failed)) : String(s.failed),
        Skipped: String(s.skipped),
        Errors: s.errorCount > 0 ? chalk.red(String(s.errorCount)) : String(s.errorCount),
        Duration: `${report.duration}ms`,
      });

      if (s.coverage) {
        console.log(chalk.bold("\n  Coverage"));
        logger.table({
          Lines: `${s.coverage.lines.percentage.toFixed(1)}%`,
          Branches: `${s.coverage.branches.percentage.toFixed(1)}%`,
          Functions: `${s.coverage.functions.percentage.toFixed(1)}%`,
          Statements: `${s.coverage.statements.percentage.toFixed(1)}%`,
        });
      }

      // Non-zero exit if failures
      if (s.status !== "all-passed") {
        process.exit(1);
      }
    } catch (err) {
      spinner.fail("Pipeline failed");
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── report ──────────────────────────────────────────────────

program
  .command("report")
  .description("Show the last saved report")
  .action(async () => {
    const projectRoot = process.cwd();

    try {
      const runId = await resolveRunId(projectRoot, {});
      const runDir = getRunDir(projectRoot, runId);
      const reportPath = join(runDir, "report.json");

      const raw = await readFile(reportPath, "utf-8");
      const report = JSON.parse(raw) as {
        runId?: string;
        summary: {
          status: string;
          totalTests: number;
          passed: number;
          failed: number;
          skipped: number;
          errorCount: number;
        };
        duration: number;
        timestamp: string;
      };

      console.log(chalk.bold("\n  Report"));
      console.log(chalk.gray(`  Run: ${runId}`));
      console.log(chalk.gray(`  ${report.timestamp}\n`));

      const s = report.summary;
      logger.table({
        Status: s.status,
        "Total Tests": s.totalTests,
        Passed: s.passed,
        Failed: s.failed,
        Skipped: s.skipped,
        Errors: s.errorCount,
        Duration: `${report.duration}ms`,
      });
    } catch {
      logger.warn(
        "No report found. Run `coverit run` to generate one.",
      );
    }
  });

// ─── runs ───────────────────────────────────────────────────

program
  .command("runs")
  .argument("[path]", "Project root path", ".")
  .option("--scope <scope>", "Filter by scope (e.g. pr-99, staged)")
  .description("List all coverit runs")
  .action(async (pathArg: string, cmdOpts: { scope?: string }) => {
    const projectRoot = resolveProjectRoot(pathArg);

    try {
      const runs = await listRuns(projectRoot, cmdOpts.scope);

      if (runs.length === 0) {
        logger.warn("No coverit runs found. Run `coverit run` to create one.");
        return;
      }

      console.log(chalk.bold("\n  Coverit Runs\n"));
      console.log(
        chalk.gray(
          "  " +
            "Run ID".padEnd(32) +
            "Scope".padEnd(12) +
            "Status".padEnd(12) +
            "Plans".padEnd(8) +
            "Tests".padEnd(12) +
            "Created",
        ),
      );

      for (const run of runs) {
        const tests = run.summary
          ? `${run.summary.passed}/${run.summary.totalTests}`
          : "-";
        const statusColor =
          run.status === "completed"
            ? chalk.green
            : run.status === "failed"
              ? chalk.red
              : run.status === "running"
                ? chalk.yellow
                : chalk.gray;
        const age = formatRelativeTime(run.createdAt);

        console.log(
          "  " +
            chalk.white(run.runId.padEnd(32)) +
            run.scope.padEnd(12) +
            statusColor(run.status.padEnd(12)) +
            String(run.planCount).padEnd(8) +
            tests.padEnd(12) +
            chalk.gray(age),
        );
      }
      console.log();
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── status ─────────────────────────────────────────────────

program
  .command("status")
  .argument("[path]", "Project root path", ".")
  .option("--run <runId>", "Run ID to inspect")
  .option("--pr <number>", "Show latest run for a specific PR")
  .description("Show details for a specific coverit run")
  .action(async (pathArg: string, cmdOpts: { run?: string; pr?: string }) => {
    const projectRoot = resolveProjectRoot(pathArg);

    try {
      let runId: string;
      if (cmdOpts.run) {
        runId = cmdOpts.run;
      } else if (cmdOpts.pr) {
        const runs = await listRuns(projectRoot, `pr-${cmdOpts.pr}`);
        if (runs.length === 0) {
          logger.warn(`No runs found for PR #${cmdOpts.pr}`);
          return;
        }
        runId = runs[0]!.runId;
      } else {
        runId = await resolveRunId(projectRoot, {});
      }
      const { meta, plans } = await getRunStatus(projectRoot, runId);

      console.log(chalk.bold("\n  Run Details\n"));
      logger.table({
        "Run ID": meta.runId,
        Scope: meta.scope,
        Status: meta.status,
        Created: meta.createdAt,
        Completed: meta.completedAt ?? "in progress",
        Plans: meta.planCount,
      });

      if (meta.summary) {
        const s = meta.summary;
        console.log(chalk.bold("\n  Summary\n"));
        logger.table({
          "Total Tests": s.totalTests,
          Passed: chalk.green(String(s.passed)),
          Failed: s.failed > 0 ? chalk.red(String(s.failed)) : String(s.failed),
          Skipped: String(s.skipped),
          Errors: s.errorCount > 0 ? chalk.red(String(s.errorCount)) : String(s.errorCount),
          Duration: `${s.duration}ms`,
        });
      }

      if (plans.length > 0) {
        console.log(chalk.bold("\n  Per-Plan Breakdown\n"));
        console.log(
          chalk.gray(
            "  " +
              "Plan ID".padEnd(16) +
              "Status".padEnd(12) +
              "Tests".padEnd(10) +
              "Duration".padEnd(10) +
              "Description",
          ),
        );

        for (const p of plans) {
          const tests =
            p.passed !== undefined ? `${p.passed}/${(p.passed ?? 0) + (p.failed ?? 0)}` : "-";
          const dur = p.duration !== undefined ? `${(p.duration / 1000).toFixed(1)}s` : "-";
          const statusColor =
            p.status === "passed"
              ? chalk.green
              : p.status === "failed"
                ? chalk.red
                : p.status === "error"
                  ? chalk.red
                  : chalk.gray;
          console.log(
            "  " +
              chalk.white(p.planId.padEnd(16)) +
              statusColor(p.status.padEnd(12)) +
              tests.padEnd(10) +
              dur.padEnd(10) +
              chalk.gray(p.description),
          );
        }
        console.log();
      }
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── fix ────────────────────────────────────────────────────

program
  .command("fix")
  .argument("[path]", "Project root path", ".")
  .option("--run <runId>", "Target a specific run ID (defaults to latest)")
  .option("--pr <number>", "Target the latest run for a specific PR")
  .option("--plan-ids <ids>", "Comma-separated plan IDs to fix (defaults to all failed)")
  .option("--retries <n>", "Max fix attempts per plan (default: 2)")
  .description("Fix failing tests from the last coverit run using AI refinement")
  .action(async (pathArg: string, cmdOpts: { run?: string; pr?: string; planIds?: string; retries?: string }) => {
    const projectRoot = resolveProjectRoot(pathArg);
    const opts = program.opts();
    const spinner = ora("Fixing failing tests...").start();

    try {
      // Resolve run ID: explicit --run, or --pr lookup, or latest
      let resolvedRunId = cmdOpts.run;
      if (!resolvedRunId && cmdOpts.pr) {
        const runs = await listRuns(projectRoot, `pr-${cmdOpts.pr}`);
        if (runs.length === 0) {
          spinner.fail(`No runs found for PR #${cmdOpts.pr}`);
          process.exit(1);
        }
        resolvedRunId = runs[0]!.runId;
      }

      const planIds = cmdOpts.planIds
        ? cmdOpts.planIds.split(",").map((id) => id.trim())
        : undefined;
      const maxRetries = cmdOpts.retries ? Number(cmdOpts.retries) : undefined;

      const report = await fixFailingTests(
        {
          projectRoot,
          runId: resolvedRunId,
          planIds,
          maxRetries,
        },
        (event) => {
          if (opts["verbose"]) {
            createEventHandler(true)(event);
          }
        },
      );

      spinner.stop();

      // Display summary
      console.log(chalk.bold("\n  Fix Results"));
      const s = report.summary;
      const statusColor =
        s.status === "all-passed"
          ? chalk.green
          : s.status === "has-failures"
            ? chalk.red
            : chalk.yellow;

      logger.table({
        "Run ID": report.runId ?? "-",
        Status: statusColor(s.status),
        "Total Tests": s.totalTests,
        Passed: chalk.green(String(s.passed)),
        Failed: s.failed > 0 ? chalk.red(String(s.failed)) : String(s.failed),
        Errors: s.errorCount > 0 ? chalk.red(String(s.errorCount)) : String(s.errorCount),
        Duration: `${report.duration}ms`,
      });

      if (s.status !== "all-passed") {
        process.exit(1);
      }
    } catch (err) {
      spinner.fail("Fix failed");
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── clear ──────────────────────────────────────────────────

program
  .command("clear")
  .argument("[path]", "Project root path", ".")
  .option("--run <runId>", "Delete a specific run by ID")
  .option("--scope <scope>", "Delete all runs matching scope (e.g. pr-99, staged)")
  .option("--all", "Delete all runs")
  .option("--clean", "Also delete generated test files from the project")
  .description("Delete coverit runs and optionally clean up generated test files")
  .action(async (pathArg: string, cmdOpts: { run?: string; scope?: string; all?: boolean; clean?: boolean }) => {
    const projectRoot = resolveProjectRoot(pathArg);

    try {
      // Default to --all when no targeting flag is given (matches plugin behavior)
      const useAll = cmdOpts.all || (!cmdOpts.run && !cmdOpts.scope);

      let deletedCount = 0;
      let testFiles: string[] = [];

      if (cmdOpts.run) {
        const result = await deleteRun(projectRoot, cmdOpts.run);
        deletedCount = 1;
        testFiles = result.testFiles;
      } else if (cmdOpts.scope) {
        const result = await clearRuns(projectRoot, cmdOpts.scope);
        deletedCount = result.deletedCount;
        testFiles = result.testFiles;
      } else if (useAll) {
        const result = await clearRuns(projectRoot);
        deletedCount = result.deletedCount;
        testFiles = result.testFiles;
      }

      // Optionally delete generated test files
      let cleanedFiles = 0;
      if (cmdOpts.clean && testFiles.length > 0) {
        const { existsSync } = await import("node:fs");
        const { unlink } = await import("node:fs/promises");
        for (const tf of testFiles) {
          const absPath = tf.startsWith("/") ? tf : join(projectRoot, tf);
          if (existsSync(absPath)) {
            try {
              await unlink(absPath);
              cleanedFiles++;
            } catch {
              // File may be locked or already deleted
            }
          }
        }
      }

      console.log(chalk.bold("\n  Clear Results"));
      logger.table({
        "Runs Deleted": deletedCount,
        "Test Files Found": testFiles.length,
        "Test Files Deleted": cleanedFiles,
      });

      if (deletedCount === 0) {
        logger.warn("No runs matched the specified criteria.");
      } else {
        logger.success(`Deleted ${deletedCount} run(s)`);
      }
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── recheck ────────────────────────────────────────────────

program
  .command("recheck")
  .argument("[path]", "Project root path", ".")
  .option("--run <runId>", "Target a specific run ID (defaults to latest)")
  .option("--plan-ids <ids>", "Comma-separated plan IDs to recheck (defaults to all plans with test files)")
  .description("Re-run existing test files and update status (no AI refinement)")
  .action(async (pathArg: string, cmdOpts: { run?: string; planIds?: string }) => {
    const projectRoot = resolveProjectRoot(pathArg);
    const opts = program.opts();
    const spinner = ora("Rechecking tests...").start();

    try {
      const planIds = cmdOpts.planIds
        ? cmdOpts.planIds.split(",").map((id) => id.trim())
        : undefined;

      const report = await recheckTests(
        {
          projectRoot,
          runId: cmdOpts.run,
          planIds,
        },
        (event) => {
          if (opts["verbose"]) {
            createEventHandler(true)(event);
          }
        },
      );

      spinner.stop();

      // Display summary
      console.log(chalk.bold("\n  Recheck Results"));
      const s = report.summary;
      const statusColor =
        s.status === "all-passed"
          ? chalk.green
          : s.status === "has-failures"
            ? chalk.red
            : chalk.yellow;

      logger.table({
        "Run ID": report.runId ?? "-",
        Status: statusColor(s.status),
        "Total Tests": s.totalTests,
        Passed: chalk.green(String(s.passed)),
        Failed: s.failed > 0 ? chalk.red(String(s.failed)) : String(s.failed),
        Errors: s.errorCount > 0 ? chalk.red(String(s.errorCount)) : String(s.errorCount),
        Duration: `${report.duration}ms`,
      });

      if (s.status !== "all-passed") {
        process.exit(1);
      }
    } catch (err) {
      spinner.fail("Recheck failed");
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── mcp ────────────────────────────────────────────────────

program
  .command("mcp")
  .description("Start coverit as an MCP server (stdio transport)")
  .action(async () => {
    // Dynamically import the MCP server — it self-starts on import
    await import("../mcp/server.js");
  });

program.parse();
