/**
 * Coverit Scale — AI-Driven Codebase Analyzer
 *
 * Main entry point for the Scale command. Delegates the entire codebase
 * analysis to an AI with tool access (Glob, Grep, Read, Bash) that
 * explores the project and produces a complete quality manifest.
 *
 * Pipeline:
 *  1. Detect project metadata (framework, language, test runner) — fast, deterministic
 *  2. Send AI prompt with tool access to explore the codebase
 *  3. Parse AI's structured JSON response
 *  4. Assemble the full manifest with scoring
 *
 * The AI performs what was previously done by heuristic code:
 *  - Module detection (replacing module-detector.ts)
 *  - Test mapping (replacing test-mapper.ts)
 *  - Complexity classification (replacing complexity.ts)
 *  - Expected test calculation (replacing expected-counts.ts)
 *  - Plus: journey detection, contract discovery (new AI capabilities)
 */

import type {
  CoveritManifest,
  ModuleEntry,
  FunctionalTestType,
  TestCoverage,
} from "../schema/coverit-manifest.js";
import { DEFAULT_DIMENSIONS } from "../schema/defaults.js";
import { calculateScore } from "../scoring/engine.js";
import { detectProjectInfo } from "../utils/framework-detector.js";
import { createAIProvider } from "../ai/provider-factory.js";
import {
  buildScalePrompt,
  parseScaleResponse,
  type ScaleAIModule,
} from "../ai/scale-prompts.js";
import type { AIProvider } from "../ai/types.js";
import { logger } from "../utils/logger.js";

// ─── Constants ───────────────────────────────────────────────

/** Tools the AI is allowed to use during codebase exploration */
const ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Bash"];

/** 10 minutes — large codebases may take a while to explore */
const ANALYSIS_TIMEOUT_MS = 600_000;

// ─── Core Logic ──────────────────────────────────────────────

/**
 * Analyzes an entire codebase using AI and produces a quality manifest.
 *
 * The AI explores the project using Glob, Grep, Read, and Bash tools,
 * then produces a structured analysis covering:
 *  - Module boundaries and their source files
 *  - Existing test coverage per module
 *  - Complexity assessment per module
 *  - Expected test counts (Diamond testing strategy)
 *  - Critical user journeys and API contracts
 *
 * @param projectRoot - Absolute path to the project root
 * @param aiProvider - Optional AI provider (auto-detected if not provided)
 */
export async function analyzeCodebase(
  projectRoot: string,
  aiProvider?: AIProvider,
): Promise<CoveritManifest> {
  logger.debug(`Analyzing codebase at ${projectRoot} (AI-driven)`);

  // Step 1: Detect project metadata (fast, deterministic)
  const projectInfo = await detectProjectInfo(projectRoot);
  logger.debug(
    `Detected: ${projectInfo.framework} / ${projectInfo.testFramework}`,
  );

  // Step 2: Initialize AI provider
  const provider = aiProvider ?? (await createAIProvider());
  logger.debug(`Using AI provider: ${provider.name}`);

  // Step 3: Build prompt and call AI with tool access
  const messages = buildScalePrompt(projectInfo);

  logger.debug("Sending analysis prompt to AI with tool access...");
  const response = await provider.generate(messages, {
    allowedTools: ALLOWED_TOOLS,
    cwd: projectRoot,
    timeoutMs: ANALYSIS_TIMEOUT_MS,
  });

  logger.debug(
    `AI analysis complete (${response.content.length} chars, model: ${response.model})`,
  );

  // Step 4: Parse AI response
  const aiResult = parseScaleResponse(response.content);
  logger.debug(
    `Parsed: ${aiResult.modules.length} modules, ${aiResult.journeys.length} journeys, ${aiResult.contracts.length} contracts`,
  );

  // Step 5: Assemble full manifest
  const now = new Date().toISOString();

  const modules: ModuleEntry[] = aiResult.modules.map(aiModuleToEntry);

  // Use AI-reported totals, falling back to aggregation from modules
  const totalSourceFiles =
    aiResult.sourceFiles > 0
      ? aiResult.sourceFiles
      : modules.reduce((sum, m) => sum + m.files, 0);
  const totalSourceLines =
    aiResult.sourceLines > 0
      ? aiResult.sourceLines
      : modules.reduce((sum, m) => sum + m.lines, 0);

  const preliminary: CoveritManifest = {
    version: 1,
    createdAt: now,
    updatedAt: now,

    project: {
      name: projectInfo.name,
      root: projectRoot,
      language: projectInfo.language,
      framework: projectInfo.framework,
      testFramework: projectInfo.testFramework,
      sourceFiles: totalSourceFiles,
      sourceLines: totalSourceLines,
    },

    dimensions: DEFAULT_DIMENSIONS,
    modules,

    journeys: aiResult.journeys.map((j) => ({
      id: j.id,
      name: j.name,
      steps: j.steps,
      covered: j.covered,
      testFile: j.testFile,
    })),

    contracts: aiResult.contracts.map((c) => ({
      endpoint: c.endpoint,
      method: c.method,
      requestSchema: c.requestSchema,
      responseSchema: c.responseSchema,
      covered: c.covered,
      testFile: c.testFile,
    })),

    score: {
      overall: 0,
      breakdown: {
        functionality: 0,
        security: 0,
        stability: 0,
        conformance: 0,
        regression: 0,
      },
      gaps: {
        total: 0,
        critical: 0,
        byDimension: {
          functionality: { missing: 0, priority: "none" },
          security: { issues: 0, priority: "pending-ai-scan" },
          stability: { gaps: 0, priority: "pending-ai-scan" },
          conformance: { violations: 0, priority: "pending-ai-scan" },
        },
      },
      history: [],
      // Only functionality has been scanned at this point
      scanned: { functionality: now },
    },
  };

  // Use the scoring engine for consistent scoring
  const scoreResult = calculateScore(preliminary);

  const manifest: CoveritManifest = {
    ...preliminary,
    score: {
      ...scoreResult,
      history: [
        {
          date: now,
          score: scoreResult.overall,
          scope: "first-time",
        },
      ],
    },
  };

  return manifest;
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Convert an AI module response to a full ModuleEntry with
 * placeholder values for AI-dependent dimensions (security, stability, conformance).
 */
function aiModuleToEntry(aiModule: ScaleAIModule): ModuleEntry {
  const tests: Partial<Record<FunctionalTestType, TestCoverage>> = {};
  const validTypes = new Set<FunctionalTestType>([
    "unit",
    "integration",
    "api",
    "e2e",
    "contract",
  ]);

  for (const [testType, coverage] of Object.entries(
    aiModule.functionality.tests,
  )) {
    if (!validTypes.has(testType as FunctionalTestType)) continue;
    tests[testType as FunctionalTestType] = {
      expected: coverage.expected,
      current: coverage.current,
      files: coverage.files,
    };
  }

  return {
    path: aiModule.path,
    files: aiModule.files,
    lines: aiModule.lines,
    complexity: aiModule.complexity,
    functionality: { tests },
    // AI-dependent dimensions — initialized with neutral placeholders
    security: { issues: 0, resolved: 0, findings: [] },
    stability: { score: 0, gaps: [] },
    conformance: { score: 0, violations: [] },
  };
}
