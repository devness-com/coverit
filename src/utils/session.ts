/**
 * Session Manager — JSON persistence for resumable scan & cover sessions.
 *
 * Stores session state in `.coverit/cover-session.json` and `.coverit/scan-session.json`
 * so killed processes can resume from where they left off.
 */

import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ensureCoveritIgnored } from "./gitignore.js";

// ─── Types ───────────────────────────────────────────────────

export type ModuleStatus = "pending" | "in_progress" | "completed" | "failed" | "timed_out";
export type DimensionStatus = "pending" | "running" | "completed" | "failed";

export interface CoverModuleSession {
  status: ModuleStatus;
  attempts: number;
  lastAttemptAt?: string;
}

export interface CoverSession {
  startedAt: string;
  modules: Record<string, CoverModuleSession>;
  /** Which dimension is currently being processed */
  currentDimension?: string;
  /** Per-dimension completion status */
  dimensionStatus?: Record<string, DimensionStatus>;
  /** Security fix progress per module */
  securityModules?: Record<string, CoverModuleSession>;
  /** Stability fix progress per module */
  stabilityModules?: Record<string, CoverModuleSession>;
  /** Conformance fix progress per module */
  conformanceModules?: Record<string, CoverModuleSession>;
}

export interface ScanDimensionSession {
  status: DimensionStatus;
  durationMs?: number;
}

export interface ScanSession {
  startedAt: string;
  dimensions: Record<string, ScanDimensionSession>;
}

// ─── Paths ───────────────────────────────────────────────────

const COVERIT_DIR = ".coverit";
const COVER_SESSION_FILE = "cover-session.json";
const SCAN_SESSION_FILE = "scan-session.json";

function coverSessionPath(projectRoot: string): string {
  return join(projectRoot, COVERIT_DIR, COVER_SESSION_FILE);
}

function scanSessionPath(projectRoot: string): string {
  return join(projectRoot, COVERIT_DIR, SCAN_SESSION_FILE);
}

async function ensureDir(projectRoot: string): Promise<void> {
  await mkdir(join(projectRoot, COVERIT_DIR), { recursive: true });
  await ensureCoveritIgnored(projectRoot);
}

// ─── Cover Session ───────────────────────────────────────────

export async function readCoverSession(projectRoot: string): Promise<CoverSession | null> {
  try {
    const raw = await readFile(coverSessionPath(projectRoot), "utf-8");
    return JSON.parse(raw) as CoverSession;
  } catch {
    return null;
  }
}

export async function writeCoverSession(projectRoot: string, session: CoverSession): Promise<void> {
  await ensureDir(projectRoot);
  await writeFile(coverSessionPath(projectRoot), JSON.stringify(session, null, 2) + "\n", "utf-8");
}

export async function deleteCoverSession(projectRoot: string): Promise<void> {
  try {
    await unlink(coverSessionPath(projectRoot));
  } catch {
    // File didn't exist — fine
  }
}

// ─── Scan Session ────────────────────────────────────────────

export async function readScanSession(projectRoot: string): Promise<ScanSession | null> {
  try {
    const raw = await readFile(scanSessionPath(projectRoot), "utf-8");
    return JSON.parse(raw) as ScanSession;
  } catch {
    return null;
  }
}

export async function writeScanSession(projectRoot: string, session: ScanSession): Promise<void> {
  await ensureDir(projectRoot);
  await writeFile(scanSessionPath(projectRoot), JSON.stringify(session, null, 2) + "\n", "utf-8");
}

export async function deleteScanSession(projectRoot: string): Promise<void> {
  try {
    await unlink(scanSessionPath(projectRoot));
  } catch {
    // File didn't exist — fine
  }
}
