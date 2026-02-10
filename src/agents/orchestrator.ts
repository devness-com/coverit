/**
 * Coverit — Orchestrator
 *
 * Central pipeline engine that coordinates the full test lifecycle:
 * analyze → plan → generate → execute → report.
 *
 * Each plan is executed independently — a failure in one plan does not
 * block others. Errors are captured per-plan and included in the final report.
 */

import { mkdir, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  CoveritConfig,
  CoveritEvent,
  CoveritEventHandler,
  CoveritReport,
  CodeScanResult,
  ExecutionResult,
  GeneratorContext,
  TestStrategy,
  TestPlan,
  GeneratorResult,
} from "../types/index.js";
import type { AIProvider, AIProviderConfig } from "../ai/types.js";
import { createAIProvider, detectBestProvider } from "../ai/provider-factory.js";
import {
  analyzeDiff,
  analyzeDiffForCommit,
  analyzeDiffStaged,
  analyzeDiffForFiles,
} from "../analysis/diff-analyzer.js";
import { detectPRBaseBranch } from "../utils/git.js";
import { scanCode } from "../analysis/code-scanner.js";
import { buildDependencyGraph } from "../analysis/dependency-graph.js";
import { planStrategy } from "../analysis/strategy-planner.js";
import { createGenerator } from "../generators/index.js";
import { createExecutor } from "../executors/index.js";
import { generateReport } from "../agents/reporter.js";
import { detectProjectInfo } from "../utils/framework-detector.js";
import { logger } from "../utils/logger.js";

const COVERIT_DIR = ".coverit";
const REPORT_FILE = "last-report.json";

function emit(handler: CoveritEventHandler | undefined, event: CoveritEvent): void {
  if (handler) {
    try {
      handler(event);
    } catch (err) {
      logger.warn("Event handler threw:", err);
    }
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

async function findExistingTests(projectRoot: string): Promise<string[]> {
  const testDirs = ["__tests__", "tests", "test"];
  const found: string[] = [];

  for (const dir of testDirs) {
    try {
      const entries = await readdir(join(projectRoot, dir), {
        recursive: true,
      });
      for (const entry of entries) {
        if (typeof entry === "string" && /\.(test|spec)\.[jt]sx?$/.test(entry)) {
          found.push(join(dir, entry));
        }
      }
    } catch {
      // Directory doesn't exist — skip
    }
  }

  return found;
}

/**
 * Runs the full coverit pipeline for a given configuration.
 *
 * Pipeline phases:
 * 1. Analysis — diff, scan, dependency graph, strategy planning
 * 2. Generation — create test files per plan (parallelized by phase)
 * 3. Execution — run generated tests per plan
 * 4. Reporting — aggregate results and persist
 */
export async function orchestrate(
  config: CoveritConfig,
  onEvent?: CoveritEventHandler,
): Promise<CoveritReport> {
  const coveritDir = join(config.projectRoot, COVERIT_DIR);
  await ensureDir(coveritDir);

  // ── AI provider initialization ──────────────────────────────
  // Attempt to stand up an LLM provider for intelligent test generation.
  // Template-based generation is the automatic fallback when unavailable.
  let aiProvider: AIProvider | null = null;
  try {
    if (config.ai?.provider) {
      aiProvider = await createAIProvider(config.ai as AIProviderConfig);
    } else {
      aiProvider = await detectBestProvider();
    }
    logger.info(`Using AI provider: ${aiProvider.name}`);
  } catch {
    logger.warn("No AI provider available — falling back to template-based generation");
  }

  // ── Phase 1: Analysis ──────────────────────────────────────
  const projectInfo = await detectProjectInfo(config.projectRoot);

  const diffSource = config.diffSource ?? { mode: "auto" };
  let diffResult;
  switch (diffSource.mode) {
    case "base":
      diffResult = await analyzeDiff(config.projectRoot, diffSource.branch);
      break;
    case "commit":
      diffResult = await analyzeDiffForCommit(config.projectRoot, diffSource.ref);
      break;
    case "pr": {
      const prBase = await detectPRBaseBranch(config.projectRoot, diffSource.number);
      diffResult = await analyzeDiff(config.projectRoot, prBase);
      break;
    }
    case "files":
      diffResult = await analyzeDiffForFiles(config.projectRoot, diffSource.patterns);
      break;
    case "staged":
      diffResult = await analyzeDiffStaged(config.projectRoot);
      break;
    case "auto":
    default:
      diffResult = await analyzeDiff(config.projectRoot);
      break;
  }
  emit(onEvent, { type: "analysis:start", data: { files: diffResult.files.length } });

  // Skip deleted files — they can't be scanned
  const scannableFiles = diffResult.files.filter((f) => f.status !== "deleted");

  const scanResults: CodeScanResult[] = [];
  for (const changedFile of scannableFiles) {
    try {
      const scanResult = await scanCode(
        join(config.projectRoot, changedFile.path),
        config.projectRoot,
      );
      scanResults.push(scanResult);
    } catch (err) {
      logger.warn(`Skipping ${changedFile.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const depGraph = await buildDependencyGraph(config.projectRoot);

  const strategy: TestStrategy = await planStrategy(
    diffResult,
    scanResults,
    depGraph,
    config.projectRoot,
  );

  emit(onEvent, { type: "analysis:complete", data: { strategy } });

  // ── Early return for analyze-only mode (scan command) ──────
  if (config.analyzeOnly) {
    const report = generateReport(projectInfo, strategy, []);
    emit(onEvent, { type: "report:complete", data: { report } });
    await writeFile(
      join(coveritDir, REPORT_FILE),
      JSON.stringify(report, null, 2),
      "utf-8",
    );
    return report;
  }

  // ── Phase 2 & 3: Generation + Execution per phase ──────────
  const existingTests = await findExistingTests(config.projectRoot);
  const allResults: ExecutionResult[] = [];

  for (const phase of strategy.executionOrder) {
    // Plans within a phase can run in parallel
    const phaseResults = await Promise.all(
      phase.plans.map(async (planId) => {
        const plan = strategy.plans.find((p) => p.id === planId);
        if (!plan) {
          logger.warn(`Plan ${planId} referenced in phase but not found`);
          return null;
        }

        try {
          return await executePlan(plan, {
            config,
            projectInfo,
            strategy,
            scanResults,
            existingTests,
            phase,
            onEvent,
            aiProvider,
          });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : String(err);
          logger.error(`Plan ${plan.id} failed:`, message);
          emit(onEvent, {
            type: "error",
            data: { message, plan },
          });

          // Return a failure result so the pipeline continues
          return {
            planId: plan.id,
            status: "error" as const,
            totalTests: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            duration: 0,
            coverage: null,
            failures: [],
            output: `Plan execution error: ${message}`,
          };
        }
      }),
    );

    for (const result of phaseResults) {
      if (result) allResults.push(result);
    }
  }

  // ── Phase 4: Reporting ─────────────────────────────────────
  const report = generateReport(projectInfo, strategy, allResults);

  emit(onEvent, { type: "report:complete", data: { report } });

  // Persist report for `coverit report` command
  await writeFile(
    join(coveritDir, REPORT_FILE),
    JSON.stringify(report, null, 2),
    "utf-8",
  );

  return report;
}

// ─── Internal: execute a single TestPlan ──────────────────────

interface PlanExecutionContext {
  config: CoveritConfig;
  projectInfo: TestStrategy["project"];
  strategy: TestStrategy;
  scanResults: CodeScanResult[];
  existingTests: string[];
  phase: TestStrategy["executionOrder"][number];
  onEvent?: CoveritEventHandler;
  aiProvider: AIProvider | null;
}

async function executePlan(
  plan: TestPlan,
  ctx: PlanExecutionContext,
): Promise<ExecutionResult> {
  const {
    config,
    projectInfo,
    scanResults,
    existingTests,
    phase,
    onEvent,
    aiProvider,
  } = ctx;

  // ── Generate ───────────────────────────────────────────────
  emit(onEvent, { type: "generation:start", data: { plan } });

  const generatorCtx: GeneratorContext = {
    plan,
    project: projectInfo,
    scanResults,
    existingTests,
  };

  const generator = createGenerator(plan.type, projectInfo, aiProvider);
  const genResult: GeneratorResult = await generator.generate(generatorCtx);

  emit(onEvent, { type: "generation:complete", data: { result: genResult } });

  // Write generated test files colocated next to source files
  for (const test of genResult.tests) {
    const outPath = join(config.projectRoot, test.filePath);
    await ensureDir(join(outPath, ".."));
    await writeFile(outPath, test.content, "utf-8");
  }

  if (config.generateOnly || config.skipExecution) {
    return {
      planId: plan.id,
      status: "skipped",
      totalTests: genResult.tests.reduce((sum, t) => sum + t.testCount, 0),
      passed: 0,
      failed: 0,
      skipped: genResult.tests.reduce((sum, t) => sum + t.testCount, 0),
      duration: 0,
      coverage: null,
      failures: [],
      output: "Execution skipped (generate-only mode)",
    };
  }

  // ── Execute ────────────────────────────────────────────────
  emit(onEvent, {
    type: "execution:start",
    data: { plan, environment: phase.environment },
  });

  const executor = createExecutor(phase.environment);
  // Execute each generated test and merge results
  const mergedResult: ExecutionResult = {
    planId: plan.id,
    status: "passed",
    totalTests: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    duration: 0,
    coverage: null,
    failures: [],
    output: "",
  };

  for (const test of genResult.tests) {
    const execResult = await executor.execute(test, {
      environment: phase.environment,
      timeout: 60_000,
      retries: 0,
      parallel: false,
      collectCoverage: config.coverageThreshold !== undefined,
      cloudConfig: config.cloudConfig,
    });
    mergedResult.totalTests += execResult.totalTests;
    mergedResult.passed += execResult.passed;
    mergedResult.failed += execResult.failed;
    mergedResult.skipped += execResult.skipped;
    mergedResult.duration += execResult.duration;
    mergedResult.failures.push(...execResult.failures);
    mergedResult.output += execResult.output + "\n";
    if (execResult.coverage) mergedResult.coverage = execResult.coverage;
    if (execResult.status !== "passed") mergedResult.status = execResult.status;
  }

  const execResult = mergedResult;

  emit(onEvent, { type: "execution:complete", data: { result: execResult } });

  return execResult;
}
