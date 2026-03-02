/**
 * Coverit — Public API
 *
 * Re-exports the core functions and types for programmatic usage.
 */

// Core pipeline functions
export { scanCodebase, ALL_DIMENSIONS } from "./scale/analyzer.js";
export type { ScanOptions, ScanDimension } from "./scale/analyzer.js";
export { cover } from "./cover/pipeline.js";
export type { CoverOptions, CoverResult } from "./cover/pipeline.js";
export { runTests } from "./run/pipeline.js";
export type { RunOptions, RunResult } from "./run/pipeline.js";

// Manifest I/O
export { readManifest, writeManifest } from "./scale/writer.js";

// Scoring
export { rescoreManifest } from "./measure/scorer.js";
export { scanTests } from "./measure/scanner.js";

// Schema types
export type {
  CoveritManifest,
  ModuleEntry,
  ManifestProject,
  ScoreResult,
  DimensionScores,
  GapSummary,
  FunctionalTestType,
  Complexity,
  TestCoverage,
  JourneyEntry,
  ContractEntry,
} from "./schema/coverit-manifest.js";

// AI provider
export { createAIProvider } from "./ai/provider-factory.js";
export type { AIProvider, AIMessage, AIResponse } from "./ai/types.js";

// Utilities
export {
  detectFramework,
  detectTestFramework,
  detectPackageManager,
  detectProjectInfo,
} from "./utils/framework-detector.js";

export { logger } from "./utils/logger.js";

export { mapFilesToModules, getHeadCommit, getFilesSinceCommit } from "./utils/git.js";
