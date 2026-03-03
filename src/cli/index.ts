#!/usr/bin/env node

/**
 * Coverit — CLI
 *
 * 4-command architecture:
 *   coverit scan [path]    — AI explores codebase → creates coverit.json
 *   coverit cover [path]   — AI generates tests from gaps → updates coverit.json
 *   coverit fix [path]     — Fix failing tests via AI, update coverit.json
 *   coverit status [path]  — Shows dashboard from coverit.json
 *   coverit clear [path]   — Deletes coverit.json and .coverit/
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { select } from "@inquirer/prompts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scanCodebase, ALL_DIMENSIONS, type ScanDimension } from "../scale/analyzer.js";
import { readManifest, writeManifest } from "../scale/writer.js";
import { cover, type CoverDimension } from "../cover/pipeline.js";
import { fixTests } from "../fix/pipeline.js";
import { renderDashboard } from "../measure/dashboard.js";
import {
  detectAllProviders,
  getProviderDisplayName,
} from "../ai/provider-factory.js";
import type { AIProvider, AIProgressEvent } from "../ai/types.js";
import { logger, setLogInterceptor } from "../utils/logger.js";
import { registerCleanupHandlers } from "../utils/process-tracker.js";
import { useaiStart, useaiEnd, type UseAISession, type CoveritCommand, type UseAIEndUsage } from "../integrations/useai.js";
import { UsageTracker } from "../utils/usage-tracker.js";
import {
  readCoverSession,
  deleteCoverSession,
  readScanSession,
  deleteScanSession,
} from "../utils/session.js";

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
 * Detect available AI providers, show them to the user, and let them
 * confirm or choose which one to use.
 *
 * - If only one is found, auto-select it
 * - If multiple are found, show an interactive select prompt
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

  // Single provider or non-interactive: auto-select first (best priority) provider
  if (!isInteractive || providers.length === 1) {
    const provider = providers[0]!;
    console.log(`  Using ${chalk.green(getProviderDisplayName(provider))}\n`);
    return provider;
  }

  // Multiple providers: interactive select
  console.log();
  let selectedName: string;
  try {
    selectedName = await select({
      message: "Which AI tool should coverit use?",
      choices: providers.map((p, i) => ({
        name: getProviderDisplayName(p) + (i === 0 ? chalk.green(" (recommended)") : ""),
        value: p.name,
      })),
    });
  } catch {
    // User cancelled (Ctrl+C)
    console.log("\n  Aborted.\n");
    process.exit(0);
  }

  const selected = providers.find((p) => p.name === selectedName)!;
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

  // Register log interceptor so logger calls don't corrupt spinner/progress output.
  // For multi-line mode: clears progress, prints, re-renders.
  // For single-line mode: ora.clear() → print → ora.render().
  setLogInterceptor((fn) => {
    if (parallel) {
      parallel.log(fn);
    } else if (spinner.isSpinning) {
      spinner.clear();
      fn();
      spinner.render();
    } else {
      fn();
    }
  });

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
          parallel = new ParallelProgress(startTime);
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
      case "module_status":
        // Handled by createCoverProgressHandler, not here
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
    setLogInterceptor(null);
  };

  return { handler, cleanup };
}

// ─── Multi-Line Parallel Progress ────────────────────────────

/** Dimension step numbers for display */
const DIMENSION_STEPS: Record<string, number> = {
  Functionality: 1,
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
 * Renders parallel dimension progress lines using ANSI escape codes.
 * Each line independently shows its spinner, elapsed time, and current activity.
 * Lines are added dynamically as dimension_status events arrive, so only
 * requested dimensions appear (supports selective scanning via --dimensions).
 */
class ParallelProgress {
  private lines = new Map<string, DimensionLine>();
  private physicalRows = 0;
  private spinnerFrame = 0;
  private lastRenderTime = 0;
  private scanStartTime: number;

  constructor(scanStartTime: number) {
    this.scanStartTime = scanStartTime;
  }

  /** Log a message safely while multi-line progress is active.
   *  Clears the progress, prints the message, then re-renders. */
  log(fn: () => void): void {
    if (this.physicalRows > 0) {
      process.stderr.write(`\x1B[${this.physicalRows}A\x1B[0J`);
      this.physicalRows = 0;
    }
    fn();
    this.lastRenderTime = 0; // force re-render
    this.render();
  }

  updateStatus(name: string, status: "running" | "done" | "failed", detail?: string): void {
    if (!this.lines.has(name)) {
      this.lines.set(name, {
        activity: "",
        // Dimensions arriving already done (e.g. Functionality) backdate to
        // scan start so elapsed time reflects actual duration, not 0s.
        startTime: status === "done" || status === "failed" ? this.scanStartTime : Date.now(),
        status: "pending",
      });
    }

    const existing = this.lines.get(name)!;
    if (existing.status === "pending" && status === "running") {
      existing.startTime = Date.now();
    }
    existing.status = status;
    if (detail) existing.detail = detail;
  }

  updateActivity(name: string, activity: string): void {
    const line = this.lines.get(name);
    if (line && line.status === "running") {
      // Strip newlines — tool inputs (especially Bash) can be multi-line
      line.activity = activity.replace(/[\n\r]+/g, " ").trim();
    }
  }

  render(): void {
    // Throttle renders to avoid flicker (max ~15fps)
    const now = Date.now();
    if (now - this.lastRenderTime < 67) return;
    this.lastRenderTime = now;

    this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_CHARS.length;

    // Move cursor up to overwrite previous render, then clear to end of screen.
    // Uses physical row count (accounts for line wrapping) to avoid eating previous output.
    if (this.physicalRows > 0) {
      process.stderr.write(`\x1B[${this.physicalRows}A\x1B[0J`);
    }

    const columns = process.stderr.columns || 80;
    // Sort entries by their canonical dimension order for consistent display
    const entries = [...this.lines.entries()].sort((a, b) =>
      (DIMENSION_STEPS[a[0]] ?? 99) - (DIMENSION_STEPS[b[0]] ?? 99),
    );
    const total = entries.length;
    const outputLines = entries.map(([name, state], idx) => {
      const step = idx + 1;

      if (state.status === "pending") {
        return `  ${chalk.dim(`○ [${step}/${total}] ${name.padEnd(12)} (waiting)`)}`;
      }

      const elapsed = formatElapsed(now - state.startTime);
      let prefixChar: string;
      let prefixColored: string;
      if (state.status === "done") {
        prefixChar = "✓";
        prefixColored = chalk.green("✓");
      } else if (state.status === "failed") {
        prefixChar = "✗";
        prefixColored = chalk.red("✗");
      } else {
        prefixChar = SPINNER_CHARS[this.spinnerFrame]!;
        prefixColored = chalk.cyan(prefixChar);
      }
      const activity = state.status !== "running" && state.detail
        ? state.detail
        : state.activity;

      // Measure visible width of the fixed prefix to truncate activity correctly
      // Format: "  X [N/T] DimName       (Xm XXs)"
      const fixedLen = `  ${prefixChar} [${step}/${total}] ${name.padEnd(12)} (${elapsed})`.length;
      let activityStr = "";
      if (activity) {
        const maxLen = columns - fixedLen - 4; // 4 for " · " + margin
        if (maxLen > 5) {
          const truncated = activity.length > maxLen
            ? activity.slice(0, maxLen - 1) + "…"
            : activity;
          activityStr = ` · ${truncated}`;
        }
      }
      return `  ${prefixColored} ${chalk.dim(`[${step}/${total}]`)} ${name.padEnd(12)} ${chalk.dim(`(${elapsed})`)}${chalk.dim(activityStr)}`;
    });
    const output = outputLines.join("\n");

    process.stderr.write(output + "\n");

    // Count physical rows: each logical line may wrap across multiple terminal rows
    let rows = 0;
    for (const line of outputLines) {
      const visible = line.replace(/\x1B\[[0-9;]*m/g, "").length;
      rows += Math.max(1, Math.ceil(visible / columns));
    }
    this.physicalRows = rows;
  }

  /** Clean up the multi-line display — move cursor below the last line */
  finalize(): void {
    // Final render with completed states
    this.lastRenderTime = 0; // Force render
    this.render();
  }
}

// ─── Multi-Line Cover Progress ───────────────────────────────

interface CoverModuleLine {
  activity: string;
  startTime: number;
  status: "pending" | "running" | "done" | "failed" | "timed_out";
  dimension?: string;
  stats?: { testsWritten: number; testsPassed: number; testsFailed: number };
  detail?: string;
}

/**
 * Renders multi-line progress for the cover command.
 * Shows a header summary + per-module status lines.
 *
 * Format:
 *   Cover: 5/11 modules · 23 tests · 15m 32s
 *
 *   ✓ auth                    2m 14s ─ 5 tests, 5 passed
 *   ⠼ supplier-integration   14m 55s ─ Write booking-discount.spec.ts
 *   ○ analytics                       ─ waiting
 */
class CoverProgress {
  private modules = new Map<string, CoverModuleLine>();
  /** Insertion order for stable display */
  private moduleOrder: string[] = [];
  private physicalRows = 0;
  private spinnerFrame = 0;
  private lastRenderTime = 0;
  private startTime: number;
  /** Track dimension transitions for header rendering */
  private dimensionStatus = new Map<string, "running" | "done" | "failed">();

  constructor() {
    this.startTime = Date.now();
  }

  updateDimensionStatus(name: string, status: "running" | "done" | "failed"): void {
    this.dimensionStatus.set(name, status);
  }

  log(fn: () => void): void {
    if (this.physicalRows > 0) {
      process.stderr.write(`\x1B[${this.physicalRows}A\x1B[0J`);
      this.physicalRows = 0;
    }
    fn();
    this.lastRenderTime = 0;
    this.render();
  }

  updateModuleStatus(
    name: string,
    status: "pending" | "running" | "done" | "failed" | "timed_out",
    stats?: { testsWritten: number; testsPassed: number; testsFailed: number },
    dimension?: string,
    detail?: string,
  ): void {
    if (!this.modules.has(name)) {
      this.modules.set(name, { activity: "", startTime: Date.now(), status: "pending" });
      this.moduleOrder.push(name);
    }
    const line = this.modules.get(name)!;
    if (line.status === "pending" && status === "running") {
      line.startTime = Date.now();
    }
    line.status = status;
    if (stats) line.stats = stats;
    if (dimension) line.dimension = dimension;
    if (detail) line.detail = detail;
  }

  updateActivity(name: string, activity: string): void {
    const line = this.modules.get(name);
    if (line && line.status === "running") {
      // Strip newlines — tool inputs (especially Bash) can be multi-line
      line.activity = activity.replace(/[\n\r]+/g, " ").trim();
    }
  }

  render(): void {
    const now = Date.now();
    if (now - this.lastRenderTime < 67) return;
    this.lastRenderTime = now;

    this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_CHARS.length;

    if (this.physicalRows > 0) {
      process.stderr.write(`\x1B[${this.physicalRows}A\x1B[0J`);
    }

    const columns = process.stderr.columns || 80;
    const outputLines: string[] = [];

    // Header summary
    const total = this.modules.size;
    const doneCount = this.countByStatus("done");
    const failedCount = this.countByStatus("failed") + this.countByStatus("timed_out");
    const runningCount = this.countByStatus("running");
    const finishedCount = doneCount + failedCount;
    const totalTests = this.sumStats("testsWritten");
    const elapsed = formatElapsed(now - this.startTime);

    let headerParts = [`${finishedCount}/${total} modules`];
    if (totalTests > 0) headerParts.push(`${totalTests} tests`);
    if (runningCount > 0) headerParts.push(`${runningCount} active`);
    headerParts.push(elapsed);

    outputLines.push(`  ${chalk.bold.cyan("Cover:")} ${chalk.dim(headerParts.join(" · "))}`);
    outputLines.push(""); // blank line after header

    // Dimension headers (only show if multiple dimensions are active)
    const hasDimensions = this.dimensionStatus.size > 1 ||
      (this.dimensionStatus.size === 1 && !this.dimensionStatus.has("Functionality"));

    // Group modules by dimension for rendering
    let lastDimension: string | undefined;
    for (const name of this.moduleOrder) {
      const state = this.modules.get(name)!;
      const shortName = shortenModulePath(name);

      // Render dimension header when dimension changes
      if (hasDimensions && state.dimension && state.dimension !== lastDimension) {
        lastDimension = state.dimension;
        const dimLabel = state.dimension.charAt(0).toUpperCase() + state.dimension.slice(1);
        const dimStatus = this.dimensionStatus.get(dimLabel);
        const dimIcon = dimStatus === "done" ? chalk.green("✓") : dimStatus === "failed" ? chalk.red("✗") : chalk.cyan("●");
        if (outputLines.length > 2) outputLines.push(""); // blank line between dimensions
        outputLines.push(`  ${dimIcon} ${chalk.bold(dimLabel)}`);
      }

      if (state.status === "pending") {
        outputLines.push(`  ${chalk.dim(`  ○ ${shortName.padEnd(24)}         ─ waiting`)}`);
        continue;
      }

      const lineElapsed = formatElapsed(now - state.startTime);
      const indent = hasDimensions ? "    " : "  ";

      if (state.status === "done") {
        const statsStr = state.detail || this.formatStats(state.stats);
        outputLines.push(`${indent}${chalk.green("✓")} ${shortName.padEnd(24)} ${chalk.dim(lineElapsed.padStart(7))} ${chalk.dim("─")} ${chalk.dim(statsStr)}`);
      } else if (state.status === "failed") {
        outputLines.push(`${indent}${chalk.red("✗")} ${shortName.padEnd(24)} ${chalk.dim(lineElapsed.padStart(7))} ${chalk.dim("─")} ${chalk.red("failed")}`);
      } else if (state.status === "timed_out") {
        const statsStr = state.stats && state.stats.testsWritten > 0
          ? ` (${this.formatStats(state.stats)})`
          : "";
        outputLines.push(`${indent}${chalk.yellow("⏱")} ${shortName.padEnd(24)} ${chalk.dim(lineElapsed.padStart(7))} ${chalk.dim("─")} ${chalk.yellow("timed out")}${chalk.dim(statsStr)}`);
      } else {
        // running
        const spinner = chalk.cyan(SPINNER_CHARS[this.spinnerFrame]!);
        const fixedLen = `${indent}X ${"".padEnd(24)} ${lineElapsed.padStart(7)} ─ `.length;
        let activityStr = state.activity;
        const maxLen = columns - fixedLen - 2;
        if (activityStr && maxLen > 5 && activityStr.length > maxLen) {
          activityStr = activityStr.slice(0, maxLen - 1) + "…";
        }
        outputLines.push(`${indent}${spinner} ${shortName.padEnd(24)} ${chalk.dim(lineElapsed.padStart(7))} ${chalk.dim("─")} ${chalk.dim(activityStr || "starting...")}`);
      }
    }

    const output = outputLines.join("\n");
    process.stderr.write(output + "\n");

    let rows = 0;
    for (const line of outputLines) {
      const visible = line.replace(/\x1B\[[0-9;]*m/g, "").length;
      rows += Math.max(1, Math.ceil(visible / columns));
    }
    this.physicalRows = rows;
  }

  finalize(): void {
    this.lastRenderTime = 0;
    this.render();
  }

  private countByStatus(status: string): number {
    let count = 0;
    for (const line of this.modules.values()) {
      if (line.status === status) count++;
    }
    return count;
  }

  private sumStats(key: "testsWritten" | "testsPassed" | "testsFailed"): number {
    let sum = 0;
    for (const line of this.modules.values()) {
      if (line.stats) sum += line.stats[key];
    }
    return sum;
  }

  private formatStats(stats?: { testsWritten: number; testsPassed: number; testsFailed: number }): string {
    if (!stats || stats.testsWritten === 0) return "no tests";
    const parts = [`${stats.testsWritten} tests`];
    if (stats.testsPassed > 0) parts.push(`${stats.testsPassed} passed`);
    if (stats.testsFailed > 0) parts.push(`${stats.testsFailed} failed`);
    return parts.join(", ");
  }
}

/** Shorten a module path for display: "apps/api/apps/auth" → "auth" */
function shortenModulePath(path: string): string {
  const segments = path.split("/");
  // Use last segment, but if it's generic (like "src") include parent too
  if (segments.length >= 2) {
    const last = segments[segments.length - 1]!;
    if (last === "src" || last === "lib" || last === "app") {
      return segments.slice(-2).join("/");
    }
    return last;
  }
  return path;
}

/**
 * Create a progress handler specifically for the cover command.
 * Uses CoverProgress multi-line display instead of a single spinner.
 */
function createCoverProgressHandler(spinner: ReturnType<typeof ora>) {
  let coverProgress: CoverProgress | null = null;

  setLogInterceptor((fn) => {
    if (coverProgress) {
      coverProgress.log(fn);
    } else if (spinner.isSpinning) {
      spinner.clear();
      fn();
      spinner.render();
    } else {
      fn();
    }
  });

  const handler = (event: AIProgressEvent): void => {
    switch (event.type) {
      case "dimension_status": {
        if (!coverProgress) {
          spinner.stop();
          coverProgress = new CoverProgress();
        }
        coverProgress.updateDimensionStatus(event.name, event.status);
        coverProgress.render();
        break;
      }
      case "module_status": {
        if (!coverProgress) {
          spinner.stop();
          coverProgress = new CoverProgress();
        }
        coverProgress.updateModuleStatus(event.name, event.status, event.stats, event.dimension, event.detail);
        coverProgress.render();
        break;
      }
      case "tool_use": {
        if (coverProgress) {
          // Parse module-prefixed input: "apps/api/apps/auth: filename" → route to "apps/api/apps/auth"
          const colonIdx = event.input?.indexOf(": ") ?? -1;
          if (colonIdx > 0) {
            const moduleName = event.input!.slice(0, colonIdx);
            const file = shortenToFilename(event.input!.slice(colonIdx + 2));
            coverProgress.updateActivity(moduleName, `${event.tool} ${file}`);
          }
          coverProgress.render();
        }
        break;
      }
      case "thinking":
      case "tool_result":
      case "text_delta":
      case "phase":
        break;
      case "model_detected":
        break;
    }
  };

  // Tick elapsed time every second
  const timer = setInterval(() => {
    if (coverProgress) coverProgress.render();
  }, 1_000);

  const cleanup = (): void => {
    clearInterval(timer);
    if (coverProgress) {
      coverProgress.finalize();
      coverProgress = null;
    }
    setLogInterceptor(null);
  };

  return { handler, cleanup };
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
  // Strip to first line only — tool inputs (especially Bash) can be multi-line
  const firstLine = input.split("\n")[0]!.trim();
  if (!firstLine) return "";
  // Handle glob patterns — keep as-is if short enough
  if (firstLine.includes("*")) return firstLine.length <= 40 ? firstLine : "..." + firstLine.slice(-37);
  // Extract last path segment
  const parts = firstLine.split("/");
  return parts[parts.length - 1] ?? firstLine;
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
 *
 * When `willUseAI` is false (e.g. regression-only scan), the session starts
 * immediately with the provider name since no model detection will occur.
 */
function createLazyUseAISession(
  command: CoveritCommand,
  projectRoot: string,
  provider: AIProvider,
  baseHandler: (event: AIProgressEvent) => void,
  willUseAI: boolean = true,
): {
  handler: (event: AIProgressEvent) => void;
  getSession: () => Promise<UseAISession | null>;
} {
  let session: UseAISession | null = null;
  let sessionStarted = false;
  let sessionPromise: Promise<UseAISession | null> | null = null;

  // Skip UseAI entirely for non-AI operations (e.g. regression-only scans)
  if (!willUseAI) {
    sessionStarted = true; // Prevent lazy start and getSession fallback
  } else if (provider.model) {
    // Start immediately if model is already known (no need to wait for streaming detection)
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

// ─── Usage Summary ───────────────────────────────────────────

/** Print a token usage summary line if any usage data was collected */
function printUsageSummary(tracker: UsageTracker): void {
  if (!tracker.hasUsage) return;
  console.log(chalk.dim(`\n  Token usage: ${tracker.formatSummary()}`));
}

/** Extract UseAI-compatible usage data from a tracker (returns undefined if no usage) */
function extractUsageForUseAI(tracker: UsageTracker): UseAIEndUsage | undefined {
  if (!tracker.hasUsage) return undefined;
  const json = tracker.toJSON();
  if (!json) return undefined;
  return {
    inputTokens: json.inputTokens as number,
    outputTokens: json.outputTokens as number,
    totalTokens: json.totalTokens as number,
    totalCostUsd: json.totalCostUsd as number,
    durationApiMs: json.durationApiMs as number,
    numTurns: json.numTurns as number,
    models: json.models as string[] | undefined,
  };
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
  .option("--dimensions <list>", "Only scan specific dimensions (comma-separated: functionality,security,stability,conformance,regression)")
  .option("--timeout <seconds>", "Timeout per dimension in seconds (default: 900)")
  .option("--full", "Force a full codebase scan (ignore incremental cache)")
  .option("--fresh", "Ignore previous session and start fresh")
  .description("AI scans and analyzes codebase → creates coverit.json quality manifest")
  .action(async (pathArg: string, cmdOpts: {
    full?: boolean;
    fresh?: boolean;
    dimensions?: string;
    timeout?: string;
  }) => {
    const projectRoot = resolveProjectRoot(pathArg);
    const autoYes = program.opts().yes ?? false;
    const timeoutMs = cmdOpts.timeout ? parseInt(cmdOpts.timeout, 10) * 1000 : undefined;

    // Handle resume from previous session
    let resumeScan = true;
    if (cmdOpts.fresh) {
      await deleteScanSession(projectRoot);
      resumeScan = false;
    } else {
      const prevSession = await readScanSession(projectRoot);
      if (prevSession) {
        const completed = Object.entries(prevSession.dimensions)
          .filter(([, s]) => s.status === "completed")
          .map(([d]) => d);
        const remaining = Object.entries(prevSession.dimensions)
          .filter(([, s]) => s.status !== "completed")
          .map(([d]) => d);
        const isInteractive = process.stdin.isTTY && !autoYes;

        if (isInteractive) {
          try {
            const choice = await select({
              message: `Previous scan session found (${completed.length} dimensions completed${remaining.length > 0 ? `, ${remaining.length} remaining` : ""}). Resume?`,
              choices: [
                { name: "Yes, resume from where I left off", value: "resume" },
                { name: "No, start fresh", value: "fresh" },
              ],
            });
            if (choice === "fresh") {
              await deleteScanSession(projectRoot);
              resumeScan = false;
            }
          } catch {
            console.log("\n  Aborted.\n");
            process.exit(0);
          }
        } else {
          // Non-interactive: auto-resume
          console.log(`  Resuming scan (${completed.length} dimensions already completed)\n`);
        }
      }
    }

    // Parse --dimensions flag
    let dimensions: ScanDimension[] | undefined;
    if (cmdOpts.dimensions) {
      const requested = cmdOpts.dimensions.split(",").map((d) => d.trim().toLowerCase());
      const invalid = requested.filter((d) => !ALL_DIMENSIONS.includes(d as ScanDimension));
      if (invalid.length > 0) {
        console.log(chalk.red(`\n  Invalid dimensions: ${invalid.join(", ")}`));
        console.log(`  Valid options: ${ALL_DIMENSIONS.join(", ")}\n`);
        process.exit(1);
      }
      dimensions = requested as ScanDimension[];
      console.log(`  Dimensions: ${chalk.cyan(dimensions.join(", "))}\n`);
    }

    const provider = await resolveProvider(autoYes);

    // Display scan scope info
    const existingManifest = await readManifest(projectRoot);
    if (cmdOpts.full) {
      console.log(`  Scope: ${chalk.cyan("full scan (forced)")}\n`);
    } else if (existingManifest?.project.lastScanCommit) {
      console.log(`  Scope: ${chalk.cyan("auto-incremental (since last scan)")}\n`);
    } else {
      console.log(`  Scope: ${chalk.cyan("full scan (first time)")}\n`);
    }

    const spinner = ora("Scanning and analyzing codebase with AI...").start();
    const progress = createProgressHandler(spinner);
    // AI is used for all dimensions except regression-only
    const willUseAI = !dimensions || dimensions.some((d) => d !== "regression");
    const lazySession = createLazyUseAISession("scan", projectRoot, provider, progress.handler, willUseAI);
    const usageTracker = new UsageTracker();

    try {
      const manifest = await scanCodebase(projectRoot, {
        aiProvider: provider,
        onProgress: lazySession.handler,
        timeoutMs,
        dimensions,
        forceFullScan: cmdOpts.full,
        usageTracker,
        resume: resumeScan,
      });

      progress.cleanup();
      spinner.text = "Writing coverit.json...";
      await writeManifest(projectRoot, manifest);

      spinner.succeed(
        `Scanned and analyzed ${manifest.modules.length} modules (${manifest.project.sourceFiles} files, ${manifest.project.sourceLines} lines)`,
      );

      renderDashboard(manifest);
      printUsageSummary(usageTracker);

      const session = await lazySession.getSession();
      await useaiEnd(session, {
        modules: manifest.modules.length,
        score: manifest.score.overall,
        language: manifest.project.language,
        usage: extractUsageForUseAI(usageTracker),
      });

      logger.success("coverit.json written to project root");
      logger.info("Log saved to .coverit/scan.log");
      logger.info("Next: Run `coverit cover` to generate tests and improve your score.");
    } catch (err) {
      progress.cleanup();
      spinner.fail("Scan failed");
      logger.error(err instanceof Error ? err.message : String(err));
      logger.info("Check .coverit/scan.log for details.");
      printUsageSummary(usageTracker);
      const session = await lazySession.getSession();
      await useaiEnd(session, { usage: extractUsageForUseAI(usageTracker) });
      process.exit(1);
    }
  });

// ─── cover ──────────────────────────────────────────────────

program
  .command("cover")
  .argument("[path]", "Project root path", ".")
  .option("--modules <paths>", "Only cover specific modules (comma-separated)")
  .option("--dimensions <list>", "Which dimensions to cover (comma-separated: functionality,security,stability,conformance)")
  .option("--parallel <count>", "Max modules to process in parallel (default: 3)")
  .option("--timeout <seconds>", "Timeout per module in seconds (default: 600)")
  .option("--fresh", "Ignore previous session and start fresh")
  .option("--full", "Cover all modules with gaps (ignore incremental detection)")
  .description("AI generates tests and fixes code quality issues from coverit.json gaps across all dimensions")
  .action(async (pathArg: string, cmdOpts: { modules?: string; dimensions?: string; parallel?: string; timeout?: string; fresh?: boolean; full?: boolean }) => {
    const projectRoot = resolveProjectRoot(pathArg);
    const autoYes = program.opts().yes ?? false;

    // Handle resume from previous session
    let resumeCover = true;
    if (cmdOpts.fresh) {
      await deleteCoverSession(projectRoot);
      resumeCover = false;
    } else {
      const prevSession = await readCoverSession(projectRoot);
      if (prevSession) {
        const entries = Object.entries(prevSession.modules);
        const completed = entries.filter(([, s]) => s.status === "completed").length;
        const timedOut = entries.filter(([, s]) => s.status === "timed_out").length;
        const failed = entries.filter(([, s]) => s.status === "failed").length;
        const total = entries.length;
        const isInteractive = process.stdin.isTTY && !autoYes;

        if (isInteractive) {
          const parts = [`${completed}/${total} modules completed`];
          if (timedOut > 0) parts.push(`${timedOut} timed out`);
          if (failed > 0) parts.push(`${failed} failed`);
          try {
            const choice = await select({
              message: `Previous cover session found (${parts.join(", ")}). Resume?`,
              choices: [
                { name: "Yes, resume from where I left off", value: "resume" },
                { name: "No, start fresh", value: "fresh" },
              ],
            });
            if (choice === "fresh") {
              await deleteCoverSession(projectRoot);
              resumeCover = false;
            }
          } catch {
            console.log("\n  Aborted.\n");
            process.exit(0);
          }
        } else {
          // Non-interactive: auto-resume
          console.log(`  Resuming cover (${completed}/${total} modules already completed)\n`);
        }
      }
    }

    const provider = await resolveProvider(autoYes);
    const spinner = ora("Reading coverit.json and generating tests...").start();
    const progress = createCoverProgressHandler(spinner);
    const lazySession = createLazyUseAISession("cover", projectRoot, provider, progress.handler);
    const usageTracker = new UsageTracker();

    try {
      const modules = cmdOpts.modules
        ? cmdOpts.modules.split(",").map((m) => m.trim())
        : undefined;
      const dimensions = cmdOpts.dimensions
        ? cmdOpts.dimensions.split(",").map((d) => d.trim()) as CoverDimension[]
        : undefined;
      const concurrency = cmdOpts.parallel ? parseInt(cmdOpts.parallel, 10) : undefined;
      const timeoutMs = cmdOpts.timeout ? parseInt(cmdOpts.timeout, 10) * 1000 : undefined;

      const result = await cover({
        projectRoot,
        modules,
        dimensions,
        concurrency,
        timeoutMs,
        aiProvider: provider,
        onProgress: lazySession.handler,
        usageTracker,
        resume: resumeCover,
        full: cmdOpts.full,
      });

      progress.cleanup();
      spinner.stop();

      console.log(chalk.bold("\n  Cover Results\n"));

      const delta = Math.round((result.scoreAfter - result.scoreBefore) * 10) / 10;
      const deltaStr =
        delta > 0
          ? chalk.green(`+${delta}`)
          : delta < 0
            ? chalk.red(String(delta))
            : chalk.gray("±0");

      const table: Record<string, string | number> = {
        "Score": `${result.scoreBefore}/100 → ${result.scoreAfter}/100 (${deltaStr})`,
        "Modules Processed": result.modulesProcessed,
      };

      // Show functionality stats if present
      if (result.dimensionResults.functionality || result.testsGenerated > 0) {
        table["Tests Generated"] = result.testsGenerated;
        table["Passed"] = chalk.green(String(result.testsPassed));
        table["Failed"] = result.testsFailed > 0 ? chalk.red(String(result.testsFailed)) : String(result.testsFailed);
      }

      // Show other dimension stats
      if (result.dimensionResults.security) {
        const sec = result.dimensionResults.security;
        table["Security"] = `${sec.itemsFixed} findings fixed${sec.itemsSkipped > 0 ? `, ${sec.itemsSkipped} skipped` : ""}`;
      }
      if (result.dimensionResults.stability) {
        const stab = result.dimensionResults.stability;
        table["Stability"] = `${stab.itemsFixed} gaps fixed${stab.itemsSkipped > 0 ? `, ${stab.itemsSkipped} skipped` : ""}`;
      }
      if (result.dimensionResults.conformance) {
        const conf = result.dimensionResults.conformance;
        table["Conformance"] = `${conf.itemsFixed} violations fixed${conf.itemsSkipped > 0 ? `, ${conf.itemsSkipped} skipped` : ""}`;
      }

      logger.table(table);

      printUsageSummary(usageTracker);

      const session = await lazySession.getSession();
      await useaiEnd(session, {
        scoreBefore: result.scoreBefore,
        scoreAfter: result.scoreAfter,
        testsGenerated: result.testsGenerated,
        testsPassed: result.testsPassed,
        testsFailed: result.testsFailed,
        usage: extractUsageForUseAI(usageTracker),
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
      printUsageSummary(usageTracker);
      const session = await lazySession.getSession();
      await useaiEnd(session, { usage: extractUsageForUseAI(usageTracker) });
      process.exit(1);
    }
  });

// ─── fix ────────────────────────────────────────────────────

program
  .command("fix")
  .argument("[path]", "Project root path", ".")
  .option("--modules <paths>", "Only fix tests for specific modules (comma-separated)")
  .description("Fix failing tests via AI, and update the score")
  .action(async (pathArg: string, cmdOpts: { modules?: string }) => {
    const projectRoot = resolveProjectRoot(pathArg);
    const autoYes = program.opts().yes ?? false;

    const provider = await resolveProvider(autoYes);
    const spinner = ora("Running tests and fixing failures...").start();
    const progress = createProgressHandler(spinner);
    const lazySession = createLazyUseAISession("fix", projectRoot, provider, progress.handler);
    const usageTracker = new UsageTracker();

    try {
      const modules = cmdOpts.modules
        ? cmdOpts.modules.split(",").map((m) => m.trim())
        : undefined;

      const result = await fixTests({
        projectRoot,
        modules,
        aiProvider: provider,
        onProgress: lazySession.handler,
        usageTracker,
      });

      progress.cleanup();
      spinner.stop();

      console.log(chalk.bold("\n  Fix Results\n"));

      const delta = Math.round((result.scoreAfter - result.scoreBefore) * 10) / 10;
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

      printUsageSummary(usageTracker);

      const session = await lazySession.getSession();
      await useaiEnd(session, {
        scoreBefore: result.scoreBefore,
        scoreAfter: result.scoreAfter,
        totalTests: result.totalTests,
        passed: result.passed,
        failed: result.failed,
        fixed: result.fixed,
        usage: extractUsageForUseAI(usageTracker),
      });

      if (delta > 0) {
        logger.success(`Score improved by ${delta} points.`);
      }
      if (result.fixed > 0) {
        logger.info(`AI fixed ${result.fixed} test(s).`);
      }
      if (result.failed > 0) {
        logger.warn("Some tests still failing. Run `coverit fix` again to retry.");
      }
    } catch (err) {
      progress.cleanup();
      spinner.fail("Fix failed");
      logger.error(err instanceof Error ? err.message : String(err));
      printUsageSummary(usageTracker);
      const session = await lazySession.getSession();
      await useaiEnd(session, { usage: extractUsageForUseAI(usageTracker) });
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

// Kill spawned AI processes (claude, gemini, codex) on Ctrl+C / SIGTERM
registerCleanupHandlers();

program.parse();
