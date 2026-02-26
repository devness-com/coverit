/**
 * Coverit Scale — Manifest Writer
 *
 * Handles reading and writing coverit.json to the project root.
 * The manifest is designed to be committed to version control —
 * it serves as the project's persistent quality standard.
 *
 * On write, this module:
 *  1. Serializes the manifest as formatted JSON
 *  2. Writes to {projectRoot}/coverit.json
 *  3. Does NOT add coverit.json to .gitignore (it should be tracked)
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CoveritManifest } from "../schema/coverit-manifest.js";
import { logger } from "../utils/logger.js";

// ─── Constants ───────────────────────────────────────────────

const MANIFEST_FILENAME = "coverit.json";

// ─── Write ───────────────────────────────────────────────────

/**
 * Writes the manifest to coverit.json in the project root.
 * Overwrites any existing manifest file.
 *
 * The JSON is formatted with 2-space indentation for readability
 * in version control diffs.
 */
export async function writeManifest(
  projectRoot: string,
  manifest: CoveritManifest,
): Promise<void> {
  const manifestPath = join(projectRoot, MANIFEST_FILENAME);
  const content = JSON.stringify(manifest, null, 2) + "\n";

  await writeFile(manifestPath, content, "utf-8");
  logger.debug(`Manifest written to ${manifestPath}`);
}

// ─── Read ────────────────────────────────────────────────────

/**
 * Reads and parses an existing coverit.json from the project root.
 * Returns null if the file doesn't exist or is malformed.
 *
 * No schema validation is performed here — the caller is responsible
 * for handling version mismatches or incomplete manifests.
 */
export async function readManifest(
  projectRoot: string,
): Promise<CoveritManifest | null> {
  const manifestPath = join(projectRoot, MANIFEST_FILENAME);

  try {
    const raw = await readFile(manifestPath, "utf-8");
    return JSON.parse(raw) as CoveritManifest;
  } catch {
    // File doesn't exist or isn't valid JSON
    return null;
  }
}
