/**
 * Coverit — Public API
 *
 * Re-exports the orchestrator, types, and utility modules
 * for programmatic usage as a library.
 */

// Core orchestrator
export { orchestrate } from "./agents/orchestrator.js";

// All types
export type {
  // Analysis
  DiffResult,
  ChangedFile,
  DiffHunk,
  Language,
  FileType,
  CodeScanResult,
  ExportedSymbol,
  ImportedModule,
  FunctionInfo,
  ParamInfo,
  ClassInfo,
  PropertyInfo,
  EndpointInfo,
  ComponentInfo,
  // Dependency graph
  DependencyNode,
  DependencyGraph,
  // Strategy
  TestStrategy,
  ProjectInfo,
  Framework,
  TestFramework,
  PackageManager,
  TestPlan,
  TestType,
  TestTarget,
  ExecutionPhase,
  ExecutionEnvironment,
  // AI Triage (V2)
  ContextBundle,
  FileContext,
  ExistingTestFile,
  TriagePlan,
  TriageResult,
  GenerationInput,
  // Generator
  GeneratedTest,
  GeneratorContext,
  GeneratorResult,
  SkippedItem,
  // Executor
  ExecutionConfig,
  CloudConfig,
  ExecutionResult,
  CoverageResult,
  CoverageMetric,
  TestFailure,
  // Report
  CoveritReport,
  ReportSummary,
  TypeSummary,
  // Run isolation
  RunMeta,
  // Config & events
  CoveritConfig,
  CoveritFixConfig,
  CoveritEvent,
  CoveritEventHandler,
} from "./types/index.js";

// Utilities for advanced usage
export {
  getChangedFiles,
  getDiff,
  getCurrentBranch,
  getBaseBranch,
  isGitRepo,
  getStagedFiles,
} from "./utils/git.js";

export {
  detectFramework,
  detectTestFramework,
  detectPackageManager,
  detectProjectInfo,
} from "./utils/framework-detector.js";

export { logger } from "./utils/logger.js";

export {
  createRun,
  resolveRunId,
  getRunDir,
  listRuns,
  getRunStatus,
  completeRun,
  updateRunMeta,
  deriveScope,
} from "./utils/run-manager.js";
