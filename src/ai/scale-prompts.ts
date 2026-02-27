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

// ─── Types ───────────────────────────────────────────────────

/**
 * The structured JSON the AI must return.
 * Parsed and validated by the analyzer before assembly into a full manifest.
 */
export interface ScaleAIResponse {
  sourceFiles: number;
  sourceLines: number;
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

## Module Detection Rules

- Group source files by their logical directory boundary
- For projects with a \`src/\` directory: use the second-level directory as module boundary (e.g., \`src/services\`, \`src/controllers\`)
- Files directly in \`src/\` form the \`src\` module
- For monorepos with \`packages/\`: each package is a top-level module, with sub-modules inside
- EXCLUDE from source: \`node_modules\`, \`dist\`, \`build\`, \`.coverit\`, \`.git\`, \`.next\`, coverage, test-only directories (\`test/\`, \`tests/\`, \`e2e/\`, \`__tests__/\`)
- EXCLUDE config files at root (jest.config.*, tsconfig.*, etc.) from source file counts
- Only count source code files: .ts, .tsx, .js, .jsx, .mjs, .mts

## Complexity Classification

Assess each module's complexity by reading its code, not just counting lines:

- **low**: Simple utilities, pure functions, few dependencies, straightforward logic. Typically < 500 lines AND < 5 files, but use judgment.
- **medium**: Moderate business logic, some external dependencies, moderate branching. Typically 500-2000 lines AND 5-15 files.
- **high**: Complex business logic, many dependencies, I/O operations, state management, error handling, financial/security-sensitive logic. Typically > 2000 lines OR > 15 files, but also includes smaller modules with high domain complexity.

## Diamond Testing Strategy

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
- Controller/route modules need api tests rather than unit tests

## Test Classification

When you find test files, classify them by reading their content:

- **unit**: Tests that mock all external dependencies (jest.mock, vi.mock, sinon stubs)
- **integration**: Tests that use real DI containers, databases, or service layers (NestJS \`createTestingModule\`, Prisma client, Drizzle, TypeORM \`getRepository\`)
- **api**: Tests that make HTTP requests to the app (\`supertest\`, \`request(app)\`, \`httpService\`)
- **e2e**: Tests that simulate browser/UI interactions (\`playwright\`, \`page.goto\`, \`cypress\`, \`browser.newPage\`)
- **contract**: Tests that validate API schemas (\`pactum\`, schema validation, contract testing)

Count actual test cases by counting \`it(\` and \`test(\` calls (excluding commented-out lines).

## Output Format

Return ONLY a valid JSON object with no surrounding markdown, no explanation, no commentary. The JSON must match this exact structure:

{
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

// ─── Response Parser ────────────────────────────────────────

/**
 * Extract and parse the JSON response from the AI.
 * Handles responses that may be wrapped in markdown code fences.
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
  } catch (e) {
    throw new Error(
      `Failed to parse AI response as JSON: ${e instanceof Error ? e.message : String(e)}\n\nRaw response (first 500 chars): ${raw.slice(0, 500)}`,
    );
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
