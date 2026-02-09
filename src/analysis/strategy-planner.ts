import { resolve, basename } from "path";
import { readFile, access } from "fs/promises";
import fg from "fast-glob";
import type {
  DiffResult,
  CodeScanResult,
  DependencyGraph,
  TestStrategy,
  TestPlan,
  TestType,
  TestTarget,
  ExecutionPhase,
  ExecutionEnvironment,
  ProjectInfo,
  Framework,
  TestFramework,
  PackageManager,

} from "../types/index.js";

// ─── File type → test type mapping ──────────────────────────────

const FILE_TYPE_TEST_MAP: Record<string, TestType[]> = {
  "api-route": ["unit", "api"],
  "api-controller": ["unit", "api"],
  "react-component": ["unit", "e2e-browser"],
  "react-page": ["unit", "e2e-browser"],
  "react-hook": ["unit"],
  service: ["unit"],
  utility: ["unit"],
  "mobile-screen": ["unit", "e2e-mobile"],
  "mobile-component": ["unit", "e2e-mobile"],
  "desktop-window": ["unit", "e2e-desktop"],
  "desktop-component": ["unit", "e2e-desktop"],
  middleware: ["unit", "integration"],
  model: ["unit"],
  schema: ["unit"],
};

// ─── Test type → execution environment mapping ──────────────────

const TEST_TYPE_ENVIRONMENT: Record<TestType, ExecutionEnvironment> = {
  unit: "local",
  integration: "local",
  api: "local",
  "e2e-browser": "browser",
  "e2e-mobile": "mobile-simulator",
  "e2e-desktop": "desktop-app",
  snapshot: "local",
  performance: "cloud-sandbox",
};

// ─── Estimated test counts by file type ─────────────────────────

const ESTIMATED_TESTS_PER_TYPE: Record<TestType, number> = {
  unit: 5,
  integration: 3,
  api: 4,
  "e2e-browser": 2,
  "e2e-mobile": 2,
  "e2e-desktop": 2,
  snapshot: 1,
  performance: 1,
};

// ─── Project detection helpers ──────────────────────────────────

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function detectPackageManager(root: string): Promise<PackageManager> {
  if (await fileExists(resolve(root, "bun.lockb"))) return "bun";
  if (await fileExists(resolve(root, "bun.lock"))) return "bun";
  if (await fileExists(resolve(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(resolve(root, "yarn.lock"))) return "yarn";
  return "npm";
}

async function detectFramework(root: string): Promise<Framework> {
  const pkg = await readJson(resolve(root, "package.json"));
  if (!pkg) return "unknown";

  const deps = {
    ...(pkg["dependencies"] as Record<string, string> | undefined),
    ...(pkg["devDependencies"] as Record<string, string> | undefined),
  };

  // Order matters: more specific frameworks first
  if (deps["@nestjs/core"]) return "nestjs";
  if (deps["next"]) return "next";
  if (deps["expo"]) return "expo";
  if (deps["react-native"]) return "react-native";
  if (deps["@tauri-apps/api"]) return "tauri";
  if (deps["electron"]) return "electron";
  if (deps["hono"]) return "hono";
  if (deps["fastify"]) return "fastify";
  if (deps["express"]) return "express";
  if (deps["react"]) return "react";

  return "none";
}

async function detectTestFramework(root: string): Promise<TestFramework> {
  const pkg = await readJson(resolve(root, "package.json"));
  if (!pkg) return "unknown";

  const deps = {
    ...(pkg["dependencies"] as Record<string, string> | undefined),
    ...(pkg["devDependencies"] as Record<string, string> | undefined),
  };

  if (deps["vitest"]) return "vitest";
  if (deps["jest"] || deps["@jest/core"]) return "jest";
  if (deps["playwright"] || deps["@playwright/test"]) return "playwright";
  if (deps["cypress"]) return "cypress";
  if (deps["detox"]) return "detox";
  if (deps["mocha"]) return "mocha";
  if (deps["pytest"]) return "pytest";

  return "unknown";
}

async function detectExistingTests(
  root: string
): Promise<{ hasTests: boolean; patterns: string[] }> {
  const testFiles = await fg(
    ["**/*.test.{ts,tsx,js,jsx}", "**/*.spec.{ts,tsx,js,jsx}", "**/__tests__/**/*.{ts,tsx,js,jsx}"],
    {
      cwd: root,
      ignore: ["**/node_modules/**", "**/dist/**"],
    }
  );

  const patterns = new Set<string>();
  for (const f of testFiles) {
    if (f.includes(".test.")) patterns.add("*.test.*");
    if (f.includes(".spec.")) patterns.add("*.spec.*");
    if (f.includes("__tests__")) patterns.add("__tests__/");
  }

  return {
    hasTests: testFiles.length > 0,
    patterns: Array.from(patterns),
  };
}

async function detectProjectInfo(root: string): Promise<ProjectInfo> {
  const pkg = await readJson(resolve(root, "package.json"));
  const name = (pkg?.["name"] as string) ?? basename(root);
  const packageManager = await detectPackageManager(root);
  const framework = await detectFramework(root);
  const testFramework = await detectTestFramework(root);
  const { hasTests, patterns } = await detectExistingTests(root);

  // Detect primary language from tsconfig presence
  const hasTsConfig = await fileExists(resolve(root, "tsconfig.json"));

  return {
    name,
    root,
    language: hasTsConfig ? "typescript" : "javascript",
    framework,
    testFramework,
    packageManager,
    hasExistingTests: hasTests,
    existingTestPatterns: patterns,
  };
}

// ─── Plan generation ────────────────────────────────────────────

let planIdCounter = 0;

function generatePlanId(): string {
  planIdCounter++;
  return `plan_${planIdCounter.toString().padStart(3, "0")}`;
}

function determinePriority(
  filePath: string,
  changedFiles: Set<string>,
  graph: DependencyGraph
): TestPlan["priority"] {
  // Directly changed files are critical
  if (changedFiles.has(filePath)) return "critical";

  // Files that directly depend on a changed file are high priority
  const node = graph.get(filePath);
  if (node) {
    for (const dep of node.dependsOn) {
      if (changedFiles.has(dep)) return "high";
    }
  }

  return "medium";
}

function buildTestTarget(
  filePath: string,
  scan: CodeScanResult | undefined
): TestTarget {
  return {
    files: [filePath],
    functions: scan?.functions.filter((f) => f.isExported).map((f) => f.name) ?? [],
    endpoints: scan?.endpoints ?? [],
    components: scan?.components.map((c) => c.name) ?? [],
  };
}

/**
 * Plan a testing strategy based on diff analysis, code scanning, and dependency graph.
 *
 * @param diff - Results from analyzeDiff
 * @param scans - Results from scanCode for each changed file
 * @param graph - Dependency graph from buildDependencyGraph
 * @param projectRoot - Absolute path to the project root
 */
export async function planStrategy(
  diff: DiffResult,
  scans: CodeScanResult[],
  graph: DependencyGraph,
  projectRoot: string
): Promise<TestStrategy> {
  const root = resolve(projectRoot);

  // Reset plan counter for deterministic IDs within a single strategy
  planIdCounter = 0;

  const project = await detectProjectInfo(root);
  const scanMap = new Map<string, CodeScanResult>();
  for (const scan of scans) {
    scanMap.set(scan.file, scan);
  }

  const changedPaths = new Set(diff.files.map((f) => f.path));
  const plans: TestPlan[] = [];

  // Generate plans for each changed file (skip deleted files and test files)
  for (const file of diff.files) {
    if (file.status === "deleted") continue;
    if (file.fileType === "test") continue;
    if (file.fileType === "config" || file.fileType === "style" || file.fileType === "migration") continue;

    const testTypes = FILE_TYPE_TEST_MAP[file.fileType] ?? ["unit"];
    const scan = scanMap.get(file.path);
    const priority = determinePriority(file.path, changedPaths, graph);

    for (const testType of testTypes) {
      const planId = generatePlanId();
      const target = buildTestTarget(file.path, scan);

      // Describe what we're testing
      const targetDesc =
        target.endpoints.length > 0
          ? `${target.endpoints.length} endpoint(s)`
          : target.components.length > 0
            ? `${target.components.length} component(s)`
            : target.functions.length > 0
              ? `${target.functions.length} function(s)`
              : "module";

      plans.push({
        id: planId,
        type: testType,
        target,
        priority,
        description: `${testType} tests for ${file.path} — ${targetDesc}`,
        estimatedTests: ESTIMATED_TESTS_PER_TYPE[testType] ?? 3,
        dependencies: [],
      });
    }
  }

  // Also plan tests for files that depend on changed files (ripple effect)
  for (const file of diff.files) {
    if (file.status === "deleted") continue;

    const node = graph.get(file.path);
    if (!node) continue;

    for (const dependentPath of node.dependedBy) {
      // Skip if already in our changed files or if it's a test file
      if (changedPaths.has(dependentPath)) continue;
      if (/\.(test|spec)\./.test(dependentPath)) continue;

      const depNode = graph.get(dependentPath);
      if (!depNode) continue;

      // Only add unit tests for ripple-effect files
      const planId = generatePlanId();
      plans.push({
        id: planId,
        type: "unit",
        target: {
          files: [dependentPath],
          functions: [],
          endpoints: [],
          components: [],
        },
        priority: "high",
        description: `unit tests for ${dependentPath} (depends on changed file ${file.path})`,
        estimatedTests: 3,
        dependencies: [],
      });
    }
  }

  // Wire up dependencies: integration/api/e2e plans depend on their unit plan for the same file
  const unitPlansByFile = new Map<string, string>();
  for (const plan of plans) {
    if (plan.type === "unit" && plan.target.files.length > 0) {
      unitPlansByFile.set(plan.target.files[0]!, plan.id);
    }
  }

  for (const plan of plans) {
    if (plan.type !== "unit" && plan.target.files.length > 0) {
      const unitPlanId = unitPlansByFile.get(plan.target.files[0]!);
      if (unitPlanId) {
        plan.dependencies.push(unitPlanId);
      }
    }
  }

  // Build execution phases: group non-dependent plans into parallel phases
  const executionOrder = buildExecutionPhases(plans);

  // Estimate total duration (rough: 2s per test for unit, 5s for integration, 10s for e2e)
  const durationPerType: Record<TestType, number> = {
    unit: 2,
    integration: 5,
    api: 5,
    "e2e-browser": 10,
    "e2e-mobile": 15,
    "e2e-desktop": 15,
    snapshot: 1,
    performance: 20,
  };

  const estimatedDuration = plans.reduce(
    (total, plan) =>
      total + plan.estimatedTests * (durationPerType[plan.type] ?? 5),
    0
  );

  return {
    project,
    plans,
    executionOrder,
    estimatedDuration,
  };
}

/**
 * Group test plans into parallel execution phases using topological ordering.
 * Plans with no dependencies run in the earliest phase. Plans with dependencies
 * run in the phase after their last dependency completes.
 */
function buildExecutionPhases(plans: TestPlan[]): ExecutionPhase[] {
  const planMap = new Map<string, TestPlan>();
  for (const plan of plans) {
    planMap.set(plan.id, plan);
  }

  // Compute phase number for each plan
  const phaseAssignment = new Map<string, number>();
  const visited = new Set<string>();

  function getPhase(planId: string): number {
    if (phaseAssignment.has(planId)) return phaseAssignment.get(planId)!;
    if (visited.has(planId)) return 0; // Circular dependency guard

    visited.add(planId);

    const plan = planMap.get(planId);
    if (!plan || plan.dependencies.length === 0) {
      phaseAssignment.set(planId, 0);
      return 0;
    }

    let maxDepPhase = 0;
    for (const depId of plan.dependencies) {
      maxDepPhase = Math.max(maxDepPhase, getPhase(depId) + 1);
    }

    phaseAssignment.set(planId, maxDepPhase);
    return maxDepPhase;
  }

  for (const plan of plans) {
    getPhase(plan.id);
  }

  // Group plans by phase
  const phaseGroups = new Map<number, string[]>();
  for (const [planId, phase] of phaseAssignment) {
    const group = phaseGroups.get(phase) ?? [];
    group.push(planId);
    phaseGroups.set(phase, group);
  }

  // Sort phases and determine environment per phase
  const sortedPhases = Array.from(phaseGroups.entries()).sort(
    ([a], [b]) => a - b
  );

  return sortedPhases.map(([phase, planIds]) => {
    // Determine the heaviest environment needed in this phase
    const environments = planIds
      .map((id) => {
        const plan = planMap.get(id);
        return plan ? TEST_TYPE_ENVIRONMENT[plan.type] : ("local" as const);
      })
      .filter((e): e is ExecutionEnvironment => e !== undefined);

    // Pick the most "heavyweight" environment for the phase
    const envPriority: ExecutionEnvironment[] = [
      "mobile-simulator",
      "desktop-app",
      "browser",
      "cloud-sandbox",
      "local",
    ];
    const environment =
      envPriority.find((e) => environments.includes(e)) ?? "local";

    return {
      phase,
      plans: planIds,
      environment,
    };
  });
}
