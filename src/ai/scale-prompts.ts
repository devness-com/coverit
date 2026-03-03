/**
 * Coverit Scale — AI-Driven Analysis Prompts
 *
 * Builds the prompt for the AI to perform a comprehensive codebase analysis.
 * The AI gets tool access (Glob, Grep, Read, Bash) and explores the project
 * to produce a complete module inventory with test coverage mapping.
 *
 * This replaces all heuristic code (module-detector, test-mapper, complexity,
 * expected-counts) with a single intelligent AI analysis pass.
 */

import type { AIMessage } from "./types.js";
import type { ProjectInfo } from "../types/index.js";
import type { CoveritManifest } from "../schema/coverit-manifest.js";
import { logger } from "../utils/logger.js";

// ─── Types ───────────────────────────────────────────────────

/**
 * The structured JSON the AI must return.
 * Parsed and validated by the analyzer before assembly into a full manifest.
 */
export interface ScaleAIResponse {
  sourceFiles: number;
  sourceLines: number;
  /** AI-detected language (overrides deterministic detection if present) */
  language?: string;
  /** AI-detected framework (overrides deterministic detection if present) */
  framework?: string;
  /** AI-detected test framework (overrides deterministic detection if present) */
  testFramework?: string;
  modules: ScaleAIModule[];
  journeys: ScaleAIJourney[];
  contracts: ScaleAIContract[];
}

export interface ScaleAIModule {
  path: string;
  files: number;
  lines: number;
  complexity: "low" | "medium" | "high";
  functionality: {
    tests: Record<
      string,
      { expected: number; current: number; files: string[] }
    >;
  };
}

export interface ScaleAIJourney {
  id: string;
  name: string;
  steps: string[];
  covered: boolean;
  testFile: string | null;
}

export interface ScaleAIContract {
  endpoint: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  requestSchema: string | null;
  responseSchema: string | null;
  covered: boolean;
  testFile: string | null;
}

// ─── Shared Prompt Constants ────────────────────────────────

const MODULE_DETECTION_RULES = `## Module Detection Rules

- Group source files by their logical directory boundary
- For projects with a \`src/\` directory: use the second-level directory as module boundary (e.g., \`src/services\`, \`src/controllers\`)
- Files directly in \`src/\` form the \`src\` module
- For monorepos with \`packages/\`: each package is a top-level module, with sub-modules inside
- EXCLUDE from source: \`node_modules\`, \`dist\`, \`build\`, \`.coverit\`, \`.git\`, \`.next\`, coverage, test-only directories (\`test/\`, \`tests/\`, \`e2e/\`, \`__tests__/\`)
- EXCLUDE config files at root (jest.config.*, tsconfig.*, etc.) from source file counts
- Only count source code files: .ts, .tsx, .js, .jsx, .mjs, .mts`;

const COMPLEXITY_CLASSIFICATION = `## Complexity Classification

Assess each module's complexity by reading its code, not just counting lines:

- **low**: Simple utilities, pure functions, few dependencies, straightforward logic. Typically < 500 lines AND < 5 files, but use judgment.
- **medium**: Moderate business logic, some external dependencies, moderate branching. Typically 500-2000 lines AND 5-15 files.
- **high**: Complex business logic, many dependencies, I/O operations, state management, error handling, financial/security-sensitive logic. Typically > 2000 lines OR > 15 files, but also includes smaller modules with high domain complexity.`;

const DIAMOND_TESTING_STRATEGY = `## Diamond Testing Strategy

The Diamond inverts the traditional test pyramid, prioritizing integration tests:

| Test Type     | Weight | Description |
|---------------|--------|-------------|
| Integration   | ~50%   | Tests with real dependencies (DB, DI containers, services) |
| Unit          | ~20%   | Tests with all dependencies mocked |
| API           | ~15%   | Tests making HTTP requests (supertest, etc.) |
| E2E           | ~10%   | Tests simulating user interactions (Playwright, Cypress) |
| Contract      | ~5%    | Tests validating API schemas and contracts |

### Expected Test Counts by Complexity

Use these as baselines, but adjust based on what you observe in the actual code:

**Low complexity modules:**
- unit: 3, integration: 5, api: 0, e2e: 0, contract: 0

**Medium complexity modules:**
- unit: 6, integration: 10, api: 4, e2e: 0, contract: 2

**High complexity modules:**
- unit: 12, integration: 20, api: 8, e2e: 2, contract: 4

Adjust these counts based on what makes sense for the module:
- Modules with API endpoints need api tests even if they're low complexity
- Modules with no external dependencies don't need integration tests
- Only service/business-logic modules need unit tests proportional to their public methods
- Controller/route modules need api tests rather than unit tests`;

const TEST_CLASSIFICATION = `## Test Classification

When you find test files, classify them by reading their content:

- **unit**: Tests that mock all external dependencies (jest.mock, vi.mock, sinon stubs)
- **integration**: Tests that use real DI containers, databases, or service layers (NestJS \`createTestingModule\`, Prisma client, Drizzle, TypeORM \`getRepository\`)
- **api**: Tests that make HTTP requests to the app (\`supertest\`, \`request(app)\`, \`httpService\`)
- **e2e**: Tests that simulate browser/UI interactions (\`playwright\`, \`page.goto\`, \`cypress\`, \`browser.newPage\`)
- **contract**: Tests that validate API schemas (\`pactum\`, schema validation, contract testing)

Count actual test cases by counting \`it(\` and \`test(\` calls (excluding commented-out lines).`;

const OUTPUT_FORMAT = `## Output Format

Return ONLY a valid JSON object with no surrounding markdown, no explanation, no commentary. The JSON must match this exact structure:

{
  "language": "<primary language: typescript, javascript, python, go, rust, java, etc.>",
  "framework": "<primary framework: nestjs, hono, fastify, express, next, react, expo, tauri, none, etc.>",
  "testFramework": "<primary test framework: vitest, jest, playwright, cypress, mocha, pytest, etc.>",
  "sourceFiles": <total source files across all modules>,
  "sourceLines": <total lines of source code>,
  "modules": [
    {
      "path": "<module directory relative to project root, e.g. 'src/services'>",
      "files": <number of source files>,
      "lines": <total lines of code>,
      "complexity": "low" | "medium" | "high",
      "functionality": {
        "tests": {
          "<testType>": {
            "expected": <how many tests should exist>,
            "current": <how many tests currently exist>,
            "files": ["<relative path to test file>", ...]
          }
        }
      }
    }
  ],
  "journeys": [
    {
      "id": "j<n>",
      "name": "<human-readable flow description>",
      "steps": ["<step 1>", "<step 2>", ...],
      "covered": <boolean>,
      "testFile": "<path or null>"
    }
  ],
  "contracts": [
    {
      "endpoint": "<METHOD /path>",
      "method": "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      "requestSchema": "<DTO name or null>",
      "responseSchema": "<response type or null>",
      "covered": <boolean>,
      "testFile": "<path or null>"
    }
  ]
}

IMPORTANT:
- Only include test types in a module's "tests" object if the expected count is > 0 OR current count is > 0.
- All file paths must be relative to the project root.
- The "tests" field maps test type strings to coverage objects. Valid types: "unit", "integration", "api", "e2e", "contract".
- Return ONLY the JSON. No markdown code fences. No explanatory text before or after.`;

// ─── Prompt Builder ─────────────────────────────────────────

/**
 * Build the AI prompt for codebase analysis.
 *
 * The system prompt explains the methodology, schemas, and classification
 * criteria. The user prompt provides project-specific context.
 *
 * The AI will use Glob, Grep, Read, and Bash tools to explore the codebase
 * and produce a structured JSON manifest.
 */
export function buildScalePrompt(
  projectInfo: ProjectInfo,
  existingManifest?: CoveritManifest,
): AIMessage[] {
  const system = `You are a senior QA architect performing a comprehensive codebase analysis.

You have access to Glob, Grep, Read, and Bash tools. Use them to explore the codebase thoroughly before producing your analysis.

## Your Task

Analyze the project and produce a JSON quality manifest. You MUST explore the actual code — do not guess from file names alone.

## Workflow

1. **Discover structure**: Use Glob to find all source files. Identify the top-level directories and understand the project's module organization.
2. **Identify modules**: Group source files into logical modules. A module is a cohesive directory of source files sharing a responsibility (e.g., \`src/services\`, \`src/controllers\`, \`src/utils\`).
3. **Assess complexity**: Read representative files in each module to understand their complexity. Don't just count lines — consider business logic density, dependency count, I/O operations, state management.
4. **Find existing tests**: Use Glob to find all test files (*.test.*, *.spec.*, __tests__/, etc.). Read them to classify their type and count test cases.
5. **Map tests to modules**: Match each test file to the source module it covers based on file paths, imports, and the code being tested.
6. **Calculate expected tests**: Based on each module's complexity and the Diamond testing strategy, determine how many tests of each type should exist.
7. **Identify journeys**: Look for critical user flows that span multiple modules (for E2E testing). Check if E2E tests already cover them.
8. **Identify contracts**: Find API endpoints (routes, controllers) and check if contract/schema validation tests exist.

${MODULE_DETECTION_RULES}

${COMPLEXITY_CLASSIFICATION}

${DIAMOND_TESTING_STRATEGY}

${TEST_CLASSIFICATION}

${OUTPUT_FORMAT}`;

  const previousAnalysis = existingManifest
    ? `

## Previous Analysis

A coverit.json already exists from a prior analysis. Use it as your starting point — do NOT start from scratch.

- **Add** new modules for directories that appeared since the last analysis.
- **Update** existing modules if their file counts, line counts, complexity, or test coverage changed.
- **Remove** modules whose directories no longer exist in the codebase.
- **Correct** any errors you find in the previous analysis (wrong counts, misclassified complexity, etc.).
- **Preserve** test coverage data (current counts and file paths) unless you verify they've changed.
- **Discover** new journeys and contracts from new features, keep existing ones that are still valid.

Previous manifest (${existingManifest.modules.length} modules, score ${existingManifest.score.overall}/100):

${JSON.stringify({
  modules: existingManifest.modules.map((m) => ({
    path: m.path,
    files: m.files,
    lines: m.lines,
    complexity: m.complexity,
    tests: m.functionality.tests,
  })),
  journeys: existingManifest.journeys,
  contracts: existingManifest.contracts,
}, null, 2)}
`
    : "";

  const user = `Analyze this project and produce the quality manifest JSON.

Project: ${projectInfo.name}
Root: ${projectInfo.root}
Framework: ${projectInfo.framework}
Test Framework: ${projectInfo.testFramework}
Language: ${projectInfo.language}
Has Existing Tests: ${projectInfo.hasExistingTests ? "yes" : "no"}
${projectInfo.existingTestPatterns.length > 0 ? `Test Patterns Found: ${projectInfo.existingTestPatterns.join(", ")}` : ""}
${previousAnalysis}
Start by exploring the file structure, then read source and test files to build a complete picture.`;

  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
}

// ─── Incremental Prompt Builder ─────────────────────────────

/**
 * Build a scoped Functionality prompt for incremental scanning.
 *
 * Instead of embedding all changed file paths in the prompt, we give the AI
 * the last scan commit SHA and the existing manifest summary. The AI uses
 * `git diff --name-only` to discover changes itself, maps them to modules,
 * and re-analyzes only the affected ones. This keeps the prompt compact
 * regardless of how many files changed.
 */
export function buildIncrementalScalePrompt(
  projectInfo: ProjectInfo,
  lastScanCommit: string,
  existingManifest: CoveritManifest,
): AIMessage[] {
  // Compact summary of existing modules for context
  const manifestSummary = JSON.stringify(
    {
      modules: existingManifest.modules.map((m) => ({
        path: m.path,
        files: m.files,
        lines: m.lines,
        complexity: m.complexity,
        tests: m.functionality.tests,
      })),
      journeys: existingManifest.journeys,
      contracts: existingManifest.contracts,
    },
    null,
    2,
  );

  const system = `You are a senior QA architect performing an INCREMENTAL codebase analysis.

You have access to Glob, Grep, Read, and Bash tools. Use them to explore the affected parts of the codebase.

## Your Task

Re-analyze ONLY the modules affected by recent changes since commit \`${lastScanCommit}\`. Do NOT explore or re-analyze the entire codebase.

## Workflow

1. **Discover changes**: Run \`git diff --name-only ${lastScanCommit}...HEAD\` to get the list of changed files.
2. **Map to modules**: Match each changed file to the existing modules listed below. Files that don't belong to any known module may represent new modules.
3. **Re-analyze affected modules**: For each affected module, read its files, re-assess file count, line count, complexity, and test coverage.
4. **Check for new modules**: If changed files fall outside all known module paths, determine if they form a new module that should be added.
5. **Find tests**: Check if test files for the affected modules have changed or if new tests were added.
6. **Map tests to modules**: Match test files to the affected source modules based on file paths, imports, and the code being tested.
7. **Calculate expected tests**: Based on each module's complexity and the Diamond testing strategy, determine how many tests of each type should exist.

## Existing Manifest (${existingManifest.modules.length} modules, score ${existingManifest.score.overall}/100)

${manifestSummary}

${MODULE_DETECTION_RULES}

${COMPLEXITY_CLASSIFICATION}

${DIAMOND_TESTING_STRATEGY}

${TEST_CLASSIFICATION}

${OUTPUT_FORMAT}

IMPORTANT:
- Only return the affected modules and any new modules discovered from unmapped files.
- Do NOT return unchanged modules — only modules that were touched by the diff or are new.
- If a module was deleted (all its files removed), include it with files: 0 and lines: 0.`;

  const user = `Perform an incremental analysis of this ${projectInfo.language} ${projectInfo.framework} project. Start by running git diff to discover what changed since commit ${lastScanCommit}, then re-analyze only the affected modules.

Project: ${projectInfo.name}
Root: ${projectInfo.root}
Framework: ${projectInfo.framework}
Test Framework: ${projectInfo.testFramework}
Language: ${projectInfo.language}
Has Existing Tests: ${projectInfo.hasExistingTests ? "yes" : "no"}
${projectInfo.existingTestPatterns.length > 0 ? `Test Patterns Found: ${projectInfo.existingTestPatterns.join(", ")}` : ""}`;

  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
}

// ─── JSON Repair ────────────────────────────────────────────

/**
 * Attempt to repair malformed JSON from AI responses.
 *
 * AI models (especially on large codebases) can produce JSON with common
 * defects: truncation mid-output, trailing commas, unescaped control
 * characters inside string values, or strings cut off without closing quotes.
 *
 * This is a best-effort repair — it will not fix arbitrarily broken JSON,
 * but it handles the failure modes we've observed in production.
 */
export function repairJSON(jsonStr: string): string {
  let repaired = jsonStr;

  // 1. Fix unescaped control characters inside JSON string values.
  //    Walk through the string tracking whether we're inside a JSON string
  //    (between unescaped double-quotes). Replace raw \n, \r, \t with
  //    their escaped equivalents only when inside a string value.
  let inString = false;
  let result = "";
  for (let i = 0; i < repaired.length; i++) {
    const ch = repaired[i]!;
    const prev = i > 0 ? repaired[i - 1] : "";

    if (ch === '"' && prev !== "\\") {
      inString = !inString;
      result += ch;
      continue;
    }

    if (inString) {
      if (ch === "\n") {
        result += "\\n";
        continue;
      }
      if (ch === "\r") {
        result += "\\r";
        continue;
      }
      if (ch === "\t") {
        result += "\\t";
        continue;
      }
    }

    result += ch;
  }
  repaired = result;

  // 2. Remove trailing commas before closing braces/brackets.
  //    e.g. [1, 2, 3,] → [1, 2, 3]  and  {"a": 1,} → {"a": 1}
  repaired = repaired.replace(/,\s*([\]}])/g, "$1");

  // 3. Handle truncated string values — if the JSON ends while a string
  //    is still open, close the string. We detect this by counting
  //    unescaped quotes: an odd count means a string is still open.
  let quoteCount = 0;
  for (let i = 0; i < repaired.length; i++) {
    if (repaired[i] === '"' && (i === 0 || repaired[i - 1] !== "\\")) {
      quoteCount++;
    }
  }
  if (quoteCount % 2 !== 0) {
    // String is still open — close it
    repaired += '"';
  }

  // 4. Handle truncated JSON — if there are more opening brackets/braces
  //    than closing ones, the output was cut off. Try to find the last
  //    structurally valid position and close everything properly.
  const openBraces = (repaired.match(/{/g) || []).length;
  const closeBraces = (repaired.match(/}/g) || []).length;
  const openBrackets = (repaired.match(/\[/g) || []).length;
  const closeBrackets = (repaired.match(/]/g) || []).length;

  if (openBraces > closeBraces || openBrackets > closeBrackets) {
    // Trim back to the last structurally complete element boundary.
    const lastCloseBrace = repaired.lastIndexOf("}");
    const lastCloseBracket = repaired.lastIndexOf("]");
    const lastCompleteIdx = Math.max(lastCloseBrace, lastCloseBracket);

    if (lastCompleteIdx > repaired.length * 0.5) {
      // Only truncate if we're keeping at least half the content
      repaired = repaired.slice(0, lastCompleteIdx + 1);
    }

    // Remove any trailing comma left by the truncation
    repaired = repaired.replace(/,\s*$/, "");

    // Walk through tracking the bracket/brace stack and append missing closers
    const stack: string[] = [];
    let inStr = false;
    for (let i = 0; i < repaired.length; i++) {
      const c = repaired[i]!;
      if (c === '"' && (i === 0 || repaired[i - 1] !== "\\")) {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (c === "{") stack.push("}");
      else if (c === "[") stack.push("]");
      else if (c === "}" || c === "]") {
        if (stack.length > 0 && stack[stack.length - 1] === c) {
          stack.pop();
        }
      }
    }

    // Append closers in reverse (LIFO) to properly nest them
    while (stack.length > 0) {
      repaired += stack.pop();
    }
  }

  return repaired;
}

// ─── Response Parser ────────────────────────────────────────

/**
 * Extract and parse the JSON response from the AI.
 * Handles responses that may be wrapped in markdown code fences.
 * If initial parse fails, attempts JSON repair before giving up.
 */
export function parseScaleResponse(raw: string): ScaleAIResponse {
  let jsonStr = raw.trim();

  // Strip markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1]!.trim();
  }

  // Try to find JSON object boundaries if there's surrounding text
  if (!jsonStr.startsWith("{")) {
    const startIdx = jsonStr.indexOf("{");
    const endIdx = jsonStr.lastIndexOf("}");
    if (startIdx !== -1 && endIdx !== -1) {
      jsonStr = jsonStr.slice(startIdx, endIdx + 1);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (originalError) {
    // Initial parse failed — attempt repair before giving up
    const originalMsg =
      originalError instanceof Error
        ? originalError.message
        : String(originalError);

    try {
      const repaired = repairJSON(jsonStr);
      parsed = JSON.parse(repaired);
      logger.warn(
        `JSON repair succeeded (original error: ${originalMsg}). ` +
          `Repaired ${jsonStr.length} chars → ${repaired.length} chars.`,
      );
    } catch (repairError) {
      // Repair also failed — throw the original error with both details
      const repairMsg =
        repairError instanceof Error
          ? repairError.message
          : String(repairError);
      throw new Error(
        `Failed to parse AI response as JSON: ${originalMsg}\n` +
          `Repair also failed: ${repairMsg}\n\n` +
          `Raw response (first 500 chars): ${raw.slice(0, 500)}`,
      );
    }
  }

  // Basic structural validation
  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj["modules"])) {
    throw new Error(
      "AI response missing 'modules' array. Got: " +
        JSON.stringify(Object.keys(obj)),
    );
  }

  // Validate and normalize modules
  const modules = (obj["modules"] as Array<Record<string, unknown>>).map(
    (m, i) => validateModule(m, i),
  );

  const journeys = Array.isArray(obj["journeys"])
    ? (obj["journeys"] as Array<Record<string, unknown>>).map(normalizeJourney)
    : [];

  const contracts = Array.isArray(obj["contracts"])
    ? (obj["contracts"] as Array<Record<string, unknown>>).map(normalizeContract)
    : [];

  return {
    sourceFiles:
      typeof obj["sourceFiles"] === "number" ? obj["sourceFiles"] : 0,
    sourceLines:
      typeof obj["sourceLines"] === "number" ? obj["sourceLines"] : 0,
    language: typeof obj["language"] === "string" ? obj["language"] : undefined,
    framework: typeof obj["framework"] === "string" ? obj["framework"] : undefined,
    testFramework: typeof obj["testFramework"] === "string" ? obj["testFramework"] : undefined,
    modules,
    journeys,
    contracts,
  };
}

// ─── Validation Helpers ─────────────────────────────────────

const VALID_COMPLEXITIES = new Set(["low", "medium", "high"]);
const VALID_TEST_TYPES = new Set([
  "unit",
  "integration",
  "api",
  "e2e",
  "contract",
]);
const VALID_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function validateModule(
  raw: Record<string, unknown>,
  index: number,
): ScaleAIModule {
  const path = typeof raw["path"] === "string" ? raw["path"] : `module-${index}`;
  const files = typeof raw["files"] === "number" ? raw["files"] : 0;
  const lines = typeof raw["lines"] === "number" ? raw["lines"] : 0;
  const complexity = VALID_COMPLEXITIES.has(raw["complexity"] as string)
    ? (raw["complexity"] as "low" | "medium" | "high")
    : "medium";

  // Parse functionality.tests
  const tests: Record<
    string,
    { expected: number; current: number; files: string[] }
  > = {};

  const func = raw["functionality"] as Record<string, unknown> | undefined;
  const rawTests = func?.["tests"] as Record<string, unknown> | undefined;

  if (rawTests) {
    for (const [testType, coverage] of Object.entries(rawTests)) {
      if (!VALID_TEST_TYPES.has(testType)) continue;
      const cov = coverage as Record<string, unknown>;
      tests[testType] = {
        expected: typeof cov["expected"] === "number" ? cov["expected"] : 0,
        current: typeof cov["current"] === "number" ? cov["current"] : 0,
        files: Array.isArray(cov["files"])
          ? (cov["files"] as unknown[]).filter(
              (f): f is string => typeof f === "string",
            )
          : [],
      };
    }
  }

  return {
    path,
    files,
    lines,
    complexity,
    functionality: { tests },
  };
}

function normalizeJourney(raw: Record<string, unknown>): ScaleAIJourney {
  return {
    id: typeof raw["id"] === "string" ? raw["id"] : `j${Math.random().toString(36).slice(2, 6)}`,
    name: typeof raw["name"] === "string" ? raw["name"] : "Unknown journey",
    steps: Array.isArray(raw["steps"])
      ? (raw["steps"] as unknown[]).filter(
          (s): s is string => typeof s === "string",
        )
      : [],
    covered: raw["covered"] === true,
    testFile:
      typeof raw["testFile"] === "string" ? raw["testFile"] : null,
  };
}

function normalizeContract(raw: Record<string, unknown>): ScaleAIContract {
  return {
    endpoint:
      typeof raw["endpoint"] === "string"
        ? raw["endpoint"]
        : "UNKNOWN /unknown",
    method: VALID_METHODS.has(raw["method"] as string)
      ? (raw["method"] as ScaleAIContract["method"])
      : "GET",
    requestSchema:
      typeof raw["requestSchema"] === "string"
        ? raw["requestSchema"]
        : null,
    responseSchema:
      typeof raw["responseSchema"] === "string"
        ? raw["responseSchema"]
        : null,
    covered: raw["covered"] === true,
    testFile:
      typeof raw["testFile"] === "string" ? raw["testFile"] : null,
  };
}
