/**
 * Process Tracker — Tracks spawned child processes for cleanup on exit.
 *
 * When coverit spawns AI CLI processes (claude, gemini, codex), they need
 * to be explicitly killed if the parent process receives SIGINT/SIGTERM.
 * Without this, Ctrl+C kills coverit but leaves orphaned AI processes
 * still generating tests in the background.
 */

import type { ChildProcess } from "node:child_process";

const activeProcesses = new Set<ChildProcess>();

/**
 * Track a spawned child process. Automatically untracked on close/error.
 */
export function trackProcess(proc: ChildProcess): void {
  activeProcesses.add(proc);
  proc.on("close", () => activeProcesses.delete(proc));
  proc.on("error", () => activeProcesses.delete(proc));
}

/**
 * Kill all tracked child processes with SIGTERM.
 * Called on SIGINT/SIGTERM to prevent orphaned AI processes.
 */
export function killAllProcesses(): void {
  for (const proc of activeProcesses) {
    try {
      proc.kill("SIGTERM");
    } catch {
      // Process may have already exited
    }
  }
  activeProcesses.clear();
}

/**
 * Register signal handlers that clean up child processes on exit.
 * Call this once at CLI startup.
 */
export function registerCleanupHandlers(): void {
  let cleaning = false;

  const cleanup = (_signal: string, exitCode: number) => {
    if (cleaning) return;
    cleaning = true;
    killAllProcesses();
    process.exit(exitCode);
  };

  process.on("SIGINT", () => cleanup("SIGINT", 130));
  process.on("SIGTERM", () => cleanup("SIGTERM", 143));
}
