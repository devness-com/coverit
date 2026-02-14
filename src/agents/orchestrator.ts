/**
 * Coverit — Orchestrator
 *
 * Central pipeline engine that coordinates the full test lifecycle:
 * analyze → triage → generate → execute → report.
 *
 * V2 pipeline (AI-first):
 * 1. Collect context — read changed files, find nearby tests, get diff
 * 2. AI triage — lightweight AI call decides what to test
 * 3. AI generate — one AI call per plan, raw source code + existing tests
 * 4. Execute + fix — run tests, retry with AI refinement
 *
 * Each plan is executed independently — a failure in one plan does not
 * block others. Errors are captured per-plan and included in the final report.
 */

import { mkdir, writeFile, readFile, readdir, unlink, rmdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import type {
  CoveritConfig,
  CoveritFixConfig,
  CoveritRecheckConfig,
  CoveritVerifyConfig,
  CoveritEvent,
  CoveritEventHandler,
  CoveritReport,
  ContextBundle,
  TriageResult,
  TriagePlan,
  ExecutionResult,
  GenerationInput,
  TestStrategy,
  TestPlan,
  TestFailure,
  GeneratorResult,
  ExecutionPhase,
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
import { collectContext } from "../analysis/context-collector.js";
import { triageWithAI } from "../analysis/ai-triage.js";
import { AIGenerator } from "../generators/ai-generator.js";
import { createExecutor } from "../executors/index.js";
import { generateReport } from "../agents/reporter.js";
import { detectProjectInfo } from "../utils/framework-detector.js";
import { logger } from "../utils/logger.js";
import {
  createRun,
  resolveRunId,
  getRunDir,
  completeRun,
  updateRunMeta,
} from "../utils/run-manager.js";

const COVERIT_DIR = ".coverit";
const STRATEGY_VERSION = 4; // V4: per-run isolation in .coverit/runs/{runId}/

const MAX_CONCURRENCY = 5;

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

async function updateProgress(
  runDir: string,
  planId: string,
  update: Omit<PlanProgress, "updatedAt">,
): Promise<void> {
  const progressDir = join(runDir, "progress");
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

  if (/^\.coverit\b/m.test(content)) return;

  const suffix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  await writeFile(gitignorePath, `${content}${suffix}\n# coverit\n.coverit/\n`, "utf-8");
}

// ─── Bridge: TriageResult → TestStrategy (for reporter, events, MCP) ────

const ESTIMATED_TESTS_PER_TYPE: Record<string, number> = {
  unit: 5,
  integration: 3,
  api: 4,
  "e2e-browser": 2,
  "e2e-mobile": 2,
  "e2e-desktop": 2,
  snapshot: 1,
  performance: 1,
};

const DURATION_PER_TEST: Record<string, number> = {
  unit: 2,
  integration: 5,
  api: 5,
  "e2e-browser": 10,
  "e2e-mobile": 15,
  "e2e-desktop": 15,
  snapshot: 1,
  performance: 20,
};

function triageToStrategy(
  triage: TriageResult,
  project: CoveritReport["project"],
): TestStrategy {
  // Expand each triage plan into one TestPlan per test type so the
  // reporter, MCP tools, and scan output show the full picture.
  const plans: TestPlan[] = [];
  for (const tp of triage.plans) {
    if (tp.testTypes.length <= 1) {
      const type = tp.testTypes[0] ?? "unit";
      plans.push({
        id: tp.id,
        type,
        target: {
          files: tp.targetFiles,
          functions: [],
          endpoints: [],
          components: [],
        },
        priority: tp.priority,
        description: tp.description,
        estimatedTests: ESTIMATED_TESTS_PER_TYPE[type] ?? 3,
        dependencies: [],
      });
    } else {
      // Multiple test types → expand into separate TestPlans
      for (let i = 0; i < tp.testTypes.length; i++) {
        const type = tp.testTypes[i]!;
        const suffix = i === 0 ? "" : String.fromCharCode(97 + i); // a, b, c...
        plans.push({
          id: `${tp.id}${suffix}`,
          type,
          target: {
            files: tp.targetFiles,
            functions: [],
            endpoints: [],
            components: [],
          },
          priority: tp.priority,
          description: tp.description,
          estimatedTests: ESTIMATED_TESTS_PER_TYPE[type] ?? 3,
          dependencies: i > 0 ? [tp.id] : [], // non-unit plans depend on the first
        });
      }
    }
  }

  // All plans run in a single phase (flat execution)
  const executionOrder: ExecutionPhase[] =
    plans.length > 0
      ? [
          {
            phase: 0,
            plans: plans.map((p) => p.id),
            environment: "local",
          },
        ]
      : [];

  const estimatedDuration = plans.reduce(
    (total, p) =>
      total + p.estimatedTests * (DURATION_PER_TEST[p.type] ?? 5),
    0,
  );

  return {
    project,
    plans,
    executionOrder,
    estimatedDuration,
  };
}

// ─── Internal: run the analysis phase (V2 pipeline) ────────────

async function runDiff(config: CoveritConfig, projectRoot: string) {
  const diffSource = config.diffSource ?? { mode: "auto" };
  switch (diffSource.mode) {
    case "base":
      return analyzeDiff(projectRoot, diffSource.branch);
    case "commit":
      return analyzeDiffForCommit(projectRoot, diffSource.ref);
    case "pr": {
      const prBase = await detectPRBaseBranch(projectRoot, diffSource.number);
      return analyzeDiff(projectRoot, prBase);
    }
    case "files":
      return analyzeDiffForFiles(projectRoot, diffSource.patterns);
    case "staged":
      return analyzeDiffStaged(projectRoot);
    case "auto":
    default:
      return analyzeDiff(projectRoot);
  }
}

/**
 * Runs the full coverit pipeline for a given configuration.
 *
 * V2 Pipeline phases:
 * 1. Diff → Context Collection (read files, find tests)
 * 2. AI Triage (decide what to test)
 * 3. AI Generation + Execution per plan (parallel with concurrency limit)
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

  // ── Run isolation: create or resolve run directory ─────────
  let runId: string;
  let runDir: string;

  if (config.useCache && config.planIds) {
    // Batch execution: resolve existing run
    runId = await resolveRunId(config.projectRoot, {
      runId: config.runId,
      diffSource: config.diffSource,
    });
    runDir = getRunDir(config.projectRoot, runId);
  } else {
    // New run
    const meta = await createRun(config.projectRoot, config.diffSource);
    runId = meta.runId;
    runDir = getRunDir(config.projectRoot, runId);
  }

  // ── AI provider initialization ──────────────────────────────
  let aiProvider: AIProvider | null = null;
  try {
    if (config.ai?.provider) {
      aiProvider = await createAIProvider(config.ai as AIProviderConfig);
    } else {
      aiProvider = await detectBestProvider();
    }
    logger.info(`Using AI provider: ${aiProvider.name}`);
  } catch {
    logger.warn("No AI provider available — falling back to heuristic triage");
  }

  // ── Phase 1: Diff + Context Collection ─────────────────────
  const projectInfo = await detectProjectInfo(config.projectRoot);

  let triage!: TriageResult;
  let context!: ContextBundle;
  let strategy!: TestStrategy;

  const strategyPath = join(runDir, "strategy.json");

  // When useCache is set (batch execution), load previously cached triage
  if (config.useCache && config.planIds) {
    let cacheValid = false;
    try {
      const cached = await readFile(strategyPath, "utf-8");
      const cachedData = JSON.parse(cached) as {
        version?: number;
        triage: TriageResult;
        context: ContextBundle;
      };
      if (cachedData.version === STRATEGY_VERSION) {
        triage = cachedData.triage;
        context = cachedData.context;
        strategy = triageToStrategy(triage, projectInfo);
        cacheValid = true;
        logger.info(`Loaded cached triage v${STRATEGY_VERSION} with ${triage.plans.length} plans`);
        emit(onEvent, { type: "analysis:complete", data: { strategy } });
      } else {
        logger.warn(`Cached triage version mismatch (got ${cachedData.version}, need ${STRATEGY_VERSION}), re-analyzing`);
      }
    } catch (err) {
      logger.warn(`No cached triage found: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!cacheValid) {
      const result = await runAnalysisV2(config, projectInfo, aiProvider);
      triage = result.triage;
      context = result.context;
      strategy = triageToStrategy(triage, projectInfo);
      emit(onEvent, { type: "analysis:start", data: { files: context.changedFiles.length } });
      emit(onEvent, { type: "analysis:complete", data: { strategy } });
      await writeFile(
        strategyPath,
        JSON.stringify({ version: STRATEGY_VERSION, triage, context }, null, 2),
        "utf-8",
      );
    }
  } else {
    const result = await runAnalysisV2(config, projectInfo, aiProvider);
    triage = result.triage;
    context = result.context;
    strategy = triageToStrategy(triage, projectInfo);
    emit(onEvent, { type: "analysis:start", data: { files: context.changedFiles.length } });
    emit(onEvent, { type: "analysis:complete", data: { strategy } });

    await writeFile(
      strategyPath,
      JSON.stringify({ version: STRATEGY_VERSION, triage, context }, null, 2),
      "utf-8",
    );
  }

  // Update run meta with plan count
  await updateRunMeta(config.projectRoot, runId, {
    planCount: triage.plans.length,
  });

  // ── Early return for analyze-only mode (scan command) ──────
  if (config.analyzeOnly) {
    const report = generateReport(projectInfo, strategy, []);
    report.runId = runId;
    report.triageSkipped = triage.skipped;
    emit(onEvent, { type: "report:complete", data: { report } });
    // Don't call completeRun here — it would overwrite meta with 0/0 summary.
    // The meta stays as "running" with correct planCount until batches finalize it.
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
      report.runId = runId;
      emit(onEvent, { type: "report:complete", data: { report } });
      await completeRun(config.projectRoot, runId, report);
      return report;
    }
  }

  // ── Phase 2 & 3: Generation + Execution (flat, parallel) ──
  // Filter plans by planIds when running a specific batch
  const plansToRun = config.planIds
    ? triage.plans.filter((p) => config.planIds!.includes(p.id))
    : triage.plans;

  // Apply test type filter
  const filteredPlans = config.testTypes
    ? plansToRun
        .map((p) => ({
          ...p,
          testTypes: p.testTypes.filter((t) => config.testTypes!.includes(t)),
        }))
        .filter((p) => p.testTypes.length > 0)
    : plansToRun;

  // Execute all plans in parallel with concurrency limit
  const allResults: ExecutionResult[] = [];
  const batches = chunkArray(filteredPlans, MAX_CONCURRENCY);

  for (const batch of batches) {
    const batchResults = await Promise.all(
      batch.map(async (triagePlan) => {
        try {
          return await executePlanV2(triagePlan, {
            config,
            projectInfo,
            context,
            onEvent,
            aiProvider,
            generatedFiles,
            runDir,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`Plan ${triagePlan.id} failed:`, message);
          // Bridge to TestPlan for event
          const testPlan = triagePlanToTestPlan(triagePlan);
          emit(onEvent, { type: "error", data: { message, plan: testPlan } });

          await updateProgress(runDir, triagePlan.id, {
            planId: triagePlan.id,
            status: "error",
            description: triagePlan.description,
          });

          return {
            planId: triagePlan.id,
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

    for (const result of batchResults) {
      if (result) allResults.push(result);
    }
  }

  // ── Phase 4: Reporting ─────────────────────────────────────
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
  report.runId = runId;

  emit(onEvent, { type: "report:complete", data: { report } });

  if (config.planIds && config.planIds.length > 0) {
    // Batch mode: write batch-specific file only (avoid race with parallel batches)
    const batchFile = `batch-${config.planIds[0]}-${config.planIds[config.planIds.length - 1]}.json`;
    await writeFile(
      join(runDir, batchFile),
      JSON.stringify(report, null, 2),
      "utf-8",
    );
  } else {
    // Full run: persist report and update meta
    await completeRun(config.projectRoot, runId, report);
  }

  // ── Cleanup generated test files (opt-in) ──────────────────
  if (config.cleanupTestFiles && generatedFiles.size > 0) {
    const dirsToCheck = new Set<string>();
    for (const filePath of generatedFiles) {
      try {
        await unlink(filePath);
        dirsToCheck.add(dirname(filePath));
      } catch {
        // File may already be gone
      }
    }
    for (const dir of dirsToCheck) {
      try {
        const entries = await readdir(dir);
        if (entries.length === 0) await rmdir(dir);
      } catch {
        // Directory not empty or doesn't exist
      }
    }
  }

  return report;
}

// ─── Fix failing tests from a prior run ──────────────────────

/**
 * Reads previous run results, identifies failed plans, uses AI to
 * refine their test files, and re-executes them.
 */
export async function fixFailingTests(
  config: CoveritFixConfig,
  onEvent?: CoveritEventHandler,
): Promise<CoveritReport> {
  // ── Resolve target run ────────────────────────────────────
  const runId = await resolveRunId(config.projectRoot, {
    runId: config.runId,
  });
  const runDir = getRunDir(config.projectRoot, runId);
  const progressDir = join(runDir, "progress");
  const strategyPath = join(runDir, "strategy.json");

  // ── Load cached triage/strategy ────────────────────────────
  if (!existsSync(strategyPath)) {
    throw new Error(`No strategy found for run ${runId} — run /coverit:run first`);
  }
  const cachedData = JSON.parse(await readFile(strategyPath, "utf-8")) as {
    version?: number;
    triage?: TriageResult;
    // Legacy V2 support
    strategy?: TestStrategy;
  };

  // Support both V4/V3 (triage) and V2 (strategy) cache formats
  let triagePlans: TriagePlan[];
  if (cachedData.triage) {
    triagePlans = cachedData.triage.plans;
  } else if (cachedData.strategy) {
    // Bridge old strategy format
    triagePlans = cachedData.strategy.plans.map((p) => ({
      id: p.id,
      targetFiles: p.target.files,
      testTypes: [p.type],
      existingTestFile: null,
      outputTestFile: "",
      description: p.description,
      priority: p.priority,
      environment: "local" as const,
    }));
  } else {
    throw new Error("Invalid cache format — re-run /coverit:run");
  }

  // ── Load progress files to find failures ────────────────────
  if (!existsSync(progressDir)) {
    throw new Error(`No progress files found for run ${runId} — run /coverit:run first`);
  }
  const progressFiles = await readdir(progressDir);
  const failedPlans: Array<{ progress: PlanProgress; plan: TriagePlan }> = [];

  for (const file of progressFiles) {
    if (!file.endsWith(".json")) continue;
    const progress = JSON.parse(
      await readFile(join(progressDir, file), "utf-8"),
    ) as PlanProgress;

    // Pick up failed, error, AND skipped plans
    if (progress.status !== "failed" && progress.status !== "error" && progress.status !== "skipped") continue;
    if (config.planIds && !config.planIds.includes(progress.planId)) continue;

    const plan = triagePlans.find((p) => p.id === progress.planId);
    if (!plan) continue;

    // For skipped plans, resolve test file from triage plan if not in progress
    if (!progress.testFile && plan.outputTestFile) {
      progress.testFile = plan.outputTestFile;
    }

    failedPlans.push({ progress, plan });
  }

  if (failedPlans.length === 0) {
    const projectInfo = await detectProjectInfo(config.projectRoot);
    const strategy = triageToStrategy({ plans: [], skipped: [] }, projectInfo);
    return generateReport(projectInfo, strategy, []);
  }

  // ── AI provider ─────────────────────────────────────────────
  let aiProvider: AIProvider | null = null;
  try {
    if (config.ai?.provider) {
      aiProvider = await createAIProvider(config.ai as AIProviderConfig);
    } else {
      aiProvider = await detectBestProvider();
    }
    logger.info(`[fix] Using AI provider: ${aiProvider.name}`);
  } catch {
    throw new Error("AI provider required for fix mode but none available");
  }

  // ── Fix loop ────────────────────────────────────────────────
  const maxRetries = config.maxRetries ?? 2;
  const projectInfo = await detectProjectInfo(config.projectRoot);
  const allResults: ExecutionResult[] = [];

  for (const { progress, plan } of failedPlans) {
    const testPlan = triagePlanToTestPlan(plan);
    emit(onEvent, { type: "generation:start", data: { plan: testPlan } });

    const testFilePath = progress.testFile;
    if (!testFilePath) {
      logger.warn(`[fix] Plan ${plan.id}: no test file recorded, skipping`);
      allResults.push({
        planId: plan.id,
        status: "error",
        totalTests: 0, passed: 0, failed: 0, skipped: 0,
        duration: 0, coverage: null, failures: [],
        output: "No test file from prior run",
      });
      continue;
    }

    // Read the current (failing) test file
    const testAbsPath = join(config.projectRoot, testFilePath);
    let testCode: string;
    try {
      testCode = await readFile(testAbsPath, "utf-8");
    } catch {
      logger.warn(`[fix] Plan ${plan.id}: test file not found at ${testFilePath}, skipping`);
      allResults.push({
        planId: plan.id,
        status: "error",
        totalTests: 0, passed: 0, failed: 0, skipped: 0,
        duration: 0, coverage: null, failures: [],
        output: `Test file not found: ${testFilePath}`,
      });
      continue;
    }

    // Read source file being tested
    let sourceCode = "";
    try {
      const sourceFile = plan.targetFiles[0];
      if (sourceFile) {
        sourceCode = await readFile(join(config.projectRoot, sourceFile), "utf-8");
      }
    } catch {
      // Source may be deleted
    }

    // Load failure details from report (if available)
    let lastFailures: TestFailure[] = [];
    try {
      const reportPath = join(runDir, "report.json");
      if (existsSync(reportPath)) {
        const report = JSON.parse(await readFile(reportPath, "utf-8")) as CoveritReport;
        const planResult = report.results.find((r) => r.planId === plan.id);
        if (planResult) lastFailures = planResult.failures;
      }
      // Also check batch reports in run directory
      if (lastFailures.length === 0) {
        const runFiles = await readdir(runDir);
        const batchFiles = runFiles.filter((f) => f.startsWith("batch-") && f.endsWith(".json"));
        for (const bf of batchFiles) {
          const batchReport = JSON.parse(await readFile(join(runDir, bf), "utf-8")) as CoveritReport;
          const planResult = batchReport.results.find((r) => r.planId === plan.id);
          if (planResult && planResult.failures.length > 0) {
            lastFailures = planResult.failures;
            break;
          }
        }
      }
    } catch {
      // No report — failures will be empty
    }

    // ── Set up executor ────────────────────────────────────────
    const generator = new AIGenerator(aiProvider, projectInfo);
    const executor = createExecutor("local");
    if ("setPackageManager" in executor && typeof (executor as any).setPackageManager === "function") {
      (executor as any).setPackageManager(projectInfo.packageManager);
    }
    if ("setProjectRoot" in executor && typeof (executor as any).setProjectRoot === "function") {
      (executor as any).setProjectRoot(config.projectRoot);
    }

    let currentTestCode = testCode;
    let finalResult: ExecutionResult | null = null;

    // For skipped plans with test files on disk, run the test first before trying to fix
    if (progress.status === "skipped") {
      logger.info(`[fix] Plan ${plan.id}: was skipped — executing existing test file first`);
      await updateProgress(runDir, plan.id, {
        planId: plan.id,
        status: "running",
        description: `${plan.description} (executing skipped plan)`,
        testFile: testFilePath,
      });

      const initialExec = await executor.execute(
        {
          planId: plan.id,
          filePath: testFilePath,
          content: currentTestCode,
          testType: plan.testTypes[0] ?? "unit",
          testCount: 0,
          framework: projectInfo.testFramework,
        },
        {
          environment: "local",
          timeout: 120_000,
          retries: 0,
          parallel: false,
          collectCoverage: false,
        },
      );

      emit(onEvent, { type: "execution:complete", data: { result: initialExec } });

      if (initialExec.status === "passed" || initialExec.failures.length === 0) {
        // Tests pass as-is — no fix needed
        finalResult = initialExec;
        const status = initialExec.status === "passed" ? "passed" : "error";
        await updateProgress(runDir, plan.id, {
          planId: plan.id,
          status,
          description: plan.description,
          testFile: testFilePath,
          passed: initialExec.passed,
          failed: initialExec.failed,
          duration: initialExec.duration,
        });
        allResults.push(initialExec);
        continue;
      }

      // Tests failed — proceed to fix loop with actual failures
      lastFailures = initialExec.failures;
    }

    if (lastFailures.length === 0) {
      lastFailures = [{
        testName: testFilePath,
        message: `${progress.failed ?? 0} test(s) failed in previous run`,
      }];
    }

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      await updateProgress(runDir, plan.id, {
        planId: plan.id,
        status: "generating",
        description: `${plan.description} (fix attempt ${attempt + 1}/${maxRetries})`,
        testFile: testFilePath,
      });

      const refined = await generator.refineWithAI({
        testCode: currentTestCode,
        failures: lastFailures,
        sourceCode,
      });

      if (refined) {
        currentTestCode = refined;
        await writeFile(testAbsPath, refined, "utf-8");
      }

      await updateProgress(runDir, plan.id, {
        planId: plan.id,
        status: "running",
        description: `${plan.description} (fix attempt ${attempt + 1}/${maxRetries})`,
        testFile: testFilePath,
      });

      const execResult = await executor.execute(
        {
          planId: plan.id,
          filePath: testFilePath,
          content: currentTestCode,
          testType: plan.testTypes[0] ?? "unit",
          testCount: 0,
          framework: projectInfo.testFramework,
        },
        {
          environment: "local",
          timeout: 120_000,
          retries: 0,
          parallel: false,
          collectCoverage: false,
        },
      );

      emit(onEvent, { type: "execution:complete", data: { result: execResult } });

      if (execResult.status === "passed" || execResult.failures.length === 0) {
        finalResult = execResult;
        break;
      }

      lastFailures = execResult.failures;
      finalResult = execResult;
    }

    const result = finalResult!;
    const status = result.status === "passed" ? "passed" : result.status === "failed" ? "failed" : "error";
    await updateProgress(runDir, plan.id, {
      planId: plan.id,
      status,
      description: plan.description,
      testFile: testFilePath,
      passed: result.passed,
      failed: result.failed,
      duration: result.duration,
    });

    allResults.push(result);
  }

  // ── Report ──────────────────────────────────────────────────
  const fixedTriage: TriageResult = {
    plans: failedPlans.map((fp) => fp.plan),
    skipped: [],
  };
  const fixedStrategy = triageToStrategy(fixedTriage, projectInfo);
  const report = generateReport(projectInfo, fixedStrategy, allResults);
  report.runId = runId;

  emit(onEvent, { type: "report:complete", data: { report } });

  await writeFile(
    join(runDir, "fix-report.json"),
    JSON.stringify(report, null, 2),
    "utf-8",
  );

  // Update meta status after fix
  const s = report.summary;
  await updateRunMeta(config.projectRoot, runId, {
    status: s.status === "all-passed" ? "completed" : "failed",
  });

  return report;
}

// ─── Recheck: re-run existing test files and update status ───

/**
 * Re-runs existing test files from a prior run without AI refinement.
 * Useful after tests have been manually fixed outside the pipeline.
 * Updates progress files and meta status based on actual results.
 */
export async function recheckTests(
  config: CoveritRecheckConfig,
  onEvent?: CoveritEventHandler,
): Promise<CoveritReport> {
  const runId = await resolveRunId(config.projectRoot, {
    runId: config.runId,
  });
  const runDir = getRunDir(config.projectRoot, runId);
  const progressDir = join(runDir, "progress");
  const strategyPath = join(runDir, "strategy.json");

  if (!existsSync(strategyPath)) {
    throw new Error(`No strategy found for run ${runId} — run /coverit:run first`);
  }
  const cachedData = JSON.parse(await readFile(strategyPath, "utf-8")) as {
    version?: number;
    triage?: TriageResult;
    strategy?: TestStrategy;
  };

  let triagePlans: TriagePlan[];
  if (cachedData.triage) {
    triagePlans = cachedData.triage.plans;
  } else if (cachedData.strategy) {
    triagePlans = cachedData.strategy.plans.map((p) => ({
      id: p.id,
      targetFiles: p.target.files,
      testTypes: [p.type],
      existingTestFile: null,
      outputTestFile: "",
      description: p.description,
      priority: p.priority,
      environment: "local" as const,
    }));
  } else {
    throw new Error("Invalid cache format — re-run /coverit:run");
  }

  if (!existsSync(progressDir)) {
    throw new Error(`No progress files found for run ${runId}`);
  }

  const progressFiles = await readdir(progressDir);
  const plansToRecheck: Array<{ progress: PlanProgress; plan: TriagePlan }> = [];

  for (const file of progressFiles) {
    if (!file.endsWith(".json")) continue;
    const progress = JSON.parse(
      await readFile(join(progressDir, file), "utf-8"),
    ) as PlanProgress;

    if (config.planIds && !config.planIds.includes(progress.planId)) continue;

    const plan = triagePlans.find((p) => p.id === progress.planId);
    if (!plan) continue;

    // Resolve test file path
    const testFile = progress.testFile || plan.outputTestFile;
    if (!testFile) continue;

    // Only recheck plans that have a test file on disk
    const testAbsPath = join(config.projectRoot, testFile);
    if (!existsSync(testAbsPath)) continue;

    progress.testFile = testFile;
    plansToRecheck.push({ progress, plan });
  }

  if (plansToRecheck.length === 0) {
    const projectInfo = await detectProjectInfo(config.projectRoot);
    const strategy = triageToStrategy({ plans: [], skipped: [] }, projectInfo);
    return generateReport(projectInfo, strategy, []);
  }

  const projectInfo = await detectProjectInfo(config.projectRoot);
  const allResults: ExecutionResult[] = [];

  for (const { progress, plan } of plansToRecheck) {
    const testFilePath = progress.testFile!;
    const testAbsPath = join(config.projectRoot, testFilePath);
    const testCode = await readFile(testAbsPath, "utf-8");

    const testPlan = triagePlanToTestPlan(plan);
    emit(onEvent, { type: "execution:start", data: { plan: testPlan, environment: plan.environment } });

    await updateProgress(runDir, plan.id, {
      planId: plan.id,
      status: "running",
      description: `${plan.description} (recheck)`,
      testFile: testFilePath,
    });

    const executor = createExecutor("local");
    if ("setPackageManager" in executor && typeof (executor as any).setPackageManager === "function") {
      (executor as any).setPackageManager(projectInfo.packageManager);
    }
    if ("setProjectRoot" in executor && typeof (executor as any).setProjectRoot === "function") {
      (executor as any).setProjectRoot(config.projectRoot);
    }

    const execResult = await executor.execute(
      {
        planId: plan.id,
        filePath: testFilePath,
        content: testCode,
        testType: plan.testTypes[0] ?? "unit",
        testCount: 0,
        framework: projectInfo.testFramework,
      },
      {
        environment: "local",
        timeout: 120_000,
        retries: 0,
        parallel: false,
        collectCoverage: false,
      },
    );

    emit(onEvent, { type: "execution:complete", data: { result: execResult } });

    const status = execResult.status === "passed" ? "passed" : execResult.status === "failed" ? "failed" : "error";
    await updateProgress(runDir, plan.id, {
      planId: plan.id,
      status,
      description: plan.description,
      testFile: testFilePath,
      passed: execResult.passed,
      failed: execResult.failed,
      duration: execResult.duration,
    });

    allResults.push(execResult);
  }

  // Update meta status based on all progress files (not just rechecked ones)
  const allProgress = await readAllProgress(progressDir);
  const hasFailures = allProgress.some((p) => p.status === "failed" || p.status === "error");
  await updateRunMeta(config.projectRoot, runId, {
    status: hasFailures ? "failed" : "completed",
  });

  const recheckTriage: TriageResult = {
    plans: plansToRecheck.map((fp) => fp.plan),
    skipped: [],
  };
  const recheckStrategy = triageToStrategy(recheckTriage, projectInfo);
  const report = generateReport(projectInfo, recheckStrategy, allResults);
  report.runId = runId;

  emit(onEvent, { type: "report:complete", data: { report } });

  return report;
}

async function readAllProgress(progressDir: string): Promise<PlanProgress[]> {
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
      // Skip corrupt files
    }
  }
  return plans;
}

// ─── Verify: run existing test files from a scan ─────────────

/**
 * Runs existing test files that were identified by triage as covering
 * the changed code. Used after /coverit:scan to verify coverage actually passes.
 *
 * Extracts test file paths from triage skipped entries and strategy context,
 * runs them, and reports results.
 */
export async function verifyExistingTests(
  config: CoveritVerifyConfig,
  onEvent?: CoveritEventHandler,
): Promise<CoveritReport> {
  const runId = await resolveRunId(config.projectRoot, {
    runId: config.runId,
  });
  const runDir = getRunDir(config.projectRoot, runId);
  const strategyPath = join(runDir, "strategy.json");

  if (!existsSync(strategyPath)) {
    throw new Error(`No strategy found for run ${runId} — run /coverit:scan first`);
  }

  const cachedData = JSON.parse(await readFile(strategyPath, "utf-8")) as {
    version?: number;
    triage?: TriageResult;
    context?: ContextBundle;
  };

  if (!cachedData.context) {
    throw new Error("No context data in strategy — re-run /coverit:scan");
  }

  // Collect test file paths from existing tests in the context
  const testFilePaths = cachedData.context.existingTests
    .map((t) => t.path)
    .filter((p) => existsSync(join(config.projectRoot, p)));

  if (testFilePaths.length === 0) {
    throw new Error("No existing test files found to verify");
  }

  const projectInfo = await detectProjectInfo(config.projectRoot);
  const allResults: ExecutionResult[] = [];

  // Set up executor
  const executor = createExecutor("local");
  if ("setPackageManager" in executor && typeof (executor as any).setPackageManager === "function") {
    (executor as any).setPackageManager(projectInfo.packageManager);
  }
  if ("setProjectRoot" in executor && typeof (executor as any).setProjectRoot === "function") {
    (executor as any).setProjectRoot(config.projectRoot);
  }

  // Run tests in batches
  const batches = chunkArray(testFilePaths, MAX_CONCURRENCY);

  for (const batch of batches) {
    const batchResults = await Promise.all(
      batch.map(async (testFilePath, idx) => {
        const planId = `verify_${String(allResults.length + idx + 1).padStart(3, "0")}`;

        const testCode = await readFile(join(config.projectRoot, testFilePath), "utf-8");

        const testPlan: TestPlan = {
          id: planId,
          type: "unit",
          target: { files: [testFilePath], functions: [], endpoints: [], components: [] },
          priority: "medium",
          description: `Verify ${testFilePath}`,
          estimatedTests: 1,
          dependencies: [],
        };

        emit(onEvent, { type: "execution:start", data: { plan: testPlan, environment: "local" } });

        const execResult = await executor.execute(
          {
            planId,
            filePath: testFilePath,
            content: testCode,
            testType: "unit",
            testCount: 0,
            framework: projectInfo.testFramework,
          },
          {
            environment: "local",
            timeout: 120_000,
            retries: 0,
            parallel: false,
            collectCoverage: false,
          },
        );

        emit(onEvent, { type: "execution:complete", data: { result: execResult } });
        return execResult;
      }),
    );

    allResults.push(...batchResults);
  }

  // Build report
  const verifyStrategy: TestStrategy = {
    project: projectInfo,
    plans: testFilePaths.map((p, i) => ({
      id: `verify_${String(i + 1).padStart(3, "0")}`,
      type: "unit" as const,
      target: { files: [p], functions: [], endpoints: [], components: [] },
      priority: "medium" as const,
      description: `Verify ${p}`,
      estimatedTests: 1,
      dependencies: [],
    })),
    executionOrder: [{ phase: 0, plans: testFilePaths.map((_, i) => `verify_${String(i + 1).padStart(3, "0")}`), environment: "local" }],
    estimatedDuration: testFilePaths.length * 10,
  };

  const report = generateReport(projectInfo, verifyStrategy, allResults);
  report.runId = runId;

  emit(onEvent, { type: "report:complete", data: { report } });

  // Update meta based on verify results
  const hasFailures = allResults.some((r) => r.status !== "passed");
  await updateRunMeta(config.projectRoot, runId, {
    status: hasFailures ? "failed" : "completed",
  });

  return report;
}

// ─── Internal: V2 analysis pipeline ──────────────────────────

async function runAnalysisV2(
  config: CoveritConfig,
  projectInfo: ReturnType<typeof detectProjectInfo> extends Promise<infer T> ? T : never,
  aiProvider: AIProvider | null,
): Promise<{ triage: TriageResult; context: ContextBundle }> {
  const diffResult = await runDiff(config, config.projectRoot);
  const context = await collectContext(diffResult, config.projectRoot, projectInfo);

  let triage: TriageResult;
  if (aiProvider) {
    triage = await triageWithAI(context, aiProvider, {
      testTypes: config.testTypes,
      projectRoot: config.projectRoot,
    });
  } else {
    logger.error("No AI provider available — cannot triage without AI");
    triage = { plans: [], skipped: [] };
  }

  return { triage, context };
}

// ─── Internal: execute a single TriagePlan (V2) ──────────────

interface PlanExecutionContextV2 {
  config: CoveritConfig;
  projectInfo: TestStrategy["project"];
  context: ContextBundle;
  onEvent?: CoveritEventHandler;
  aiProvider: AIProvider | null;
  generatedFiles: Set<string>;
  runDir: string;
}

async function executePlanV2(
  triagePlan: TriagePlan,
  ctx: PlanExecutionContextV2,
): Promise<ExecutionResult> {
  const { config, projectInfo, context, onEvent, aiProvider, runDir } = ctx;

  // Bridge to TestPlan for events
  const testPlan = triagePlanToTestPlan(triagePlan);

  // ── Generate ───────────────────────────────────────────────
  emit(onEvent, { type: "generation:start", data: { plan: testPlan } });
  await updateProgress(runDir, triagePlan.id, {
    planId: triagePlan.id,
    status: "generating",
    description: triagePlan.description,
  });

  // Build generation input from context
  const sourceFiles = triagePlan.targetFiles.map((targetPath) => {
    const fileCtx = context.changedFiles.find((f) => f.path === targetPath);
    return {
      path: targetPath,
      content: fileCtx?.sourceCode ?? "",
      hunks: fileCtx?.hunks ?? [],
    };
  });

  const existingTest = triagePlan.existingTestFile
    ? context.existingTests.find((t) => t.path === triagePlan.existingTestFile)
    : null;

  const genInput: GenerationInput = {
    plan: triagePlan,
    project: projectInfo,
    sourceFiles,
    existingTestContent: existingTest?.content ?? null,
    testTypes: triagePlan.testTypes,
  };

  const generator = new AIGenerator(aiProvider, projectInfo);
  const genResult: GeneratorResult = await generator.generate(genInput);

  emit(onEvent, { type: "generation:complete", data: { result: genResult } });

  // Write generated test files
  for (const test of genResult.tests) {
    const outPath = join(config.projectRoot, test.filePath);
    await ensureDir(join(outPath, ".."));
    await writeFile(outPath, test.content, "utf-8");
    ctx.generatedFiles.add(outPath);
  }

  // If no tests were generated, retry with simplified prompt before skipping
  if (genResult.tests.length === 0) {
    if (aiProvider) {
      logger.info(`Plan ${triagePlan.id}: initial generation failed, retrying with simplified prompt...`);
      const simplifiedResult = await generator.generateSimplified(genInput);

      if (simplifiedResult.tests.length > 0) {
        // Write the simplified tests and continue to execution
        for (const test of simplifiedResult.tests) {
          const outPath = join(config.projectRoot, test.filePath);
          await ensureDir(join(outPath, ".."));
          await writeFile(outPath, test.content, "utf-8");
          ctx.generatedFiles.add(outPath);
        }
        genResult.tests.push(...simplifiedResult.tests);
        genResult.warnings.push("Used simplified prompt after initial generation failure");
      }
    }

    if (genResult.tests.length === 0) {
      const reason = genResult.warnings.length > 0
        ? genResult.warnings.join("; ")
        : "No tests generated (no testable surface)";
      await updateProgress(runDir, triagePlan.id, {
        planId: triagePlan.id,
        status: "skipped",
        description: triagePlan.description,
        reason,
      });
      return {
        planId: triagePlan.id,
        status: "skipped",
        totalTests: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        duration: 0,
        coverage: null,
        failures: [],
        output: reason,
      };
    }
  }

  if (config.generateOnly || config.skipExecution) {
    await updateProgress(runDir, triagePlan.id, {
      planId: triagePlan.id,
      status: "skipped",
      description: triagePlan.description,
      testFile: genResult.tests[0]?.filePath,
    });
    return {
      planId: triagePlan.id,
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
  const executor = createExecutor(triagePlan.environment);
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
      data: { plan: testPlan, environment: triagePlan.environment },
    });
    await updateProgress(runDir, triagePlan.id, {
      planId: triagePlan.id,
      status: "running",
      description: attempt > 0
        ? `${triagePlan.description} (retry ${attempt}/${maxRetries})`
        : triagePlan.description,
      testFile: currentTests[0]?.filePath,
    });

    // Run all test files for this plan
    const mergedResult: ExecutionResult = {
      planId: triagePlan.id,
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
        environment: triagePlan.environment,
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

    // If all tests passed or no retries left, return
    const isRetryable = mergedResult.status !== "error" && (mergedResult.failures.length > 0 || mergedResult.status === "timeout");
    if (!isRetryable || attempt >= maxRetries) {
      await updateProgress(runDir, triagePlan.id, {
        planId: triagePlan.id,
        status: mergedResult.status === "passed" ? "passed" : mergedResult.status === "failed" ? "failed" : "error",
        description: triagePlan.description,
        testFile: currentTests[0]?.filePath,
        passed: mergedResult.passed,
        failed: mergedResult.failed,
        duration: mergedResult.duration,
      });
      return mergedResult;
    }

    // ── Retry: refine failing tests with AI ───────────────────
    if (!aiProvider) {
      logger.warn(`Plan ${triagePlan.id}: ${mergedResult.failures.length} failure(s) but no AI provider for refinement`);
      await updateProgress(runDir, triagePlan.id, {
        planId: triagePlan.id,
        status: "failed",
        description: triagePlan.description,
        testFile: currentTests[0]?.filePath,
        passed: mergedResult.passed,
        failed: mergedResult.failed,
        duration: mergedResult.duration,
      });
      return mergedResult;
    }

    logger.info(`Plan ${triagePlan.id}: ${mergedResult.failures.length} failure(s), retrying (${attempt + 1}/${maxRetries})...`);

    const refinedTests = [];
    for (const test of currentTests) {
      const testFailures = mergedResult.failures.filter((f) =>
        f.testName.includes(test.filePath) || mergedResult.failures.length <= currentTests.length,
      );

      if (testFailures.length === 0) {
        refinedTests.push(test);
        continue;
      }

      // Read source code for refinement
      let sourceCode = "";
      try {
        const sourceFile = triagePlan.targetFiles[0];
        if (sourceFile) {
          sourceCode = await readFile(join(config.projectRoot, sourceFile), "utf-8");
        }
      } catch {
        // Source file may not exist
      }

      const refined = await generator.refineWithAI({
        testCode: test.content,
        failures: testFailures.length > 0 ? testFailures : mergedResult.failures,
        sourceCode,
      });

      if (refined) {
        const updatedTest = { ...test, content: refined };
        refinedTests.push(updatedTest);
        const outPath = join(config.projectRoot, test.filePath);
        await writeFile(outPath, refined, "utf-8");
        ctx.generatedFiles.add(outPath);
      } else {
        refinedTests.push(test);
      }
    }
    currentTests = refinedTests;
  }

  // Should not reach here
  return {
    planId: triagePlan.id,
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

// ─── Helpers ─────────────────────────────────────────────────

function triagePlanToTestPlan(tp: TriagePlan): TestPlan {
  return {
    id: tp.id,
    type: tp.testTypes[0] ?? "unit",
    target: {
      files: tp.targetFiles,
      functions: [],
      endpoints: [],
      components: [],
    },
    priority: tp.priority,
    description: tp.description,
    estimatedTests: 5,
    dependencies: [],
  };
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
