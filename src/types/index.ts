/**
 * Coverit — Core Types
 *
 * These types define the contracts between all modules:
 * Analysis → Strategy → Generation → Execution → Reporting
 */

// ─── Analysis Types ──────────────────────────────────────────

export interface DiffResult {
  files: ChangedFile[];
  summary: string;
  baseBranch: string;
  headBranch: string;
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  language: Language;
  fileType: FileType;
}

export interface DiffHunk {
  startLine: number;
  endLine: number;
  content: string;
}

export type Language =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "unknown";

export type FileType =
  | "api-route"
  | "api-controller"
  | "react-component"
  | "react-hook"
  | "react-page"
  | "service"
  | "utility"
  | "model"
  | "schema"
  | "config"
  | "test"
  | "style"
  | "mobile-screen"
  | "mobile-component"
  | "desktop-window"
  | "desktop-component"
  | "middleware"
  | "migration"
  | "unknown";

// ─── Code Scanning Types ─────────────────────────────────────

export interface CodeScanResult {
  file: string;
  language: Language;
  fileType: FileType;
  exports: ExportedSymbol[];
  imports: ImportedModule[];
  functions: FunctionInfo[];
  classes: ClassInfo[];
  endpoints: EndpointInfo[];
  components: ComponentInfo[];
}

export interface ExportedSymbol {
  name: string;
  kind: "function" | "class" | "variable" | "type" | "interface" | "enum";
  isDefault: boolean;
  line: number;
}

export interface ImportedModule {
  source: string;
  specifiers: string[];
  isExternal: boolean;
}

export interface FunctionInfo {
  name: string;
  params: ParamInfo[];
  returnType: string | null;
  isAsync: boolean;
  isExported: boolean;
  line: number;
  complexity: number;
}

export interface ParamInfo {
  name: string;
  type: string | null;
  isOptional: boolean;
  defaultValue: string | null;
}

export interface ClassInfo {
  name: string;
  methods: FunctionInfo[];
  properties: PropertyInfo[];
  isExported: boolean;
  line: number;
}

export interface PropertyInfo {
  name: string;
  type: string | null;
  isPublic: boolean;
}

export interface EndpointInfo {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  handler: string;
  middleware: string[];
  line: number;
}

export interface ComponentInfo {
  name: string;
  props: ParamInfo[];
  hooks: string[];
  isPage: boolean;
  line: number;
}

// ─── Dependency Graph Types ──────────────────────────────────

export interface DependencyNode {
  file: string;
  dependsOn: string[];
  dependedBy: string[];
}

export type DependencyGraph = Map<string, DependencyNode>;

// ─── Strategy Types ──────────────────────────────────────────

export interface TestStrategy {
  project: ProjectInfo;
  plans: TestPlan[];
  executionOrder: ExecutionPhase[];
  estimatedDuration: number;
}

export interface ProjectInfo {
  name: string;
  root: string;
  language: Language;
  framework: Framework;
  testFramework: TestFramework;
  packageManager: PackageManager;
  hasExistingTests: boolean;
  existingTestPatterns: string[];
}

export type Framework =
  | "hono"
  | "express"
  | "nestjs"
  | "next"
  | "react"
  | "react-native"
  | "expo"
  | "tauri"
  | "electron"
  | "fastify"
  | "none"
  | "unknown";

export type TestFramework =
  | "vitest"
  | "jest"
  | "mocha"
  | "playwright"
  | "cypress"
  | "detox"
  | "pytest"
  | "go-test"
  | "unknown";

export type PackageManager = "bun" | "pnpm" | "npm" | "yarn";

export interface TestPlan {
  id: string;
  type: TestType;
  target: TestTarget;
  priority: "critical" | "high" | "medium" | "low";
  description: string;
  estimatedTests: number;
  dependencies: string[];
}

export type TestType =
  | "unit"
  | "integration"
  | "api"
  | "e2e-browser"
  | "e2e-mobile"
  | "e2e-desktop"
  | "snapshot"
  | "performance";

export interface TestTarget {
  files: string[];
  functions: string[];
  endpoints: EndpointInfo[];
  components: string[];
}

export interface ExecutionPhase {
  phase: number;
  plans: string[]; // TestPlan IDs to execute in parallel
  environment: ExecutionEnvironment;
}

export type ExecutionEnvironment =
  | "local"
  | "cloud-sandbox"
  | "browser"
  | "mobile-simulator"
  | "desktop-app";

// ─── AI Triage Types ────────────────────────────────────────

export interface FileContext {
  path: string;
  status: ChangedFile["status"];
  additions: number;
  deletions: number;
  sourceCode: string;
  hunks: DiffHunk[];
}

export interface ExistingTestFile {
  path: string;
  content: string;
  /** Source files this test imports (best-effort regex detection) */
  importsFrom: string[];
}

export interface ContextBundle {
  changedFiles: FileContext[];
  existingTests: ExistingTestFile[];
  project: ProjectInfo;
  diffSummary: string;
}

export interface TriagePlan {
  id: string;
  targetFiles: string[];
  testTypes: TestType[];
  existingTestFile: string | null;
  outputTestFile: string;
  description: string;
  priority: "critical" | "high" | "medium" | "low";
  environment: ExecutionEnvironment;
}

export interface TriageSkipped {
  path: string;
  reason: string;
}

export interface TriageResult {
  plans: TriagePlan[];
  skipped: TriageSkipped[];
}

export interface GenerationInput {
  plan: TriagePlan;
  project: ProjectInfo;
  /** Full source code of target files */
  sourceFiles: Array<{ path: string; content: string; hunks: DiffHunk[] }>;
  /** Full content of existing test file (when extending) */
  existingTestContent: string | null;
  /** Test framework instructions (reused from getTestTypeInstructions) */
  testTypes: TestType[];
}

// ─── Generator Types ─────────────────────────────────────────

export interface GeneratedTest {
  planId: string;
  filePath: string;
  content: string;
  testType: TestType;
  testCount: number;
  framework: TestFramework;
}

export interface GeneratorContext {
  plan: TestPlan;
  project: ProjectInfo;
  scanResults: CodeScanResult[];
  existingTests: string[];
}

export interface GeneratorResult {
  tests: GeneratedTest[];
  warnings: string[];
  skipped: SkippedItem[];
}

export interface SkippedItem {
  target: string;
  reason: string;
}

// ─── Executor Types ──────────────────────────────────────────

export interface ExecutionConfig {
  environment: ExecutionEnvironment;
  timeout: number;
  retries: number;
  parallel: boolean;
  collectCoverage: boolean;
  cloudConfig?: CloudConfig;
}

export interface CloudConfig {
  provider: "e2b" | "docker" | "hetzner";
  image?: string;
  resources?: {
    cpu: number;
    memory: string;
  };
}

export interface ExecutionResult {
  planId: string;
  status: "passed" | "failed" | "error" | "skipped" | "timeout";
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  coverage: CoverageResult | null;
  failures: TestFailure[];
  output: string;
}

export interface CoverageResult {
  lines: CoverageMetric;
  branches: CoverageMetric;
  functions: CoverageMetric;
  statements: CoverageMetric;
}

export interface CoverageMetric {
  total: number;
  covered: number;
  percentage: number;
}

export interface TestFailure {
  testName: string;
  message: string;
  expected?: string;
  actual?: string;
  stack?: string;
}

// ─── Report Types ────────────────────────────────────────────

export interface CoveritReport {
  id: string;
  runId?: string;
  timestamp: string;
  duration: number;
  project: ProjectInfo;
  strategy: TestStrategy;
  results: ExecutionResult[];
  summary: ReportSummary;
}

export interface ReportSummary {
  totalPlans: number;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  errorCount: number;
  coverage: CoverageResult | null;
  status: "all-passed" | "has-failures" | "has-errors";
  testsByType: Record<TestType, TypeSummary>;
}

export interface TypeSummary {
  total: number;
  passed: number;
  failed: number;
  duration: number;
}

// ─── Run Types ───────────────────────────────────────────────

export interface RunMeta {
  runId: string;
  scope: string;
  diffSource?: DiffSource;
  createdAt: string;
  completedAt?: string;
  status: "running" | "completed" | "failed" | "partial";
  planCount: number;
  summary?: {
    totalTests: number;
    passed: number;
    failed: number;
    skipped: number;
    errorCount: number;
    duration: number;
  };
}

// ─── MCP Types ───────────────────────────────────────────────

export type DiffSource =
  | { mode: "auto" }
  | { mode: "base"; branch: string }
  | { mode: "commit"; ref: string }
  | { mode: "pr"; number?: number }
  | { mode: "files"; patterns: string[] }
  | { mode: "staged" };

export interface CoveritConfig {
  projectRoot: string;
  diffSource?: DiffSource;
  targetPaths?: string[];
  testTypes?: TestType[];
  planIds?: string[];
  runId?: string;
  useCache?: boolean;
  maxRetries?: number;
  environment?: ExecutionEnvironment;
  framework?: TestFramework;
  analyzeOnly?: boolean;
  skipExecution?: boolean;
  generateOnly?: boolean;
  cleanupTestFiles?: boolean;
  coverageThreshold?: number;
  cloudConfig?: CloudConfig;
  ai?: {
    provider?: "claude-cli" | "anthropic" | "openai" | "ollama" | "openai-compatible";
    model?: string;
    apiKey?: string;
    baseUrl?: string;
  };
  fixMode?: boolean;
}

export interface CoveritFixConfig {
  projectRoot: string;
  planIds?: string[];
  runId?: string;
  maxRetries?: number;
  ai?: CoveritConfig["ai"];
}

// ─── Event Types (for progress reporting) ────────────────────

export type CoveritEvent =
  | { type: "analysis:start"; data: { files: number } }
  | { type: "analysis:complete"; data: { strategy: TestStrategy } }
  | { type: "generation:start"; data: { plan: TestPlan } }
  | { type: "generation:complete"; data: { result: GeneratorResult } }
  | { type: "execution:start"; data: { plan: TestPlan; environment: ExecutionEnvironment } }
  | { type: "execution:complete"; data: { result: ExecutionResult } }
  | { type: "report:complete"; data: { report: CoveritReport } }
  | { type: "error"; data: { message: string; plan?: TestPlan } };

export type CoveritEventHandler = (event: CoveritEvent) => void;
