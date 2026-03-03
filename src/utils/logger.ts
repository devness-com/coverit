/**
 * Coverit — Logger Utility
 *
 * Structured logging with colored output for CLI and internal use.
 * Debug logging gated behind COVERIT_DEBUG=1 environment variable.
 *
 * When a CLI spinner/progress display is active, use setLogInterceptor()
 * to route log output through the progress handler so it doesn't corrupt
 * ANSI cursor positioning.
 */

import chalk from "chalk";
import ora, { type Ora } from "ora";

const PREFIX = "[coverit]";

function isDebug(): boolean {
  return process.env["COVERIT_DEBUG"] === "1";
}

/**
 * Optional interceptor: wraps a logging function so the CLI can clear
 * any active spinner/progress before the message is written, then re-render.
 * Set via setLogInterceptor() from the CLI when a spinner is active.
 */
let logInterceptor: ((fn: () => void) => void) | null = null;

/** Register an interceptor that wraps logger output (call with null to unset). */
export function setLogInterceptor(interceptor: ((fn: () => void) => void) | null): void {
  logInterceptor = interceptor;
}

function safeLog(fn: () => void): void {
  if (logInterceptor) {
    logInterceptor(fn);
  } else {
    fn();
  }
}

export const logger = {
  debug(...args: unknown[]): void {
    if (isDebug()) {
      safeLog(() => console.debug(chalk.gray(`${PREFIX} [debug]`), ...args));
    }
  },

  info(...args: unknown[]): void {
    safeLog(() => console.log(chalk.cyan(PREFIX), ...args));
  },

  warn(...args: unknown[]): void {
    safeLog(() => console.warn(chalk.yellow(PREFIX), ...args));
  },

  error(...args: unknown[]): void {
    safeLog(() => console.error(chalk.red(PREFIX), ...args));
  },

  success(...args: unknown[]): void {
    safeLog(() => console.log(chalk.green(`${PREFIX} ✓`), ...args));
  },

  spinner(text: string): Ora {
    return ora({ text, prefixText: chalk.cyan(PREFIX) }).start();
  },

  table(data: Record<string, unknown>[] | Record<string, unknown>): void {
    if (Array.isArray(data)) {
      safeLog(() => console.table(data));
    } else {
      const entries = Object.entries(data);
      const maxKey = Math.max(...entries.map(([k]) => k.length));
      safeLog(() => {
        for (const [key, value] of entries) {
          console.log(
            `  ${chalk.gray(key.padEnd(maxKey))}  ${chalk.white(String(value))}`,
          );
        }
      });
    }
  },
};
