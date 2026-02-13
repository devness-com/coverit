/**
 * Coverit — AI Triage
 *
 * Replaces strategy-planner.ts. Single lightweight AI call decides
 * what tests to write. Falls back to path-based heuristics when
 * no AI provider is available.
 */

import { basename, dirname, extname, join } from "node:path";
import type { AIProvider } from "../ai/types.js";
import type {
  ContextBundle,
  TestType,
  TriageResult,
  TriagePlan,
  TriageSkipped,
  ExecutionEnvironment,
} from "../types/index.js";
import { buildTriagePrompt, parseTriageResponse } from "../ai/triage-prompts.js";
import { logger } from "../utils/logger.js";

/**
 * Use AI to decide what tests to write for the given context.
 */
export async function triageWithAI(
  context: ContextBundle,
  aiProvider: AIProvider,
  options?: { testTypes?: TestType[] },
): Promise<TriageResult> {
  try {
    const messages = buildTriagePrompt(context, options);
    const response = await aiProvider.generate(messages, {
      temperature: 0.1,
      maxTokens: 4096,
    });

    const result = parseTriageResponse(response.content);

    // Validate and filter plans
    if (result.plans.length === 0 && context.changedFiles.length > 0) {
      logger.warn("AI triage returned no plans, falling back to heuristics");
      return triageFallback(context, options);
    }

    // Apply test type filter if specified
    if (options?.testTypes && options.testTypes.length > 0) {
      const allowed = new Set(options.testTypes);
      result.plans = result.plans
        .map((plan) => ({
          ...plan,
          testTypes: plan.testTypes.filter((t) => allowed.has(t)),
        }))
        .filter((plan) => plan.testTypes.length > 0);
    }

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`AI triage failed: ${msg}, falling back to heuristics`);
    return triageFallback(context, options);
  }
}

// ─── File type → test type mapping (simplified from old strategy-planner) ────

const PATH_TEST_MAP: Array<[RegExp, TestType[]]> = [
  [/\/routes?\/|\/api\//, ["unit", "api"]],
  [/\/controllers?\//, ["unit", "api"]],
  [/\/middleware\//, ["unit"]],
  [/\/components?\/|\.tsx$/, ["unit"]],
  [/\/pages?\/|\/screens?\//, ["unit"]],
  [/\/hooks?\//, ["unit"]],
  [/\/services?\//, ["unit"]],
  [/\/utils?\/|\/helpers?\//, ["unit"]],
  [/\/models?\/|\/entities\//, ["unit"]],
  [/\/schemas?\//, ["unit"]],
];

const SKIP_PATTERNS = [
  /\.(test|spec)\.[jt]sx?$/,
  /\.(css|scss|sass|less|styl)$/,
  /\.(ya?ml|json|toml|ini|env)$/,
  /\.(config|rc)\.[^/]+$/,
  /\/config\//,
  /\/migrations?\//,
  /docker/i,
  /Makefile/,
  /\.d\.ts$/,
];

const TYPE_ENVIRONMENT: Record<TestType, ExecutionEnvironment> = {
  unit: "local",
  integration: "local",
  api: "local",
  "e2e-browser": "browser",
  "e2e-mobile": "mobile-simulator",
  "e2e-desktop": "desktop-app",
  snapshot: "local",
  performance: "cloud-sandbox",
};

/**
 * Fallback triage using path-based heuristics (no AI needed).
 */
export function triageFallback(
  context: ContextBundle,
  options?: { testTypes?: TestType[] },
): TriageResult {
  const plans: TriagePlan[] = [];
  const skipped: TriageSkipped[] = [];
  let planCounter = 0;

  for (const file of context.changedFiles) {
    const normalized = file.path.replace(/\\/g, "/");

    // Skip non-testable files
    if (SKIP_PATTERNS.some((p) => p.test(normalized))) {
      skipped.push({ path: file.path, reason: "Non-testable file type" });
      continue;
    }

    // Determine test types from path
    let testTypes: TestType[] = ["unit"]; // default
    for (const [pattern, types] of PATH_TEST_MAP) {
      if (pattern.test(normalized)) {
        testTypes = types;
        break;
      }
    }

    // Apply filter
    if (options?.testTypes && options.testTypes.length > 0) {
      testTypes = testTypes.filter((t) => options.testTypes!.includes(t));
      if (testTypes.length === 0) {
        skipped.push({ path: file.path, reason: "Filtered out by test type selection" });
        continue;
      }
    }

    // Check for existing test file
    const existingTest = context.existingTests.find((t) =>
      t.importsFrom.some((imp) => imp.includes(basename(file.path, extname(file.path)))),
    );

    // Generate output test file path
    const dir = dirname(file.path);
    const ext = extname(file.path);
    const name = basename(file.path, ext);
    const outputTestFile = existingTest?.path ?? join(dir, `${name}.test${ext}`);

    planCounter++;
    const environment = testTypes.reduce<ExecutionEnvironment>(
      (env, type) => {
        const typeEnv = TYPE_ENVIRONMENT[type] ?? "local";
        // Pick the "heaviest" environment
        if (typeEnv !== "local" && env === "local") return typeEnv;
        return env;
      },
      "local",
    );

    plans.push({
      id: `plan_${String(planCounter).padStart(3, "0")}`,
      targetFiles: [file.path],
      testTypes,
      existingTestFile: existingTest?.path ?? null,
      outputTestFile,
      description: `${testTypes.join(" + ")} tests for ${file.path}`,
      priority: "critical",
      environment,
    });
  }

  return { plans, skipped };
}
