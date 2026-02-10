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
import { orchestrate } from "../agents/orchestrator.js";
import { detectProjectInfo } from "../utils/framework-detector.js";
import { isGitRepo } from "../utils/git.js";
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
      case "report:complete":
        logger.success("Report saved to .coverit/last-report.json");
        break;
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
  .hook("preAction", () => {
    console.log(BANNER);
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
        `\nFiles written to .coverit/generated/`,
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
      const config: CoveritConfig = {
        projectRoot,
        diffSource: parseDiffSource(opts),
        testTypes: parseTestTypes(opts["type"] as string | undefined),
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
    const reportPath = join(process.cwd(), ".coverit", "last-report.json");

    try {
      const raw = await readFile(reportPath, "utf-8");
      const report = JSON.parse(raw) as {
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

      console.log(chalk.bold("\n  Last Report"));
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

program.parse();
