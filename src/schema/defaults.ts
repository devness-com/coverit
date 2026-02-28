/**
 * Default configuration values for coverit.json
 *
 * These defaults implement the Diamond testing strategy:
 *   Integration ~50%, Unit ~20%, API ~15%, E2E ~10%, Contract ~5%
 *
 * Dimension weights reflect painkiller priority:
 *   Functionality (0.35) > Security (0.25) > Stability (0.15) = Conformance (0.15) > Regression (0.10)
 */

import type {
  DimensionConfig,
  FunctionalityConfig,
  SecurityConfig,
  StabilityConfig,
  ConformanceConfig,
  RegressionConfig,
  CoveritScope,
  ScopeDepth,
  Complexity,
  FunctionalTestType,
} from "./coverit-manifest.js";

// ─── Default Dimension Configuration ────────────────────────

export const DEFAULT_FUNCTIONALITY: FunctionalityConfig = {
  enabled: true,
  weight: 0.35,
  targets: {
    unit: { coverage: "critical-paths" },
    integration: { coverage: "all-boundaries" },
    api: { coverage: "all-endpoints" },
    e2e: { coverage: "critical-journeys" },
    contract: { coverage: "all-public-apis" },
  },
};

export const DEFAULT_SECURITY: SecurityConfig = {
  enabled: true,
  weight: 0.25,
  checks: [
    "injection",
    "auth-bypass",
    "secrets-exposure",
    "xss",
    "insecure-config",
    "data-exposure",
  ],
};

export const DEFAULT_STABILITY: StabilityConfig = {
  enabled: true,
  weight: 0.15,
  checks: [
    "error-handling",
    "edge-cases",
    "resource-cleanup",
    "graceful-degradation",
  ],
};

export const DEFAULT_CONFORMANCE: ConformanceConfig = {
  enabled: true,
  weight: 0.15,
  checks: [
    "pattern-compliance",
    "layer-violations",
    "naming-conventions",
    "dead-code",
  ],
};

export const DEFAULT_REGRESSION: RegressionConfig = {
  enabled: true,
  weight: 0.10,
  strategy: "all-existing-tests-pass",
};

export const DEFAULT_DIMENSIONS: DimensionConfig = {
  functionality: DEFAULT_FUNCTIONALITY,
  security: DEFAULT_SECURITY,
  stability: DEFAULT_STABILITY,
  conformance: DEFAULT_CONFORMANCE,
  regression: DEFAULT_REGRESSION,
};

// ─── Diamond Strategy: Expected Test Counts ─────────────────
// Based on module complexity and the diamond distribution

/**
 * Expected test counts per functional test type, indexed by module complexity.
 *
 * These are per-module defaults. The scale command uses AI to refine
 * these based on actual module content (public methods, endpoints, etc.).
 */
export const EXPECTED_TESTS_BY_COMPLEXITY: Record<
  Complexity,
  Record<FunctionalTestType, number>
> = {
  low: {
    unit: 3,
    integration: 5,
    api: 0,
    e2e: 0,
    contract: 0,
  },
  medium: {
    unit: 6,
    integration: 10,
    api: 4,
    e2e: 0,
    contract: 2,
  },
  high: {
    unit: 12,
    integration: 20,
    api: 8,
    e2e: 2,
    contract: 4,
  },
};

// ─── Scope Depth Configuration ──────────────────────────────

export const SCOPE_DEPTHS: Record<CoveritScope, ScopeDepth> = {
  "first-time": {
    functionality: "generate-and-run",
    security: "scan-all",
    stability: "full",
    conformance: "full",
    regression: "run-all",
    updateManifest: true,
  },
  unstaged: {
    functionality: "show-gaps",
    security: "scan-changed",
    stability: "skip",
    conformance: "skip",
    regression: "skip",
    updateManifest: false,
  },
  staged: {
    functionality: "generate",
    security: "scan-changed",
    stability: "flag-obvious",
    conformance: "skip",
    regression: "skip",
    updateManifest: false,
  },
  branch: {
    functionality: "generate-and-run",
    security: "scan-all",
    stability: "analyze",
    conformance: "analyze",
    regression: "run-all",
    updateManifest: true,
  },
  pr: {
    functionality: "generate-and-run",
    security: "scan-all",
    stability: "analyze",
    conformance: "analyze",
    regression: "run-all",
    updateManifest: true,
  },
  full: {
    functionality: "generate-and-run",
    security: "scan-all",
    stability: "full",
    conformance: "full",
    regression: "run-all",
    updateManifest: true,
  },
  rescale: {
    functionality: "generate-and-run",
    security: "scan-all",
    stability: "full",
    conformance: "full",
    regression: "run-all",
    updateManifest: true,
  },
  files: {
    functionality: "generate-and-run",
    security: "scan-changed",
    stability: "analyze",
    conformance: "skip",
    regression: "skip",
    updateManifest: true,
  },
  ci: {
    functionality: "generate-and-run",
    security: "scan-all",
    stability: "analyze",
    conformance: "analyze",
    regression: "run-all",
    updateManifest: true,
  },
  "measure-only": {
    functionality: "show-gaps",
    security: "skip",
    stability: "skip",
    conformance: "skip",
    regression: "skip",
    updateManifest: true,
  },
};

// ─── Scoring Weights by Test Type ───────────────────────────
// Integration tests are worth 2x because they catch more real bugs

export const TEST_TYPE_WEIGHTS: Record<FunctionalTestType, number> = {
  integration: 2.0,
  e2e: 2.0,
  api: 1.5,
  unit: 1.0,
  contract: 1.0,
};

// ─── Security Severity Weights ──────────────────────────────

export const SECURITY_SEVERITY_POINTS: Record<string, number> = {
  critical: 25,
  high: 15,
  medium: 8,
  low: 3,
};

// ─── Score Thresholds ───────────────────────────────────────

export const SCORE_THRESHOLDS = {
  healthy: 70,
  needsAttention: 50,
  atRisk: 0,
} as const;

export type ScoreHealth = "healthy" | "needs-attention" | "at-risk";

export function getScoreHealth(score: number): ScoreHealth {
  if (score >= SCORE_THRESHOLDS.healthy) return "healthy";
  if (score >= SCORE_THRESHOLDS.needsAttention) return "needs-attention";
  return "at-risk";
}

// ─── Score History Limits ───────────────────────────────────

/** Maximum number of history entries to keep in coverit.json */
export const MAX_SCORE_HISTORY = 30;
