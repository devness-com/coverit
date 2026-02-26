/**
 * Coverit — Stability Analyzer
 *
 * AI-powered analysis of code reliability and resilience. Examines
 * source files for error handling gaps, missing edge case guards,
 * resource cleanup issues, and lack of graceful degradation.
 *
 * Maps to ISO/IEC 25010:2023 "Reliability" quality characteristic.
 *
 * Pipeline:
 *   1. Read changed source files (skip tests, configs, type-only files)
 *   2. Batch files to stay within AI token limits (~60KB per batch)
 *   3. Send each batch to the AI provider with the stability prompt
 *   4. Parse and aggregate findings across all batches
 *   5. Compute an overall stability score (0-100)
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { AIProvider } from "../ai/types.js";
import type { StabilityCheck } from "../schema/coverit-manifest.js";
import { DEFAULT_STABILITY } from "../schema/defaults.js";
import {
  buildStabilityPrompt,
  parseStabilityResponse,
  type StabilityFinding,
  type StabilityResult,
} from "../ai/stability-prompts.js";
import { logger } from "../utils/logger.js";

export type { StabilityFinding, StabilityResult };

// ─── Configuration ──────────────────────────────────────────

/** Maximum combined content size per AI batch (bytes) */
const MAX_BATCH_SIZE = 60_000;

/** Maximum individual file size to include in analysis */
const MAX_FILE_SIZE = 50_000;

/** Files matching these patterns are excluded from stability analysis */
const SKIP_PATTERNS = [
  /\.(test|spec)\.[jt]sx?$/,
  /\.(d\.ts)$/,
  /\.(css|scss|less|svg|png|jpg|json|md)$/,
  /\.config\.[jt]s$/,
  /tsconfig.*\.json$/,
  /package\.json$/,
  /jest\.config/,
  /vitest\.config/,
  /eslint/,
  /prettier/,
];

// ─── Public API ─────────────────────────────────────────────

/**
 * Analyze changed files for stability and reliability issues.
 *
 * @param projectRoot - Absolute path to the project root
 * @param changedFiles - Relative paths of files to analyze
 * @param aiProvider - AI provider for analysis (Claude CLI, Anthropic API, etc.)
 * @param checks - Which stability checks to enable (defaults to DEFAULT_STABILITY.checks)
 * @returns Aggregated findings, file count, and overall score
 */
export async function analyzeStability(
  projectRoot: string,
  changedFiles: string[],
  aiProvider: AIProvider,
  checks?: StabilityCheck[],
): Promise<StabilityResult> {
  const enabledChecks = checks ?? DEFAULT_STABILITY.checks;

  // Step 1: Read and filter source files
  const sourceFiles = await loadSourceFiles(projectRoot, changedFiles);

  if (sourceFiles.length === 0) {
    logger.debug("No source files to analyze for stability");
    return { findings: [], filesScanned: 0, score: 100 };
  }

  logger.debug(
    `Analyzing ${sourceFiles.length} files for stability (checks: ${enabledChecks.join(", ")})`,
  );

  // Step 2: Batch files to respect token limits
  const batches = batchFiles(sourceFiles);
  logger.debug(`Split into ${batches.length} batch(es)`);

  // Step 3: Run AI analysis on each batch
  const allFindings: StabilityFinding[] = [];
  const allScannedFiles: string[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    const batchFiles = batch.map((f) => f.relativePath);
    allScannedFiles.push(...batchFiles);

    try {
      const messages = buildStabilityPrompt(
        batch.map((f) => ({ path: f.relativePath, content: f.content })),
        enabledChecks,
      );

      const response = await aiProvider.generate(messages, {
        temperature: 0.1,
        maxTokens: 8192,
      });

      if (!response.content.trim()) {
        logger.warn(`Stability batch ${i + 1}: AI returned empty response`);
        continue;
      }

      const result = parseStabilityResponse(response.content, batchFiles);
      allFindings.push(...result.findings);

      logger.debug(
        `Batch ${i + 1}: found ${result.findings.length} issue(s)`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      logger.warn(`Stability batch ${i + 1} failed: ${message}`);
      // Continue with remaining batches rather than failing entirely
    }
  }

  // Step 4: Deduplicate findings (AI may report same issue in overlapping contexts)
  const dedupedFindings = deduplicateFindings(allFindings);

  // Step 5: Compute overall score
  const score = computeOverallScore(dedupedFindings);

  return {
    findings: dedupedFindings,
    filesScanned: allScannedFiles.length,
    score,
  };
}

// ─── File Loading ───────────────────────────────────────────

interface LoadedFile {
  relativePath: string;
  content: string;
}

/**
 * Load source files from disk, filtering out non-analyzable files
 * (tests, configs, type declarations, etc.).
 */
async function loadSourceFiles(
  projectRoot: string,
  changedFiles: string[],
): Promise<LoadedFile[]> {
  const loaded: LoadedFile[] = [];

  for (const relativePath of changedFiles) {
    // Skip non-source files
    if (SKIP_PATTERNS.some((pattern) => pattern.test(relativePath))) {
      continue;
    }

    // Only analyze TypeScript/JavaScript source files
    if (!/\.[jt]sx?$/.test(relativePath)) {
      continue;
    }

    try {
      const absolutePath = path.join(projectRoot, relativePath);
      const stat = await fs.stat(absolutePath);

      if (stat.size > MAX_FILE_SIZE) {
        logger.debug(`Skipping oversized file: ${relativePath} (${stat.size} bytes)`);
        continue;
      }

      const content = await fs.readFile(absolutePath, "utf-8");

      // Skip type-only files (files with no runtime code)
      if (isTypeOnlyFile(content)) {
        continue;
      }

      loaded.push({ relativePath, content });
    } catch {
      // File may have been deleted or become unreadable
      logger.debug(`Could not read file: ${relativePath}`);
    }
  }

  return loaded;
}

/**
 * Heuristic check for files that contain only types/interfaces/enums.
 * These have no runtime behavior and are irrelevant for stability analysis.
 */
function isTypeOnlyFile(content: string): boolean {
  // Strip comments and blank lines
  const lines = content
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed.length > 0 &&
        !trimmed.startsWith("//") &&
        !trimmed.startsWith("*") &&
        !trimmed.startsWith("/*")
      );
    });

  if (lines.length === 0) return true;

  // If every non-blank, non-comment line is a type declaration or import,
  // this file has no runtime behavior
  const runtimeIndicators = /(?:^|\s)(?:function|class|const|let|var|export\s+(?:default\s+)?(?:function|class|const|let|async))\b/;
  const typeOnlyIndicators = /^\s*(?:export\s+)?(?:type|interface|enum|import\s+type)/;

  let hasRuntime = false;
  for (const line of lines) {
    if (typeOnlyIndicators.test(line)) continue;
    if (/^\s*(?:import|export)\s/.test(line) && !/export\s+(default\s+)?(?:function|class|const|let|async)/.test(line)) continue;
    if (runtimeIndicators.test(line)) {
      hasRuntime = true;
      break;
    }
  }

  return !hasRuntime;
}

// ─── Batching ───────────────────────────────────────────────

/**
 * Split files into batches that fit within the AI token budget.
 * Files are added greedily until the batch size limit is reached.
 */
function batchFiles(files: LoadedFile[]): LoadedFile[][] {
  const batches: LoadedFile[][] = [];
  let currentBatch: LoadedFile[] = [];
  let currentSize = 0;

  for (const file of files) {
    const fileSize = file.content.length;

    // If adding this file would exceed the limit, start a new batch
    // (unless the batch is empty, in which case add anyway)
    if (currentSize + fileSize > MAX_BATCH_SIZE && currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentSize = 0;
    }

    currentBatch.push(file);
    currentSize += fileSize;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

// ─── Deduplication ──────────────────────────────────────────

/**
 * Remove duplicate findings that have the same file, line, and check.
 * Keeps the first occurrence (highest-priority batch).
 */
function deduplicateFindings(
  findings: StabilityFinding[],
): StabilityFinding[] {
  const seen = new Set<string>();
  const deduped: StabilityFinding[] = [];

  for (const finding of findings) {
    const key = `${finding.file}:${finding.line}:${finding.check}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(finding);
    }
  }

  return deduped;
}

// ─── Scoring ────────────────────────────────────────────────

const SEVERITY_DEDUCTIONS: Record<string, number> = {
  high: 15,
  medium: 8,
  low: 3,
};

/**
 * Compute a 0-100 stability score from deduplicated findings.
 * Consistent with the scoring engine in `src/scoring/engine.ts`.
 */
function computeOverallScore(findings: StabilityFinding[]): number {
  let deduction = 0;
  for (const f of findings) {
    deduction += SEVERITY_DEDUCTIONS[f.severity] ?? 0;
  }
  return Math.max(0, Math.min(100, 100 - deduction));
}
