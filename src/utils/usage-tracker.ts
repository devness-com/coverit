/**
 * Usage Tracker — Accumulates token usage across multiple AI calls
 *
 * Each scan/cover/run command may invoke the AI provider multiple times
 * (e.g. scan calls Functionality + Security + Stability + Conformance).
 * This tracker sums usage across all calls and provides a formatted summary.
 */

import type { AIUsage } from "../ai/types.js";

export class UsageTracker {
  private calls: AIUsage[] = [];
  private models = new Set<string>();

  /** Record usage and model from a single AI generate() call */
  add(usage: AIUsage | undefined, model?: string): void {
    if (usage) {
      this.calls.push(usage);
    }
    if (model && model !== "claude-cli" && model !== "gemini-cli" && model !== "codex-cli") {
      this.models.add(model);
    }
  }

  /** Number of AI calls that reported usage */
  get callCount(): number {
    return this.calls.length;
  }

  /** Whether any usage data was collected */
  get hasUsage(): boolean {
    return this.calls.length > 0;
  }

  /** Get accumulated totals across all calls */
  getTotal(): AIUsage {
    const total: AIUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0,
      durationMs: 0,
      durationApiMs: 0,
      numTurns: 0,
    };

    for (const u of this.calls) {
      total.inputTokens += u.inputTokens;
      total.outputTokens += u.outputTokens;
      total.cacheReadInputTokens += u.cacheReadInputTokens;
      total.cacheCreationInputTokens += u.cacheCreationInputTokens;
      total.totalCostUsd += u.totalCostUsd;
      total.durationMs += u.durationMs;
      total.durationApiMs += u.durationApiMs;
      total.numTurns += u.numTurns;
    }

    return total;
  }

  /** Format usage as a compact summary string for CLI display */
  formatSummary(): string {
    if (!this.hasUsage) return "";

    const t = this.getTotal();
    const totalTokens = t.inputTokens + t.outputTokens;
    const parts: string[] = [];

    parts.push(`${formatNumber(t.inputTokens)} in + ${formatNumber(t.outputTokens)} out = ${formatNumber(totalTokens)} tokens`);

    if (t.totalCostUsd > 0) {
      parts.push(`$${t.totalCostUsd.toFixed(4)}`);
    }

    if (this.models.size > 0) {
      parts.push([...this.models].join(", "));
    }

    if (t.durationApiMs > 0) {
      parts.push(`API ${formatDuration(t.durationApiMs)}`);
    }

    if (t.numTurns > 0) {
      parts.push(`${t.numTurns} turns`);
    }

    if (t.cacheReadInputTokens > 0 && t.inputTokens > 0) {
      // inputTokens from the SDK = net new (non-cached) tokens sent to the API.
      // cacheReadInputTokens = tokens served from cache (not included in inputTokens).
      // Total tokens processed = inputTokens + cacheReadInputTokens.
      const totalInput = t.inputTokens + t.cacheReadInputTokens;
      const cachePercent = Math.round((t.cacheReadInputTokens / totalInput) * 100);
      parts.push(`${cachePercent}% cached`);
    }

    return parts.join(" · ");
  }

  /** Format usage as a JSON-serializable object for MCP responses */
  toJSON(): Record<string, unknown> | null {
    if (!this.hasUsage) return null;

    const t = this.getTotal();
    return {
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      totalTokens: t.inputTokens + t.outputTokens,
      cacheReadInputTokens: t.cacheReadInputTokens,
      cacheCreationInputTokens: t.cacheCreationInputTokens,
      totalCostUsd: Math.round(t.totalCostUsd * 10000) / 10000,
      durationMs: t.durationMs,
      durationApiMs: t.durationApiMs,
      numTurns: t.numTurns,
      aiCalls: this.callCount,
      ...(this.models.size > 0 ? { models: [...this.models] } : {}),
    };
  }
}

/** Format a number with thousands separators: 12345 → "12,345" */
function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** Format milliseconds as "1m 23s" or "45s" */
function formatDuration(ms: number): string {
  const totalSecs = Math.round(ms / 1_000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins > 0) return `${mins}m ${secs.toString().padStart(2, "0")}s`;
  return `${secs}s`;
}
