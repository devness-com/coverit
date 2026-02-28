#!/usr/bin/env node

/**
 * Coverit — CLI
 *
 * 4-command architecture:
 *   coverit scan [path]    — AI explores codebase → creates coverit.json
 *   coverit cover [path]   — AI generates tests from gaps → updates coverit.json
 *   coverit run [path]     — Run existing tests, fix failures, update coverit.json
 *   coverit status [path]  — Shows dashboard from coverit.json
 *   coverit clear [path]   — Deletes coverit.json and .coverit/
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { resolve } from "node:path";
import { scanCodebase } from "../scale/analyzer.js";
import { readManifest, writeManifest } from "../scale/writer.js";
import { cover } from "../cover/pipeline.js";
import { runTests } from "../run/pipeline.js";
import { renderDashboard } from "../measure/dashboard.js";
import { logger } from "../utils/logger.js";

const VERSION = "1.0.0";
const BANNER = chalk.bold.cyan(`
  coverit v${VERSION}
  Your code, covered.
`);

function resolveProjectRoot(pathArg?: string): string {
  return resolve(pathArg ?? process.cwd());
}

// ─── CLI Program ─────────────────────────────────────────────

const program = new Command();

program
  .name("coverit")
  .version(VERSION)
  .description("AI-powered test quality platform")
  .hook("preAction", (_thisCommand, actionCommand) => {
    if (actionCommand.name() !== "mcp") {
      console.log(BANNER);
    }
  });

// ─── scan ─────────────────────────────────────────────────────

program
  .command("scan")
  .argument("[path]", "Project root path", ".")
  .description("AI scans and analyzes codebase → creates coverit.json quality manifest")
  .action(async (pathArg: string) => {
    const projectRoot = resolveProjectRoot(pathArg);
    const spinner = ora("Scanning and analyzing codebase with AI...").start();

    try {
      const manifest = await scanCodebase(projectRoot);

      spinner.text = "Writing coverit.json...";
      await writeManifest(projectRoot, manifest);

      spinner.succeed(
        `Scanned and analyzed ${manifest.modules.length} modules (${manifest.project.sourceFiles} files, ${manifest.project.sourceLines} lines)`,
      );

      renderDashboard(manifest);

      logger.success("coverit.json written to project root");
      logger.info("Next: Run `coverit cover` to generate tests and improve your score.");
    } catch (err) {
      spinner.fail("Scan failed");
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── cover ──────────────────────────────────────────────────

program
  .command("cover")
  .argument("[path]", "Project root path", ".")
  .option("--modules <paths>", "Only cover specific modules (comma-separated)")
  .description("AI generates tests from coverit.json gaps, runs them, and updates the score")
  .action(async (pathArg: string, cmdOpts: { modules?: string }) => {
    const projectRoot = resolveProjectRoot(pathArg);
    const spinner = ora("Reading coverit.json and generating tests...").start();

    try {
      const modules = cmdOpts.modules
        ? cmdOpts.modules.split(",").map((m) => m.trim())
        : undefined;

      const result = await cover({
        projectRoot,
        modules,
      });

      spinner.stop();

      console.log(chalk.bold("\n  Cover Results\n"));

      const delta = result.scoreAfter - result.scoreBefore;
      const deltaStr =
        delta > 0
          ? chalk.green(`+${delta}`)
          : delta < 0
            ? chalk.red(String(delta))
            : chalk.gray("±0");

      logger.table({
        "Score": `${result.scoreBefore}/100 → ${result.scoreAfter}/100 (${deltaStr})`,
        "Modules Processed": result.modulesProcessed,
        "Tests Generated": result.testsGenerated,
        "Passed": chalk.green(String(result.testsPassed)),
        "Failed": result.testsFailed > 0 ? chalk.red(String(result.testsFailed)) : String(result.testsFailed),
      });

      if (delta > 0) {
        logger.success(`Score improved by ${delta} points.`);
      }
      if (result.testsFailed > 0) {
        logger.warn("Some tests still failing. Run `coverit cover` again to retry.");
      }
    } catch (err) {
      spinner.fail("Cover failed");
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── run ────────────────────────────────────────────────────

program
  .command("run")
  .argument("[path]", "Project root path", ".")
  .option("--modules <paths>", "Only run tests for specific modules (comma-separated)")
  .description("Run existing tests, fix failures via AI, and update the score")
  .action(async (pathArg: string, cmdOpts: { modules?: string }) => {
    const projectRoot = resolveProjectRoot(pathArg);
    const spinner = ora("Running tests and fixing failures...").start();

    try {
      const modules = cmdOpts.modules
        ? cmdOpts.modules.split(",").map((m) => m.trim())
        : undefined;

      const result = await runTests({
        projectRoot,
        modules,
      });

      spinner.stop();

      console.log(chalk.bold("\n  Run Results\n"));

      const delta = result.scoreAfter - result.scoreBefore;
      const deltaStr =
        delta > 0
          ? chalk.green(`+${delta}`)
          : delta < 0
            ? chalk.red(String(delta))
            : chalk.gray("±0");

      logger.table({
        "Score": `${result.scoreBefore}/100 → ${result.scoreAfter}/100 (${deltaStr})`,
        "Total Tests": result.totalTests,
        "Passed": chalk.green(String(result.passed)),
        "Failed": result.failed > 0 ? chalk.red(String(result.failed)) : String(result.failed),
        "Fixed by AI": result.fixed > 0 ? chalk.green(String(result.fixed)) : String(result.fixed),
      });

      if (delta > 0) {
        logger.success(`Score improved by ${delta} points.`);
      }
      if (result.fixed > 0) {
        logger.info(`AI fixed ${result.fixed} test(s).`);
      }
      if (result.failed > 0) {
        logger.warn("Some tests still failing. Run `coverit run` again to retry.");
      }
    } catch (err) {
      spinner.fail("Run failed");
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── status ─────────────────────────────────────────────────

program
  .command("status")
  .argument("[path]", "Project root path", ".")
  .description("Show quality dashboard from coverit.json (instant, no AI)")
  .action(async (pathArg: string) => {
    const projectRoot = resolveProjectRoot(pathArg);

    try {
      const manifest = await readManifest(projectRoot);
      if (!manifest) {
        logger.warn("No coverit.json found. Run `coverit scan` first to scan and analyze the codebase.");
        return;
      }

      renderDashboard(manifest);
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── clear ──────────────────────────────────────────────────

program
  .command("clear")
  .argument("[path]", "Project root path", ".")
  .option("--manifest-only", "Only delete coverit.json, keep .coverit/ directory")
  .description("Delete coverit.json and .coverit/ directory for a fresh start")
  .action(async (pathArg: string, cmdOpts: { manifestOnly?: boolean }) => {
    const projectRoot = resolveProjectRoot(pathArg);

    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const deleted: string[] = [];

      const manifestPath = path.join(projectRoot, "coverit.json");
      if (fs.existsSync(manifestPath)) {
        fs.unlinkSync(manifestPath);
        deleted.push("coverit.json");
      }

      if (!cmdOpts.manifestOnly) {
        const coveritDir = path.join(projectRoot, ".coverit");
        if (fs.existsSync(coveritDir)) {
          fs.rmSync(coveritDir, { recursive: true });
          deleted.push(".coverit/");
        }
      }

      if (deleted.length > 0) {
        logger.success(`Deleted: ${deleted.join(", ")}`);
      } else {
        logger.warn("Nothing to clear — no coverit.json or .coverit/ found.");
      }
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program.parse();
