/**
 * Coverit — Logger Utility
 *
 * Structured logging with colored output for CLI and internal use.
 * Debug logging gated behind COVERIT_DEBUG=1 environment variable.
 */

import chalk from "chalk";
import ora, { type Ora } from "ora";

const PREFIX = "[coverit]";

function isDebug(): boolean {
  return process.env["COVERIT_DEBUG"] === "1";
}

export const logger = {
  debug(...args: unknown[]): void {
    if (isDebug()) {
      console.debug(chalk.gray(`${PREFIX} [debug]`), ...args);
    }
  },

  info(...args: unknown[]): void {
    console.log(chalk.cyan(PREFIX), ...args);
  },

  warn(...args: unknown[]): void {
    console.warn(chalk.yellow(PREFIX), ...args);
  },

  error(...args: unknown[]): void {
    console.error(chalk.red(PREFIX), ...args);
  },

  success(...args: unknown[]): void {
    console.log(chalk.green(`${PREFIX} ✓`), ...args);
  },

  spinner(text: string): Ora {
    return ora({ text, prefixText: chalk.cyan(PREFIX) }).start();
  },

  table(data: Record<string, unknown>[] | Record<string, unknown>): void {
    if (Array.isArray(data)) {
      console.table(data);
    } else {
      const entries = Object.entries(data);
      const maxKey = Math.max(...entries.map(([k]) => k.length));
      for (const [key, value] of entries) {
        console.log(
          `  ${chalk.gray(key.padEnd(maxKey))}  ${chalk.white(String(value))}`,
        );
      }
    }
  },
};
