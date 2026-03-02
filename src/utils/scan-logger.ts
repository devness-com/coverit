/**
 * Scan Logger — Persistent log file for dimension scan results
 *
 * Writes to `.coverit/scan.log` in the project root. Append-based so
 * history is preserved across scans. Cleaned up by `coverit clear`.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ensureCoveritIgnored } from "./gitignore.js";

export interface DimensionLogEntry {
  name: string;
  success: boolean;
  durationMs: number;
  detail?: string;
  error?: string;
}

export class ScanLogger {
  private readonly logPath: string;
  private readonly entries: DimensionLogEntry[] = [];
  private readonly sessionStart: Date;

  constructor(projectRoot: string) {
    this.logPath = join(projectRoot, ".coverit", "scan.log");
    this.sessionStart = new Date();
  }

  /** Record a dimension scan result */
  record(entry: DimensionLogEntry): void {
    this.entries.push(entry);
  }

  /** Flush all recorded entries to .coverit/scan.log */
  async flush(score?: number): Promise<void> {
    await mkdir(join(this.logPath, ".."), { recursive: true });
    await ensureCoveritIgnored(join(this.logPath, "../.."));

    const lines: string[] = [];
    const ts = this.sessionStart.toISOString();
    lines.push(`\n${"─".repeat(50)}`);
    lines.push(`Scan Session: ${ts}`);
    lines.push(`${"─".repeat(50)}`);

    for (const entry of this.entries) {
      const icon = entry.success ? "+" : "x";
      const duration = formatDuration(entry.durationMs);
      const detail = entry.detail ? ` — ${entry.detail}` : "";
      lines.push(`  [${icon}] ${entry.name.padEnd(16)} ${duration}${detail}`);
      if (entry.error) {
        lines.push(`       Error: ${entry.error}`);
      }
    }

    if (score !== undefined) {
      lines.push(`  Score: ${score}/100`);
    }

    lines.push("");

    await appendFile(this.logPath, lines.join("\n"), "utf-8");
  }

  /** Get the path to the log file */
  get path(): string {
    return this.logPath;
  }
}

function formatDuration(ms: number): string {
  const totalSecs = Math.floor(ms / 1_000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins > 0) return `(${mins}m ${secs.toString().padStart(2, "0")}s)`;
  return `(${secs}s)`;
}
