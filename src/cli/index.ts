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
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scanCodebase } from "../scale/analyzer.js";
import { readManifest, writeManifest } from "../scale/writer.js";
import { cover } from "../cover/pipeline.js";
import { runTests } from "../run/pipeline.js";
import { renderDashboard } from "../measure/dashboard.js";
import {
  detectAllProviders,
  getProviderDisplayName,
} from "../ai/provider-factory.js";
import type { AIProvider, AIProgressEvent } from "../ai/types.js";
import { logger } from "../utils/logger.js";
import { useaiStart, useaiEnd, type UseAISession, type CoveritCommand } from "../integrations/useai.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VERSION = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8")
).version;
const BANNER = chalk.bold.cyan(`
  coverit v${VERSION}
  Your code, covered.
`);

function resolveProjectRoot(pathArg?: string): string {
  return resolve(pathArg ?? process.cwd());
}

/**
 * Prompt the user with a question and return their answer.
 */
function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (answer) => {
      rl.close();
      res(answer.trim());
    });
  });
}

/**
 * Detect available AI providers, show them to the user, and let them
 * confirm or choose which one to use.
 *
 * - If only one is found, show it and ask for confirmation
 * - If multiple are found, let the user pick
 * - If none are found, show setup instructions and exit
 * - Non-TTY (piped/CI) or -y flag: auto-select best provider
 */
async function resolveProvider(autoYes: boolean): Promise<AIProvider> {
  const isInteractive = process.stdin.isTTY && !autoYes;

  const spinner = ora("  Detecting AI tools...").start();
  const providers = await detectAllProviders();
  spinner.stop();

  if (providers.length === 0) {
    console.log(chalk.red("\n  No AI tools found.\n"));
    console.log("  Install one of the following:\n");
    console.log("  1. Claude Code  — https://docs.anthropic.com/en/docs/claude-code");
    console.log("  2. Gemini CLI   — https://github.com/google-gemini/gemini-cli");
    console.log("  3. Codex CLI    — https://github.com/openai/codex");
    console.log("  4. Ollama       — https://ollama.com\n");
    console.log("  Or set ANTHROPIC_API_KEY or OPENAI_API_KEY.\n");
    process.exit(1);
  }

  // Non-interactive: auto-select first (best priority) provider
  if (!isInteractive) {
    const provider = providers[0]!;
    console.log(`  Using ${chalk.green(getProviderDisplayName(provider))}\n`);
    return provider;
  }

  // Single provider: show and confirm
  if (providers.length === 1) {
    const provider = providers[0]!;
    const displayName = getProviderDisplayName(provider);
    console.log(`\n  Found: ${chalk.green(displayName)}\n`);
    const answer = await prompt(`  Use ${displayName}? (Y/n) `);
    if (answer.toLowerCase() === "n") {
      console.log("\n  Aborted.\n");
      process.exit(0);
    }
    console.log();
    return provider;
  }

  // Multiple providers: let user choose
  console.log(`\n  Found ${providers.length} AI tools:\n`);
  providers.forEach((p, i) => {
    const name = getProviderDisplayName(p);
    const marker = i === 0 ? chalk.green(" (recommended)") : "";
    console.log(`    ${i + 1}. ${name}${marker}`);
  });
  console.log();

  const answer = await prompt(`  Which AI tool should coverit use? [1] `);
  const choice = answer === "" ? 0 : parseInt(answer, 10) - 1;

  if (isNaN(choice) || choice < 0 || choice >= providers.length) {
    console.log("\n  Invalid choice. Aborted.\n");
    process.exit(1);
  }

  const selected = providers[choice]!;
  console.log(`\n  Using ${chalk.green(getProviderDisplayName(selected))}\n`);
  return selected;
}

/**
 * Create a progress handler that updates an ora spinner with
 * real-time streaming events from the AI provider.
 *
 * Supports two modes:
 * - Single-line: ora spinner for sequential phases (e.g. Functionality)
 * - Multi-line: 4 parallel dimension lines when dimension_status events arrive
 *
 * Returns { handler, cleanup } — call cleanup() when done to stop the timer.
 */
function createProgressHandler(spinner: ReturnType<typeof ora>) {
  let phaseName = "";
  let phaseStep = 0;
  let phaseTotal = 0;
  let lastActivity = "";
  const startTime = Date.now();

  // Multi-line parallel state
  let parallel: ParallelProgress | null = null;

  function updateSpinner(): void {
    if (parallel) {
      parallel.render();
    } else {
      spinner.text = formatSpinnerText(phaseName, phaseStep, phaseTotal, startTime, lastActivity);
    }
  }

  // Tick elapsed time every second
  const timer = setInterval(updateSpinner, 1_000);

  const handler = (event: AIProgressEvent): void => {
    switch (event.type) {
      case "phase":
        phaseName = event.name;
        phaseStep = event.step;
        phaseTotal = event.total;
        lastActivity = "";
        updateSpinner();
        break;
      case "dimension_status": {
        if (!parallel) {
          // Switch from single-line spinner to multi-line mode
          spinner.stop();
          parallel = new ParallelProgress();
        }
        parallel.updateStatus(event.name, event.status, event.detail);
        parallel.render();
        break;
      }
      case "tool_use": {
        if (parallel) {
          // Route to correct dimension by parsing "DimensionName: filename" prefix
          const label = event.input ? shortenToFilename(event.input) : "";
          const toolStr = `${event.tool}${label ? ` ${label}` : ""}`;
          // Parse dimension name from prefix (e.g. "Security: auth.ts" → "Security")
          const colonIdx = event.input?.indexOf(": ") ?? -1;
          if (colonIdx > 0) {
            const dimName = event.input!.slice(0, colonIdx);
            const file = shortenToFilename(event.input!.slice(colonIdx + 2));
            parallel.updateActivity(dimName, `${event.tool} ${file}`);
          } else {
            parallel.updateActivity(event.input ?? "", toolStr);
          }
          parallel.render();
        } else {
          const label = event.input ? shortenToFilename(event.input) : "";
          lastActivity = `${event.tool}${label ? ` ${label}` : ""}`;
          updateSpinner();
        }
        break;
      }
      case "tool_result":
        break;
      case "text_delta":
        break;
      case "thinking":
        if (!phaseName && !parallel) {
          lastActivity = "Thinking...";
          updateSpinner();
        }
        break;
      case "model_detected":
        // Handled by createLazyUseAISession wrapper, not here
        break;
    }
  };

  const cleanup = (): void => {
    clearInterval(timer);
    if (parallel) {
      parallel.finalize();
      parallel = null;
    }
  };

  return { handler, cleanup };
}

// ─── Multi-Line Parallel Progress ────────────────────────────

/** Dimension step numbers for display */
const DIMENSION_STEPS: Record<string, number> = {
  Security: 2,
  Stability: 3,
  Conformance: 4,
  Regression: 5,
};

const SPINNER_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface DimensionLine {
  activity: string;
  startTime: number;
  status: "pending" | "running" | "done" | "failed";
  detail?: string;
}

/**
 * Renders 4 parallel dimension progress lines using ANSI escape codes.
 * Each line independently shows its spinner, elapsed time, and current activity.
 */
class ParallelProgress {
  private lines = new Map<string, DimensionLine>();
  private linesWritten = 0;
  private spinnerFrame = 0;
  private lastRenderTime = 0;

  constructor() {}

  updateStatus(name: string, status: "running" | "done" | "failed", detail?: string): void {
    // On first call, pre-populate all 4 dimension lines so the line count
    // is fixed from the start (prevents ghost lines from cursor math mismatch)
    if (this.lines.size === 0) {
      const now = Date.now();
      for (const dimName of Object.keys(DIMENSION_STEPS)) {
        this.lines.set(dimName, {
          activity: "",
          startTime: now,
          status: "pending",
        });
      }
    }

    const existing = this.lines.get(name);
    if (existing) {
      if (existing.status === "pending" && status === "running") {
        existing.startTime = Date.now(); // Start the timer when actually running
      }
      existing.status = status;
      if (detail) existing.detail = detail;
    }
  }

  updateActivity(name: string, activity: string): void {
    const line = this.lines.get(name);
    if (line && line.status === "running") {
      line.activity = activity;
    }
  }

  render(): void {
    // Throttle renders to avoid flicker (max ~15fps)
    const now = Date.now();
    if (now - this.lastRenderTime < 67) return;
    this.lastRenderTime = now;

    this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_CHARS.length;

    // Move cursor up to overwrite previous render
    if (this.linesWritten > 0) {
      process.stderr.write(`\x1B[${this.linesWritten}A`);
    }

    const entries = [...this.lines.entries()];
    const output = entries.map(([name, state]) => {
      const step = DIMENSION_STEPS[name] ?? 0;

      if (state.status === "pending") {
        return `\x1B[2K  ${chalk.dim("○")} ${chalk.dim(`[${step}/5]`)} ${chalk.dim(name.padEnd(12))} ${chalk.dim("(waiting)")}`;
      }

      const elapsed = formatElapsed(now - state.startTime);
      let prefix: string;
      if (state.status === "done") {
        prefix = chalk.green("✓");
      } else if (state.status === "failed") {
        prefix = chalk.red("✗");
      } else {
        prefix = chalk.cyan(SPINNER_CHARS[this.spinnerFrame]!);
      }
      const activity = state.status !== "running" && state.detail
        ? state.detail
        : state.activity;
      const activityStr = activity ? ` · ${activity}` : "";
      return `\x1B[2K  ${prefix} ${chalk.dim(`[${step}/5]`)} ${name.padEnd(12)} ${chalk.dim(`(${elapsed})`)}${chalk.dim(activityStr)}`;
    }).join("\n");

    process.stderr.write(output + "\n");
    this.linesWritten = entries.length;
  }

  /** Clean up the multi-line display — move cursor below the last line */
  finalize(): void {
    // Final render with completed states
    this.lastRenderTime = 0; // Force render
    this.render();
  }
}

/** Format the spinner line: [step/total] Phase (elapsed) · activity */
function formatSpinnerText(
  phase: string,
  step: number,
  total: number,
  startTime: number,
  activity: string,
): string {
  const elapsed = formatElapsed(Date.now() - startTime);
  const parts: string[] = [];
  if (step > 0 && total > 0) parts.push(`[${step}/${total}]`);
  if (phase) parts.push(phase);
  parts.push(`(${elapsed})`);
  if (activity) parts.push(`· ${activity}`);
  return chalk.dim(`  ${parts.join(" ")}`);
}

/** Format milliseconds as "1m 23s" or "45s" */
function formatElapsed(ms: number): string {
  const totalSecs = Math.floor(ms / 1_000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins > 0) return `${mins}m ${secs.toString().padStart(2, "0")}s`;
  return `${secs}s`;
}

/** Extract just the filename from a path (last segment) */
function shortenToFilename(input: string): string {
  // Handle glob patterns — keep as-is if short enough
  if (input.includes("*")) return input.length <= 40 ? input : "..." + input.slice(-37);
  // Extract last path segment
  const parts = input.split("/");
  return parts[parts.length - 1] ?? input;
}

// ─── Lazy UseAI Session ──────────────────────────────────────

/**
 * Wraps a progress handler to detect the AI model from streaming events
 * and start a UseAI session as soon as the model is known.
 *
 * For providers with a known model (SDK-based like anthropic/openai/ollama),
 * the session starts immediately. For CLI providers (claude-cli, gemini-cli),
 * the model is only available after the first AI response arrives via a
 * `model_detected` progress event.
 */
function createLazyUseAISession(
  command: CoveritCommand,
  projectRoot: string,
  provider: AIProvider,
  baseHandler: (event: AIProgressEvent) => void,
): {
  handler: (event: AIProgressEvent) => void;
  getSession: () => Promise<UseAISession | null>;
} {
  let session: UseAISession | null = null;
  let sessionStarted = false;
  let sessionPromise: Promise<UseAISession | null> | null = null;

  // If provider already knows its model, start immediately
  if (provider.model) {
    sessionPromise = useaiStart(command, projectRoot, { provider: provider.name, model: provider.model });
    sessionPromise.then((s) => { session = s; }).catch(() => {});
    sessionStarted = true;
  }

  const handler = (event: AIProgressEvent): void => {
    // Detect model from streaming and start UseAI lazily
    if (event.type === "model_detected" && !sessionStarted) {
      sessionStarted = true;
      sessionPromise = useaiStart(command, projectRoot, { provider: provider.name, model: event.model });
      sessionPromise.then((s) => { session = s; }).catch(() => {});
    }
    baseHandler(event);
  };

  const getSession = async (): Promise<UseAISession | null> => {
    // Wait for any pending session start
    if (sessionPromise) {
      session = await sessionPromise;
    }
    // Fallback: if no model was detected, start with provider name
    if (!sessionStarted) {
      session = await useaiStart(command, projectRoot, { provider: provider.name });
    }
    return session;
  };

  return { handler, getSession };
}

// ─── CLI Program ─────────────────────────────────────────────

const program = new Command();

program
  .name("coverit")
  .version(VERSION)
  .description("AI-powered test quality platform")
  .option("-y, --yes", "Skip confirmation prompts (auto-select best AI tool)")
  .hook("preAction", (_thisCommand, actionCommand) => {
    if (actionCommand.name() !== "mcp") {
      console.log(BANNER);
    }
  });

// ─── scan ─────────────────────────────────────────────────────

program
  .command("scan")
  .argument("[path]", "Project root path", ".")
  .option("--timeout <seconds>", "Timeout per dimension in seconds (default: 900)")
  .description("AI scans and analyzes codebase → creates coverit.json quality manifest")
  .action(async (pathArg: string, cmdOpts: { timeout?: string }) => {
    const projectRoot = resolveProjectRoot(pathArg);
    const autoYes = program.opts().yes ?? false;
    const timeoutMs = cmdOpts.timeout ? parseInt(cmdOpts.timeout, 10) * 1000 : undefined;

    const provider = await resolveProvider(autoYes);
    const spinner = ora("Scanning and analyzing codebase with AI...").start();
    const progress = createProgressHandler(spinner);
    const lazySession = createLazyUseAISession("scan", projectRoot, provider, progress.handler);

    try {
      const manifest = await scanCodebase(projectRoot, {
        aiProvider: provider,
        onProgress: lazySession.handler,
        timeoutMs,
      });

      progress.cleanup();
      spinner.text = "Writing coverit.json...";
      await writeManifest(projectRoot, manifest);

      spinner.succeed(
        `Scanned and analyzed ${manifest.modules.length} modules (${manifest.project.sourceFiles} files, ${manifest.project.sourceLines} lines)`,
      );

      renderDashboard(manifest);

      const session = await lazySession.getSession();
      await useaiEnd(session, {
        modules: manifest.modules.length,
        score: manifest.score.overall,
        language: manifest.project.language,
      });

      logger.success("coverit.json written to project root");
      logger.info("Log saved to .coverit/scan.log");
      logger.info("Next: Run `coverit cover` to generate tests and improve your score.");
    } catch (err) {
      progress.cleanup();
      spinner.fail("Scan failed");
      logger.error(err instanceof Error ? err.message : String(err));
      logger.info("Check .coverit/scan.log for details.");
      const session = await lazySession.getSession();
      await useaiEnd(session, {});
      process.exit(1);
    }
  });

// ─── cover ──────────────────────────────────────────────────

program
  .command("cover")
  .argument("[path]", "Project root path", ".")
  .option("--modules <paths>", "Only cover specific modules (comma-separated)")
  .option("--parallel <count>", "Max modules to process in parallel (default: 3)")
  .option("--timeout <seconds>", "Timeout per module in seconds (default: 600)")
  .description("AI generates tests from coverit.json gaps, runs them, and updates the score")
  .action(async (pathArg: string, cmdOpts: { modules?: string; parallel?: string; timeout?: string }) => {
    const projectRoot = resolveProjectRoot(pathArg);
    const autoYes = program.opts().yes ?? false;

    const provider = await resolveProvider(autoYes);
    const spinner = ora("Reading coverit.json and generating tests...").start();
    const progress = createProgressHandler(spinner);
    const lazySession = createLazyUseAISession("cover", projectRoot, provider, progress.handler);

    try {
      const modules = cmdOpts.modules
        ? cmdOpts.modules.split(",").map((m) => m.trim())
        : undefined;
      const concurrency = cmdOpts.parallel ? parseInt(cmdOpts.parallel, 10) : undefined;
      const timeoutMs = cmdOpts.timeout ? parseInt(cmdOpts.timeout, 10) * 1000 : undefined;

      const result = await cover({
        projectRoot,
        modules,
        concurrency,
        timeoutMs,
        aiProvider: provider,
        onProgress: lazySession.handler,
      });

      progress.cleanup();
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

      const session = await lazySession.getSession();
      await useaiEnd(session, {
        scoreBefore: result.scoreBefore,
        scoreAfter: result.scoreAfter,
        testsGenerated: result.testsGenerated,
        testsPassed: result.testsPassed,
        testsFailed: result.testsFailed,
      });

      if (delta > 0) {
        logger.success(`Score improved by ${delta} points.`);
      }
      if (result.testsFailed > 0) {
        logger.warn("Some tests still failing. Run `coverit cover` again to retry.");
      }
    } catch (err) {
      progress.cleanup();
      spinner.fail("Cover failed");
      logger.error(err instanceof Error ? err.message : String(err));
      const session = await lazySession.getSession();
      await useaiEnd(session, {});
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
    const autoYes = program.opts().yes ?? false;

    const provider = await resolveProvider(autoYes);
    const spinner = ora("Running tests and fixing failures...").start();
    const progress = createProgressHandler(spinner);
    const lazySession = createLazyUseAISession("run", projectRoot, provider, progress.handler);

    try {
      const modules = cmdOpts.modules
        ? cmdOpts.modules.split(",").map((m) => m.trim())
        : undefined;

      const result = await runTests({
        projectRoot,
        modules,
        aiProvider: provider,
        onProgress: lazySession.handler,
      });

      progress.cleanup();
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

      const session = await lazySession.getSession();
      await useaiEnd(session, {
        scoreBefore: result.scoreBefore,
        scoreAfter: result.scoreAfter,
        totalTests: result.totalTests,
        passed: result.passed,
        failed: result.failed,
        fixed: result.fixed,
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
      progress.cleanup();
      spinner.fail("Run failed");
      logger.error(err instanceof Error ? err.message : String(err));
      const session = await lazySession.getSession();
      await useaiEnd(session, {});
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
