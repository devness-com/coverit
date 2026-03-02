/**
 * Coverit Manifest Schema — `coverit.json`
 *
 * The persistent, git-tracked quality standard for a project.
 * Maps to ISO/IEC 25010:2023 quality characteristics.
 *
 * Three sections:
 *   1. Config (dimensions) — what quality means for this project
 *   2. Inventory (modules, journeys, contracts) — what the codebase contains
 *   3. Score — where the project stands
 */

import type { TestFramework, Framework, Language } from "../types/index.js";

// ─── Top-Level Manifest ─────────────────────────────────────

export interface CoveritManifest {
  /** Schema version for migration support */
  version: 1;
  createdAt: string;
  updatedAt: string;

  /** Project metadata */
  project: ManifestProject;

  /** Quality dimension configuration — what to measure and how */
  dimensions: DimensionConfig;

  /** Module inventory — what the codebase contains */
  modules: ModuleEntry[];

  /** Critical user journeys requiring E2E coverage */
  journeys: JourneyEntry[];

  /** Public API contracts requiring schema validation */
  contracts: ContractEntry[];

  /** Computed quality score */
  score: ScoreResult;
}

export interface ManifestProject {
  name: string;
  root: string;
  language: Language;
  framework: Framework;
  testFramework: TestFramework;
  /** Total source files (excluding tests, configs, etc.) */
  sourceFiles: number;
  /** Total lines of source code */
  sourceLines: number;
  /** Git commit SHA at time of last successful scan (for auto-incremental) */
  lastScanCommit?: string;
}

// ─── Dimension Configuration ────────────────────────────────
// Maps to ISO/IEC 25010:2023 quality characteristics

export interface DimensionConfig {
  /** ISO 25010: Functional Suitability */
  functionality: FunctionalityConfig;
  /** ISO 25010: Security */
  security: SecurityConfig;
  /** ISO 25010: Reliability */
  stability: StabilityConfig;
  /** ISO 25010: Maintainability */
  conformance: ConformanceConfig;
  /** ISO 25010: Functional Suitability + Reliability */
  regression: RegressionConfig;
}

export interface FunctionalityConfig {
  enabled: boolean;
  weight: number;
  /** Diamond strategy targets — coverage approach per test type */
  targets: {
    unit: { coverage: "critical-paths" | "all-public" | "all" };
    integration: { coverage: "all-boundaries" | "critical-paths" | "all" };
    api: { coverage: "all-endpoints" | "critical-endpoints" };
    e2e: { coverage: "critical-journeys" | "all-journeys" };
    contract: { coverage: "all-public-apis" | "external-apis" };
  };
}

export interface SecurityConfig {
  enabled: boolean;
  weight: number;
  /** OWASP-mapped checks to perform */
  checks: SecurityCheck[];
}

export type SecurityCheck =
  | "injection"
  | "auth-bypass"
  | "secrets-exposure"
  | "xss"
  | "insecure-config"
  | "dependency-vulns"
  | "data-exposure"
  | "ssrf"
  | "cryptographic-failures"
  | "insecure-deserialization";

export interface StabilityConfig {
  enabled: boolean;
  weight: number;
  checks: StabilityCheck[];
}

export type StabilityCheck =
  | "error-handling"
  | "edge-cases"
  | "resource-cleanup"
  | "graceful-degradation"
  | "timeout-handling"
  | "concurrent-access";

export interface ConformanceConfig {
  enabled: boolean;
  weight: number;
  checks: ConformanceCheck[];
}

export type ConformanceCheck =
  | "pattern-compliance"
  | "layer-violations"
  | "naming-conventions"
  | "dead-code"
  | "architectural-drift";

export interface RegressionConfig {
  enabled: boolean;
  weight: number;
  strategy: "all-existing-tests-pass" | "critical-tests-pass";
}

// ─── Module Inventory ───────────────────────────────────────

export interface ModuleEntry {
  /** Directory path relative to project root (e.g., "src/services") */
  path: string;
  /** Number of source files in this module */
  files: number;
  /** Total lines of code */
  lines: number;
  /** Complexity classification */
  complexity: Complexity;

  /** Functionality dimension — test coverage by type */
  functionality: ModuleFunctionality;
  /** Security dimension — issues found */
  security: ModuleSecurity;
  /** Stability dimension — reliability assessment */
  stability: ModuleStability;
  /** Conformance dimension — pattern compliance */
  conformance: ModuleConformance;

  /** Per-file breakdown for high-complexity modules */
  critical?: CriticalFileEntry[];
}

export type Complexity = "low" | "medium" | "high";

export interface ModuleFunctionality {
  /** Test coverage by type: expected vs current count */
  tests: Partial<Record<FunctionalTestType, TestCoverage>>;
}

/** Test types that generate test files (subset of TestType) */
export type FunctionalTestType = "unit" | "integration" | "api" | "e2e" | "contract";

export interface TestCoverage {
  /** How many tests should exist based on complexity and diamond strategy */
  expected: number;
  /** How many tests currently exist */
  current: number;
  /** Paths to existing test files covering this module */
  files: string[];
}

export interface ModuleSecurity {
  /** Total unresolved security issues */
  issues: number;
  /** Issues that have been addressed */
  resolved: number;
  /** Specific findings (e.g., "injection:booking.service.ts:142") */
  findings: string[];
}

export interface ModuleStability {
  /** 0-100 score for this module's reliability */
  score: number;
  /** Specific gaps (e.g., "no error handling in processRefund") */
  gaps: string[];
}

export interface ModuleConformance {
  /** 0-100 score for this module's pattern compliance */
  score: number;
  /** Specific violations (e.g., "layer-violation: imports from controller") */
  violations: string[];
}

/** Per-file detail for critical/complex files within a module */
export interface CriticalFileEntry {
  file: string;
  /** Public method/function count */
  methods: number;
  lines: number;
  /** Current test counts by type */
  tests: Partial<Record<FunctionalTestType, number>>;
  /** Security flags on this file */
  securityFlags: SecurityCheck[];
  /** Methods that are critical business paths */
  criticalPaths: string[];
}

// ─── Journeys (E2E) ────────────────────────────────────────

export interface JourneyEntry {
  id: string;
  /** Human-readable description (e.g., "Search -> Book -> Pay -> Confirm") */
  name: string;
  /** Ordered steps in the journey */
  steps: string[];
  /** Whether this journey has E2E test coverage */
  covered: boolean;
  /** Path to the E2E test file, if covered */
  testFile: string | null;
}

// ─── Contracts (API Schema Validation) ──────────────────────

export interface ContractEntry {
  /** API endpoint (e.g., "POST /api/bookings") */
  endpoint: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Request body schema/DTO name */
  requestSchema: string | null;
  /** Response body schema/DTO name */
  responseSchema: string | null;
  /** Whether this contract has validation tests */
  covered: boolean;
  /** Path to contract test file */
  testFile: string | null;
}

// ─── Score ──────────────────────────────────────────────────

export interface ScoreResult {
  /** Overall quality score: 0-100 */
  overall: number;
  /** Per-dimension scores */
  breakdown: DimensionScores;
  /** Summary of what's missing */
  gaps: GapSummary;
  /** Score history for trend tracking (kept in git) */
  history: ScoreHistoryEntry[];
  /**
   * Tracks which dimensions have been actively scanned.
   * Value is the ISO date of the last scan.
   * Unscanned dimensions are excluded from the overall weighted score
   * and shown as "pending" in the dashboard.
   */
  scanned?: Partial<Record<Dimension, string>>;
}

export interface DimensionScores {
  functionality: number;
  security: number;
  stability: number;
  conformance: number;
  regression: number;
}

export type Dimension = keyof DimensionScores;

export interface GapSummary {
  /** Total number of missing items across all dimensions */
  total: number;
  /** Number of critical-priority gaps */
  critical: number;
  /** Per-dimension gap details */
  byDimension: {
    functionality: { missing: number; priority: string };
    security: { issues: number; priority: string };
    stability: { gaps: number; priority: string };
    conformance: { violations: number; priority: string };
  };
}

export interface ScoreHistoryEntry {
  date: string;
  score: number;
  scope: string;
}

// ─── Scope Types ────────────────────────────────────────────

export type CoveritScope =
  | "first-time"
  | "unstaged"
  | "staged"
  | "branch"
  | "pr"
  | "full"
  | "rescale"
  | "files"
  | "ci"
  | "measure-only";

/** What depth of analysis to perform per scope */
export interface ScopeDepth {
  functionality: "show-gaps" | "generate" | "generate-and-run";
  security: "skip" | "scan-changed" | "scan-all";
  stability: "skip" | "flag-obvious" | "analyze" | "full";
  conformance: "skip" | "analyze" | "full";
  regression: "skip" | "run-all";
  updateManifest: boolean;
}
