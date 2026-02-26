/**
 * Coverit — Conformance Analyzer
 *
 * AI-powered analysis of code pattern compliance and architectural
 * consistency. Examines source files against the project's established
 * patterns (detected by pattern-detector.ts) to identify:
 *
 *   - Pattern compliance violations (not following DI, error handling patterns)
 *   - Layer boundary violations (controller importing repository)
 *   - Naming convention mismatches
 *   - Dead/unreachable code
 *   - Architectural drift (new patterns conflicting with established ones)
 *
 * Maps to ISO/IEC 25010:2023 "Maintainability" quality characteristic.
 *
 * Pipeline:
 *   1. Detect established patterns (static analysis, no AI)
 *   2. Read changed source files
 *   3. Batch files and send to AI with detected patterns as context
 *   4. Parse and aggregate findings
 *   5. Compute overall conformance score
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { AIProvider } from "../ai/types.js";
import type { ConformanceCheck } from "../schema/coverit-manifest.js";
import { DEFAULT_CONFORMANCE } from "../schema/defaults.js";
import { detectPatterns, type DetectedPatterns } from "./pattern-detector.js";
import {
  buildConformancePrompt,
  parseConformanceResponse,
  type ConformanceFinding,
  type ConformanceResult,
} from "../ai/conformance-prompts.js";
import { logger } from "../utils/logger.js";

export type { ConformanceFinding, ConformanceResult, DetectedPatterns };

// ─── Configuration ──────────────────────────────────────────

/** Maximum combined content size per AI batch (bytes) */
const MAX_BATCH_SIZE = 60_000;

/** Maximum individual file size to include in analysis */
const MAX_FILE_SIZE = 50_000;

/** Files matching these patterns are excluded from conformance analysis */
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
 * Analyze changed files for conformance to project patterns.
 *
 * First runs pattern detection (static, no AI) to understand the
 * project's conventions, then sends files to AI for evaluation
 * against those conventions.
 *
 * @param projectRoot - Absolute path to the project root
 * @param changedFiles - Relative paths of files to analyze
 * @param aiProvider - AI provider for analysis
 * @param checks - Which conformance checks to enable (defaults to DEFAULT_CONFORMANCE.checks)
 * @returns Findings, file count, overall score, and detected patterns
 */
export async function analyzeConformance(
  projectRoot: string,
  changedFiles: string[],
  aiProvider: AIProvider,
  checks?: ConformanceCheck[],
): Promise<ConformanceResult & { patterns: DetectedPatterns }> {
  const enabledChecks = checks ?? DEFAULT_CONFORMANCE.checks;

  // Step 1: Detect project patterns (static analysis)
  const patterns = await detectPatterns(projectRoot);
  logger.debug(
    `Detected patterns: DI=${patterns.dependencyInjection}, layers=${patterns.layerArchitecture}, ` +
    `files=${patterns.namingConventions.files}, framework=[${patterns.frameworkPatterns.join(", ")}]`,
  );

  // Step 2: Load source files
  const sourceFiles = await loadSourceFiles(projectRoot, changedFiles);

  if (sourceFiles.length === 0) {
    logger.debug("No source files to analyze for conformance");
    return { findings: [], filesScanned: 0, score: 100, patterns };
  }

  logger.debug(
    `Analyzing ${sourceFiles.length} files for conformance (checks: ${enabledChecks.join(", ")})`,
  );

  // Step 3: Batch and analyze
  const batches = batchFiles(sourceFiles);
  logger.debug(`Split into ${batches.length} batch(es)`);

  const allFindings: ConformanceFinding[] = [];
  const allScannedFiles: string[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    const batchFilePaths = batch.map((f) => f.relativePath);
    allScannedFiles.push(...batchFilePaths);

    try {
      const messages = buildConformancePrompt(
        batch.map((f) => ({ path: f.relativePath, content: f.content })),
        enabledChecks,
        patterns,
      );

      const response = await aiProvider.generate(messages, {
        temperature: 0.1,
        maxTokens: 8192,
      });

      if (!response.content.trim()) {
        logger.warn(`Conformance batch ${i + 1}: AI returned empty response`);
        continue;
      }

      const result = parseConformanceResponse(
        response.content,
        batchFilePaths,
      );
      allFindings.push(...result.findings);

      logger.debug(
        `Batch ${i + 1}: found ${result.findings.length} violation(s)`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      logger.warn(`Conformance batch ${i + 1} failed: ${message}`);
    }
  }

  // Step 4: Deduplicate
  const dedupedFindings = deduplicateFindings(allFindings);

  // Step 5: Score
  const score = computeOverallScore(dedupedFindings);

  return {
    findings: dedupedFindings,
    filesScanned: allScannedFiles.length,
    score,
    patterns,
  };
}

// ─── File Loading ───────────────────────────────────────────

interface LoadedFile {
  relativePath: string;
  content: string;
}

/**
 * Load source files from disk, filtering out non-analyzable files.
 */
async function loadSourceFiles(
  projectRoot: string,
  changedFiles: string[],
): Promise<LoadedFile[]> {
  const loaded: LoadedFile[] = [];

  for (const relativePath of changedFiles) {
    if (SKIP_PATTERNS.some((pattern) => pattern.test(relativePath))) {
      continue;
    }

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
      loaded.push({ relativePath, content });
    } catch {
      logger.debug(`Could not read file: ${relativePath}`);
    }
  }

  return loaded;
}

// ─── Batching ───────────────────────────────────────────────

/**
 * Split files into batches that fit within the AI token budget.
 */
function batchFiles(files: LoadedFile[]): LoadedFile[][] {
  const batches: LoadedFile[][] = [];
  let currentBatch: LoadedFile[] = [];
  let currentSize = 0;

  for (const file of files) {
    const fileSize = file.content.length;

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
 * Remove duplicate findings (same file, line, and check type).
 */
function deduplicateFindings(
  findings: ConformanceFinding[],
): ConformanceFinding[] {
  const seen = new Set<string>();
  const deduped: ConformanceFinding[] = [];

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
 * Compute a 0-100 conformance score from deduplicated findings.
 */
function computeOverallScore(findings: ConformanceFinding[]): number {
  let deduction = 0;
  for (const f of findings) {
    deduction += SEVERITY_DEDUCTIONS[f.severity] ?? 0;
  }
  return Math.max(0, Math.min(100, 100 - deduction));
}
