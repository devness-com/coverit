/**
 * Coverit — Orchestrator
 *
 * Central pipeline engine that coordinates the full test lifecycle:
 * analyze → plan → generate → execute → report.
 *
 * Each plan is executed independently — a failure in one plan does not
 * block others. Errors are captured per-plan and included in the final report.
 */

import { mkdir, writeFile, readFile, readdir, unlink, rmdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
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
const STRATEGY_FILE = "strategy.json";
const PROGRESS_DIR = "progress";
const STRATEGY_VERSION = 2; // Bump when strategy format or planner logic changes

interface PlanProgress {
  planId: string;
  status: "generating" | "running" | "passed" | "failed" | "error" | "skipped";
  description: string;
  testFile?: string;
  passed?: number;
  failed?: number;
  duration?: number;
  updatedAt: string;
}

async function updateProgress(
  coveritDir: string,
  planId: string,
  update: Omit<PlanProgress, "updatedAt">,
): Promise<void> {
  const progressDir = join(coveritDir, PROGRESS_DIR);
  await ensureDir(progressDir);
  const planFile = join(progressDir, `${planId}.json`);
  const entry: PlanProgress = { ...update, updatedAt: new Date().toISOString() };
  await writeFile(planFile, JSON.stringify(entry, null, 2), "utf-8");
}

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

/**
 * Ensures `.coverit` is listed in the project's `.gitignore`.
 * Only touches git-tracked projects (checks for `.git` directory).
 */
async function ensureGitignore(projectRoot: string): Promise<void> {
  if (!existsSync(join(projectRoot, ".git"))) return;

  const gitignorePath = join(projectRoot, ".gitignore");
  let content = "";
  try {
    content = await readFile(gitignorePath, "utf-8");
  } catch {
    // .gitignore doesn't exist yet — we'll create it
  }

  // Check if .coverit is already ignored (handles .coverit, .coverit/, .coverit/*)
  if (/^\.coverit\b/m.test(content)) return;

  const suffix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  await writeFile(gitignorePath, `${content}${suffix}\n# coverit\n.coverit/\n`, "utf-8");
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

// ─── Internal: run the analysis phase ──────────────────────────

async function runAnalysis(
  config: CoveritConfig,
  projectRoot: string,
): Promise<{ strategy: TestStrategy; scanResults: CodeScanResult[]; fileCount: number }> {
  const diffSource = config.diffSource ?? { mode: "auto" };
  let diffResult;
  switch (diffSource.mode) {
    case "base":
      diffResult = await analyzeDiff(projectRoot, diffSource.branch);
      break;
    case "commit":
      diffResult = await analyzeDiffForCommit(projectRoot, diffSource.ref);
      break;
    case "pr": {
      const prBase = await detectPRBaseBranch(projectRoot, diffSource.number);
      diffResult = await analyzeDiff(projectRoot, prBase);
      break;
    }
    case "files":
      diffResult = await analyzeDiffForFiles(projectRoot, diffSource.patterns);
      break;
    case "staged":
      diffResult = await analyzeDiffStaged(projectRoot);
      break;
    case "auto":
    default:
      diffResult = await analyzeDiff(projectRoot);
      break;
  }

  const scannableFiles = diffResult.files.filter((f) => f.status !== "deleted");

  const scanResults: CodeScanResult[] = [];
  for (const changedFile of scannableFiles) {
    try {
      const scanResult = await scanCode(
        join(projectRoot, changedFile.path),
        projectRoot,
      );
      scanResults.push(scanResult);
    } catch (err) {
      logger.warn(`Skipping ${changedFile.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const depGraph = await buildDependencyGraph(projectRoot);

  const strategy = await planStrategy(
    diffResult,
    scanResults,
    depGraph,
    projectRoot,
  );

  return { strategy, scanResults, fileCount: diffResult.files.length };
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
  await ensureGitignore(config.projectRoot);

  // Track generated test files for cleanup
  const generatedFiles = new Set<string>();

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

  let strategy!: TestStrategy;
  let scanResults: CodeScanResult[] = [];

  // When useCache is set (batch execution), load the previously cached strategy
  // instead of re-running analysis. This ensures plan IDs remain stable.
  const strategyPath = join(coveritDir, STRATEGY_FILE);
  if (config.useCache && config.planIds) {
    let cacheValid = false;
    try {
      const cached = await readFile(strategyPath, "utf-8");
      const cachedData = JSON.parse(cached) as { version?: number; strategy: TestStrategy; scanResults: CodeScanResult[] };
      // Only use cache if version matches (prevents stale strategies from old planner logic)
      if (cachedData.version === STRATEGY_VERSION) {
        strategy = cachedData.strategy;
        scanResults = cachedData.scanResults;
        cacheValid = true;
        logger.info(`Loaded cached strategy v${STRATEGY_VERSION} with ${strategy.plans.length} plans`);
        emit(onEvent, { type: "analysis:complete", data: { strategy } });
      } else {
        logger.warn(`Cached strategy version mismatch (got ${cachedData.version}, need ${STRATEGY_VERSION}), re-analyzing`);
      }
    } catch (err) {
      logger.warn(`No cached strategy found: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!cacheValid) {
      const result = await runAnalysis(config, config.projectRoot);
      strategy = result.strategy;
      scanResults = result.scanResults;
      emit(onEvent, { type: "analysis:start", data: { files: result.fileCount } });
      emit(onEvent, { type: "analysis:complete", data: { strategy } });
      // Write new cache with version
      await writeFile(
        strategyPath,
        JSON.stringify({ version: STRATEGY_VERSION, strategy, scanResults }, null, 2),
        "utf-8",
      );
    }
  } else {
    const result = await runAnalysis(config, config.projectRoot);
    strategy = result.strategy;
    scanResults = result.scanResults;
    emit(onEvent, { type: "analysis:start", data: { files: result.fileCount } });
    emit(onEvent, { type: "analysis:complete", data: { strategy } });

    // Cache strategy for batch execution (with version tag)
    await writeFile(
      strategyPath,
      JSON.stringify({ version: STRATEGY_VERSION, strategy, scanResults }, null, 2),
      "utf-8",
    );
  }

  // ── Early return for analyze-only mode (scan command) ──────
  if (config.analyzeOnly) {
    const report = generateReport(projectInfo, strategy, []);
    emit(onEvent, { type: "report:complete", data: { report } });
    return report;
  }

  // ── Preflight: check test runner is available ─────────────
  const preflightExecutor = createExecutor("local");
  if ("preflight" in preflightExecutor && typeof (preflightExecutor as any).preflight === "function") {
    const check = await (preflightExecutor as any).preflight(config.projectRoot, projectInfo.testFramework);
    if (!check.ok) {
      const errorResult: ExecutionResult = {
        planId: "preflight",
        status: "error",
        totalTests: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        duration: 0,
        coverage: null,
        failures: [{ testName: "(preflight)", message: check.error }],
        output: check.error,
      };
      const report = generateReport(projectInfo, strategy, [errorResult]);
      emit(onEvent, { type: "report:complete", data: { report } });
      await writeFile(join(coveritDir, REPORT_FILE), JSON.stringify(report, null, 2), "utf-8");
      return report;
    }
  }

  // ── Phase 2 & 3: Generation + Execution per phase ──────────
  const existingTests = await findExistingTests(config.projectRoot);
  const allResults: ExecutionResult[] = [];

  for (const phase of strategy.executionOrder) {
    // Filter plans by planIds when running a specific batch
    const plansToRun = config.planIds
      ? phase.plans.filter((id) => config.planIds!.includes(id))
      : phase.plans;
    if (plansToRun.length === 0) continue;

    // Plans within a phase can run in parallel
    const phaseResults = await Promise.all(
      plansToRun.map(async (planId) => {
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
            generatedFiles,
          });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : String(err);
          logger.error(`Plan ${plan.id} failed:`, message);
          emit(onEvent, {
            type: "error",
            data: { message, plan },
          });

          // Update progress with error
          await updateProgress(coveritDir, plan.id, {
            planId: plan.id,
            status: "error",
            description: plan.description,
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
  // When running a batch, scope the report to only the executed plans
  const reportStrategy = config.planIds
    ? {
        ...strategy,
        plans: strategy.plans.filter((p) => config.planIds!.includes(p.id)),
        executionOrder: strategy.executionOrder
          .map((phase) => ({ ...phase, plans: phase.plans.filter((id) => config.planIds!.includes(id)) }))
          .filter((phase) => phase.plans.length > 0),
      }
    : strategy;
  const report = generateReport(projectInfo, reportStrategy, allResults);

  emit(onEvent, { type: "report:complete", data: { report } });

  // Persist report — batch runs write to a separate file to avoid overwriting
  // other batches. Full runs write to last-report.json.
  if (config.planIds && config.planIds.length > 0) {
    const batchFile = `batch-${config.planIds[0]}-${config.planIds[config.planIds.length - 1]}.json`;
    await writeFile(
      join(coveritDir, batchFile),
      JSON.stringify(report, null, 2),
      "utf-8",
    );
  } else {
    await writeFile(
      join(coveritDir, REPORT_FILE),
      JSON.stringify(report, null, 2),
      "utf-8",
    );
  }

  // ── Cleanup generated test files ─────────────────────────────
  if (!config.keepTestFiles && generatedFiles.size > 0) {
    const dirsToCheck = new Set<string>();
    for (const filePath of generatedFiles) {
      try {
        await unlink(filePath);
        dirsToCheck.add(dirname(filePath));
      } catch {
        // File may already be gone — skip
      }
    }
    // Remove empty parent directories that coverit may have created
    for (const dir of dirsToCheck) {
      try {
        const entries = await readdir(dir);
        if (entries.length === 0) await rmdir(dir);
      } catch {
        // Directory not empty or doesn't exist — skip
      }
    }
  }

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
  generatedFiles: Set<string>;
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

  const coveritDir = join(config.projectRoot, COVERIT_DIR);

  // ── Generate ───────────────────────────────────────────────
  emit(onEvent, { type: "generation:start", data: { plan } });
  await updateProgress(coveritDir, plan.id, {
    planId: plan.id,
    status: "generating",
    description: plan.description,
  });

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
    ctx.generatedFiles.add(outPath);
  }

  // If no tests were generated, skip execution — don't count as "passed"
  if (genResult.tests.length === 0) {
    await updateProgress(coveritDir, plan.id, {
      planId: plan.id,
      status: "skipped",
      description: plan.description,
    });
    return {
      planId: plan.id,
      status: "skipped",
      totalTests: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
      coverage: null,
      failures: [],
      output: "No tests generated (no testable surface)",
    };
  }

  if (config.generateOnly || config.skipExecution) {
    await updateProgress(coveritDir, plan.id, {
      planId: plan.id,
      status: "skipped",
      description: plan.description,
      testFile: genResult.tests[0]?.filePath,
    });
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

  // ── Execute (with retry loop) ───────────────────────────────
  const maxRetries = config.maxRetries ?? 2;
  const executor = createExecutor(phase.environment);
  // Set the project's package manager and root so the runner uses the correct exec command
  if ("setPackageManager" in executor && typeof (executor as any).setPackageManager === "function") {
    (executor as any).setPackageManager(ctx.projectInfo.packageManager);
  }
  if ("setProjectRoot" in executor && typeof (executor as any).setProjectRoot === "function") {
    (executor as any).setProjectRoot(config.projectRoot);
  }
  let currentTests = genResult.tests;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    emit(onEvent, {
      type: "execution:start",
      data: { plan, environment: phase.environment },
    });
    await updateProgress(coveritDir, plan.id, {
      planId: plan.id,
      status: "running",
      description: attempt > 0
        ? `${plan.description} (retry ${attempt}/${maxRetries})`
        : plan.description,
      testFile: currentTests[0]?.filePath,
    });

    // Run all test files for this plan
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

    for (const test of currentTests) {
      const execResult = await executor.execute(test, {
        environment: phase.environment,
        timeout: 120_000,
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

    emit(onEvent, { type: "execution:complete", data: { result: mergedResult } });

    // If all tests passed or no retries left, return the result
    const isRetryable = mergedResult.status !== "error" && (mergedResult.failures.length > 0 || mergedResult.status === "timeout");
    if (!isRetryable || attempt >= maxRetries) {
      await updateProgress(coveritDir, plan.id, {
        planId: plan.id,
        status: mergedResult.status === "passed" ? "passed" : mergedResult.status === "failed" ? "failed" : "error",
        description: plan.description,
        testFile: currentTests[0]?.filePath,
        passed: mergedResult.passed,
        failed: mergedResult.failed,
        duration: mergedResult.duration,
      });
      return mergedResult;
    }

    // ── Retry: refine failing tests with AI ───────────────────
    if (!aiProvider) {
      // No AI available — can't refine, return as-is
      logger.warn(`Plan ${plan.id}: ${mergedResult.failures.length} failure(s) but no AI provider for refinement`);
      await updateProgress(coveritDir, plan.id, {
        planId: plan.id,
        status: "failed",
        description: plan.description,
        testFile: currentTests[0]?.filePath,
        passed: mergedResult.passed,
        failed: mergedResult.failed,
        duration: mergedResult.duration,
      });
      return mergedResult;
    }

    logger.info(`Plan ${plan.id}: ${mergedResult.failures.length} failure(s), retrying (${attempt + 1}/${maxRetries})...`);

    // For each test file with failures, attempt AI refinement
    const refinedTests = [];
    for (const test of currentTests) {
      const testFailures = mergedResult.failures.filter((f) =>
        f.testName.includes(test.filePath) || mergedResult.failures.length <= currentTests.length
      );

      if (testFailures.length === 0) {
        refinedTests.push(test);
        continue;
      }

      // Read the source file being tested
      let sourceCode = "";
      try {
        const sourceFile = plan.target.files[0];
        if (sourceFile) {
          sourceCode = await readFile(join(config.projectRoot, sourceFile), "utf-8");
        }
      } catch {
        // Source file may not exist (e.g., deleted)
      }

      const refined = await generator.refineWithAI({
        testCode: test.content,
        failures: testFailures.length > 0 ? testFailures : mergedResult.failures,
        sourceCode,
      });

      if (refined) {
        const updatedTest = { ...test, content: refined };
        refinedTests.push(updatedTest);
        // Write refined test file
        const outPath = join(config.projectRoot, test.filePath);
        await writeFile(outPath, refined, "utf-8");
        ctx.generatedFiles.add(outPath);
      } else {
        refinedTests.push(test);
      }
    }
    currentTests = refinedTests;
  }

  // Should not reach here, but return error if it does
  return {
    planId: plan.id,
    status: "error",
    totalTests: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    duration: 0,
    coverage: null,
    failures: [],
    output: "Unexpected: retry loop exited without returning",
  };
}
