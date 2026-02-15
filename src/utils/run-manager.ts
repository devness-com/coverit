/**
 * Coverit — Run Manager
 *
 * Manages per-run isolation: each coverit invocation gets its own
 * directory under `.coverit/runs/{runId}/` with strategy, progress,
 * and report files.
 */

import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { DiffSource, RunMeta, CoveritReport } from "../types/index.js";

const COVERIT_DIR = ".coverit";
const RUNS_DIR = "runs";
const LATEST_FILE = "latest.json";

interface PlanProgress {
  planId: string;
  status: "generating" | "running" | "passed" | "failed" | "error" | "skipped";
  description: string;
  testFile?: string;
  passed?: number;
  failed?: number;
  duration?: number;
  reason?: string;
  updatedAt: string;
}

// ─── Run ID + scope ─────────────────────────────────────────

export function generateRunId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time =
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0") +
    String(now.getSeconds()).padStart(2, "0");
  const hex = randomBytes(2).toString("hex");
  return `run-${date}-${time}-${hex}`;
}

export function deriveScope(ds?: DiffSource): string {
  if (!ds) return "auto";
  switch (ds.mode) {
    case "pr":
      return ds.number !== undefined ? `pr-${ds.number}` : "pr";
    case "staged":
      return "staged";
    case "base":
      return `base-${ds.branch}`;
    case "commit":
      return `commit-${ds.ref}`;
    case "files":
      return "files";
    case "all":
      return "all";
    case "auto":
    default:
      return "auto";
  }
}

// ─── Path helpers ───────────────────────────────────────────

export function getRunDir(projectRoot: string, runId: string): string {
  return join(projectRoot, COVERIT_DIR, RUNS_DIR, runId);
}

function getRunsDir(projectRoot: string): string {
  return join(projectRoot, COVERIT_DIR, RUNS_DIR);
}

function getLatestPath(projectRoot: string): string {
  return join(projectRoot, COVERIT_DIR, LATEST_FILE);
}

// ─── CRUD ───────────────────────────────────────────────────

export async function createRun(
  projectRoot: string,
  diffSource?: DiffSource,
): Promise<RunMeta> {
  const runId = generateRunId();
  const runDir = getRunDir(projectRoot, runId);
  await mkdir(join(runDir, "progress"), { recursive: true });

  const meta: RunMeta = {
    runId,
    scope: deriveScope(diffSource),
    diffSource,
    createdAt: new Date().toISOString(),
    status: "running",
    planCount: 0,
  };

  await writeFile(join(runDir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");
  await writeFile(
    getLatestPath(projectRoot),
    JSON.stringify({ runId }, null, 2),
    "utf-8",
  );

  return meta;
}

export async function resolveRunId(
  projectRoot: string,
  opts: { runId?: string; diffSource?: DiffSource },
): Promise<string> {
  // Explicit runId
  if (opts.runId) {
    const runDir = getRunDir(projectRoot, opts.runId);
    if (existsSync(runDir)) return opts.runId;
    throw new Error(`Run not found: ${opts.runId}`);
  }

  // Match scope from diffSource
  if (opts.diffSource) {
    const scope = deriveScope(opts.diffSource);
    const runs = await listRuns(projectRoot, scope);
    if (runs.length > 0) return runs[0]!.runId;
  }

  // Latest
  const latestPath = getLatestPath(projectRoot);
  if (existsSync(latestPath)) {
    try {
      const data = JSON.parse(await readFile(latestPath, "utf-8")) as { runId: string };
      if (data.runId && existsSync(getRunDir(projectRoot, data.runId))) {
        return data.runId;
      }
    } catch {
      // Corrupt latest.json
    }
  }

  // Fallback: check for legacy flat .coverit/strategy.json
  const legacyStrategy = join(projectRoot, COVERIT_DIR, "strategy.json");
  if (existsSync(legacyStrategy)) {
    throw new Error(
      "No run directory found. Found legacy .coverit/strategy.json — run /coverit:run to create a new run.",
    );
  }

  throw new Error("No coverit runs found. Run /coverit:run first.");
}

export async function updateRunMeta(
  projectRoot: string,
  runId: string,
  update: Partial<RunMeta>,
): Promise<void> {
  const metaPath = join(getRunDir(projectRoot, runId), "meta.json");
  let meta: RunMeta;
  try {
    meta = JSON.parse(await readFile(metaPath, "utf-8")) as RunMeta;
  } catch {
    throw new Error(`Run meta not found: ${runId}`);
  }
  Object.assign(meta, update);
  await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");
}

export async function completeRun(
  projectRoot: string,
  runId: string,
  report: CoveritReport,
): Promise<void> {
  const runDir = getRunDir(projectRoot, runId);

  // Write report
  await writeFile(
    join(runDir, "report.json"),
    JSON.stringify(report, null, 2),
    "utf-8",
  );

  // Update meta with completion info
  const s = report.summary;
  const status: RunMeta["status"] =
    s.status === "all-passed"
      ? "completed"
      : s.status === "has-errors"
        ? "failed"
        : s.errorCount > 0
          ? "partial"
          : "failed";

  await updateRunMeta(projectRoot, runId, {
    completedAt: new Date().toISOString(),
    status,
    planCount: s.totalPlans,
    summary: {
      totalTests: s.totalTests,
      passed: s.passed,
      failed: s.failed,
      skipped: s.skipped,
      errorCount: s.errorCount,
      duration: report.duration,
    },
  });
}

export async function listRuns(
  projectRoot: string,
  scope?: string,
): Promise<RunMeta[]> {
  const runsDir = getRunsDir(projectRoot);
  if (!existsSync(runsDir)) return [];

  const entries = await readdir(runsDir);
  const runs: RunMeta[] = [];

  for (const entry of entries) {
    const metaPath = join(runsDir, entry, "meta.json");
    if (!existsSync(metaPath)) continue;
    try {
      let meta = JSON.parse(await readFile(metaPath, "utf-8")) as RunMeta;
      if (scope && meta.scope !== scope) continue;

      // Auto-finalize stale runs: if meta has no real summary but progress files exist
      if (meta.status === "running" && (!meta.summary || meta.summary.totalTests === 0)) {
        const progressDir = join(runsDir, entry, "progress");
        if (existsSync(progressDir)) {
          const plans = await readProgressFiles(progressDir);
          if (plans.length > 0 && plans.every((p) => ["passed", "failed", "error", "skipped"].includes(p.status))) {
            const summary = aggregateProgressSummary(plans);
            const status: RunMeta["status"] =
              summary.failed === 0 && summary.errorCount === 0 ? "completed" : "failed";
            meta = { ...meta, completedAt: new Date().toISOString(), status, summary };
            await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");
          }
        }
      }

      runs.push(meta);
    } catch {
      // Skip corrupt meta files
    }
  }

  // Sort newest first
  runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return runs;
}

async function readProgressFiles(progressDir: string): Promise<PlanProgress[]> {
  const plans: PlanProgress[] = [];
  if (!existsSync(progressDir)) return plans;
  const files = await readdir(progressDir);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const progress = JSON.parse(
        await readFile(join(progressDir, file), "utf-8"),
      ) as PlanProgress;
      plans.push(progress);
    } catch {
      // Skip corrupt progress files
    }
  }
  return plans;
}

export async function getRunStatus(
  projectRoot: string,
  runId: string,
): Promise<{ meta: RunMeta; plans: PlanProgress[] }> {
  const runDir = getRunDir(projectRoot, runId);
  const metaPath = join(runDir, "meta.json");

  if (!existsSync(metaPath)) {
    throw new Error(`Run not found: ${runId}`);
  }

  const meta = JSON.parse(await readFile(metaPath, "utf-8")) as RunMeta;
  const plans = await readProgressFiles(join(runDir, "progress"));

  // Auto-finalize: if meta has no summary but progress files exist with terminal status,
  // compute the summary from progress files and update meta
  if (
    (!meta.summary || (meta.summary.totalTests === 0 && meta.status === "running")) &&
    plans.length > 0 &&
    plans.every((p) => ["passed", "failed", "error", "skipped"].includes(p.status))
  ) {
    const summary = aggregateProgressSummary(plans);
    const status: RunMeta["status"] =
      summary.failed === 0 && summary.errorCount === 0
        ? "completed"
        : "failed";
    const update: Partial<RunMeta> = {
      completedAt: new Date().toISOString(),
      status,
      summary,
    };
    Object.assign(meta, update);
    // Persist the computed summary back to meta.json
    await writeFile(join(runDir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");
  }

  return { meta, plans };
}

// ─── Delete / Clear ─────────────────────────────────────────

export async function deleteRun(
  projectRoot: string,
  runId: string,
): Promise<{ deleted: boolean; testFiles: string[] }> {
  const runDir = getRunDir(projectRoot, runId);
  if (!existsSync(runDir)) {
    throw new Error(`Run not found: ${runId}`);
  }

  // Collect generated test file paths from progress files before deleting
  const testFiles: string[] = [];
  const progressDir = join(runDir, "progress");
  if (existsSync(progressDir)) {
    const plans = await readProgressFiles(progressDir);
    for (const p of plans) {
      if (p.testFile) testFiles.push(p.testFile);
    }
  }

  await rm(runDir, { recursive: true, force: true });

  // Update latest.json if it pointed to this run
  const latestPath = getLatestPath(projectRoot);
  if (existsSync(latestPath)) {
    try {
      const data = JSON.parse(await readFile(latestPath, "utf-8")) as { runId: string };
      if (data.runId === runId) {
        // Point to the next most recent run, or remove latest.json
        const remaining = await listRuns(projectRoot);
        if (remaining.length > 0) {
          await writeFile(latestPath, JSON.stringify({ runId: remaining[0]!.runId }, null, 2), "utf-8");
        } else {
          await rm(latestPath, { force: true });
        }
      }
    } catch {
      // Corrupt latest.json — ignore
    }
  }

  return { deleted: true, testFiles };
}

export async function clearRuns(
  projectRoot: string,
  scope?: string,
): Promise<{ deletedCount: number; testFiles: string[] }> {
  const runs = await listRuns(projectRoot, scope);
  const allTestFiles: string[] = [];
  let deletedCount = 0;

  for (const run of runs) {
    const result = await deleteRun(projectRoot, run.runId);
    deletedCount++;
    allTestFiles.push(...result.testFiles);
  }

  return { deletedCount, testFiles: allTestFiles };
}

/**
 * Aggregate summary stats from progress files.
 * Used to finalize meta.json after batch execution.
 */
function aggregateProgressSummary(plans: PlanProgress[]): NonNullable<RunMeta["summary"]> {
  let totalTests = 0;
  let passed = 0;
  let failed = 0;
  let errorCount = 0;
  let duration = 0;

  for (const p of plans) {
    const planPassed = p.passed ?? 0;
    const planFailed = p.failed ?? 0;
    totalTests += planPassed + planFailed;
    passed += planPassed;
    failed += planFailed;
    if (p.status === "error") errorCount++;
    duration += p.duration ?? 0;
  }

  return { totalTests, passed, failed, skipped: 0, errorCount, duration };
}
