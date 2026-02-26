/**
 * Runtime validation for coverit.json using Zod.
 *
 * Validates manifest files loaded from disk and ensures
 * they conform to the expected schema before use.
 */

import { z } from "zod";
import type { CoveritManifest } from "./coverit-manifest.js";

// ─── Zod Schemas ────────────────────────────────────────────

const SecurityCheckSchema = z.enum([
  "injection",
  "auth-bypass",
  "secrets-exposure",
  "xss",
  "insecure-config",
  "dependency-vulns",
  "data-exposure",
  "ssrf",
  "cryptographic-failures",
  "insecure-deserialization",
]);

const StabilityCheckSchema = z.enum([
  "error-handling",
  "edge-cases",
  "resource-cleanup",
  "graceful-degradation",
  "timeout-handling",
  "concurrent-access",
]);

const ConformanceCheckSchema = z.enum([
  "pattern-compliance",
  "layer-violations",
  "naming-conventions",
  "dead-code",
  "architectural-drift",
]);

const CoverageApproach = z.enum([
  "critical-paths",
  "all-public",
  "all",
  "all-boundaries",
  "all-endpoints",
  "critical-endpoints",
  "critical-journeys",
  "all-journeys",
  "all-public-apis",
  "external-apis",
]);

const FunctionalityConfigSchema = z.object({
  enabled: z.boolean(),
  weight: z.number().min(0).max(1),
  targets: z.object({
    unit: z.object({ coverage: CoverageApproach }),
    integration: z.object({ coverage: CoverageApproach }),
    api: z.object({ coverage: CoverageApproach }),
    e2e: z.object({ coverage: CoverageApproach }),
    contract: z.object({ coverage: CoverageApproach }),
  }),
});

const SecurityConfigSchema = z.object({
  enabled: z.boolean(),
  weight: z.number().min(0).max(1),
  checks: z.array(SecurityCheckSchema),
});

const StabilityConfigSchema = z.object({
  enabled: z.boolean(),
  weight: z.number().min(0).max(1),
  checks: z.array(StabilityCheckSchema),
});

const ConformanceConfigSchema = z.object({
  enabled: z.boolean(),
  weight: z.number().min(0).max(1),
  checks: z.array(ConformanceCheckSchema),
});

const RegressionConfigSchema = z.object({
  enabled: z.boolean(),
  weight: z.number().min(0).max(1),
  strategy: z.enum(["all-existing-tests-pass", "critical-tests-pass"]),
});

const DimensionConfigSchema = z.object({
  functionality: FunctionalityConfigSchema,
  security: SecurityConfigSchema,
  stability: StabilityConfigSchema,
  conformance: ConformanceConfigSchema,
  regression: RegressionConfigSchema,
});

const TestCoverageSchema = z.object({
  expected: z.number().int().min(0),
  current: z.number().int().min(0),
  files: z.array(z.string()),
});

const ModuleFunctionalitySchema = z.object({
  tests: z.record(z.string(), TestCoverageSchema).optional().default({}),
});

const ModuleSecuritySchema = z.object({
  issues: z.number().int().min(0),
  resolved: z.number().int().min(0),
  findings: z.array(z.string()),
});

const ModuleStabilitySchema = z.object({
  score: z.number().min(0).max(100),
  gaps: z.array(z.string()),
});

const ModuleConformanceSchema = z.object({
  score: z.number().min(0).max(100),
  violations: z.array(z.string()),
});

const CriticalFileEntrySchema = z.object({
  file: z.string(),
  methods: z.number().int().min(0),
  lines: z.number().int().min(0),
  tests: z.record(z.string(), z.number().int().min(0)).optional().default({}),
  securityFlags: z.array(SecurityCheckSchema),
  criticalPaths: z.array(z.string()),
});

const ModuleEntrySchema = z.object({
  path: z.string(),
  files: z.number().int().min(0),
  lines: z.number().int().min(0),
  complexity: z.enum(["low", "medium", "high"]),
  functionality: ModuleFunctionalitySchema,
  security: ModuleSecuritySchema,
  stability: ModuleStabilitySchema,
  conformance: ModuleConformanceSchema,
  critical: z.array(CriticalFileEntrySchema).optional(),
});

const JourneyEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  steps: z.array(z.string()),
  covered: z.boolean(),
  testFile: z.string().nullable(),
});

const ContractEntrySchema = z.object({
  endpoint: z.string(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  requestSchema: z.string().nullable(),
  responseSchema: z.string().nullable(),
  covered: z.boolean(),
  testFile: z.string().nullable(),
});

const DimensionScoresSchema = z.object({
  functionality: z.number().min(0).max(100),
  security: z.number().min(0).max(100),
  stability: z.number().min(0).max(100),
  conformance: z.number().min(0).max(100),
  regression: z.number().min(0).max(100),
});

const GapSummarySchema = z.object({
  total: z.number().int().min(0),
  critical: z.number().int().min(0),
  byDimension: z.object({
    functionality: z.object({ missing: z.number().int().min(0), priority: z.string() }),
    security: z.object({ issues: z.number().int().min(0), priority: z.string() }),
    stability: z.object({ gaps: z.number().int().min(0), priority: z.string() }),
    conformance: z.object({ violations: z.number().int().min(0), priority: z.string() }),
  }),
});

const ScoreHistoryEntrySchema = z.object({
  date: z.string(),
  score: z.number().min(0).max(100),
  scope: z.string(),
});

const ScannedDimensionsSchema = z.record(
  z.enum(["functionality", "security", "stability", "conformance", "regression"]),
  z.string(),
).optional();

const ScoreResultSchema = z.object({
  overall: z.number().min(0).max(100),
  breakdown: DimensionScoresSchema,
  gaps: GapSummarySchema,
  history: z.array(ScoreHistoryEntrySchema),
  scanned: ScannedDimensionsSchema,
});

const ManifestProjectSchema = z.object({
  name: z.string(),
  root: z.string(),
  language: z.string(),
  framework: z.string(),
  testFramework: z.string(),
  sourceFiles: z.number().int().min(0),
  sourceLines: z.number().int().min(0),
});

export const CoveritManifestSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  project: ManifestProjectSchema,
  dimensions: DimensionConfigSchema,
  modules: z.array(ModuleEntrySchema),
  journeys: z.array(JourneyEntrySchema),
  contracts: z.array(ContractEntrySchema),
  score: ScoreResultSchema,
});

// ─── Validation Functions ───────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  manifest: CoveritManifest | null;
  errors: string[];
}

/**
 * Validate a parsed JSON object against the coverit manifest schema.
 */
export function validateManifest(data: unknown): ValidationResult {
  const result = CoveritManifestSchema.safeParse(data);

  if (result.success) {
    return {
      valid: true,
      manifest: result.data as CoveritManifest,
      errors: [],
    };
  }

  const errors = result.error.issues.map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`
  );

  return {
    valid: false,
    manifest: null,
    errors,
  };
}

/**
 * Validate that dimension weights sum to approximately 1.0.
 */
export function validateWeights(dimensions: z.infer<typeof DimensionConfigSchema>): string[] {
  const errors: string[] = [];
  const totalWeight =
    dimensions.functionality.weight +
    dimensions.security.weight +
    dimensions.stability.weight +
    dimensions.conformance.weight +
    dimensions.regression.weight;

  if (Math.abs(totalWeight - 1.0) > 0.01) {
    errors.push(
      `Dimension weights sum to ${totalWeight.toFixed(2)}, expected ~1.0. ` +
      `Scores will still compute but may not reflect intended priorities.`
    );
  }

  return errors;
}
