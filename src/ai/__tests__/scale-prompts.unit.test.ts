/**
 * Unit tests for scale-prompts.ts
 * Tests buildScalePrompt and parseScaleResponse in isolation.
 */
import { describe, it, expect } from "vitest";
import {
  buildScalePrompt,
  buildIncrementalScalePrompt,
  parseScaleResponse,
  type ScaleAIResponse,
  type ScaleAIModule,
} from "../scale-prompts.js";
import type { ProjectInfo } from "../../types/index.js";
import type { CoveritManifest } from "../../schema/coverit-manifest.js";

// ─── Fixtures ────────────────────────────────────────────────

const mockProjectInfo: ProjectInfo = {
  name: "my-app",
  root: "/tmp/my-app",
  language: "typescript",
  framework: "nestjs",
  testFramework: "vitest",
  packageManager: "bun",
  hasExistingTests: true,
  existingTestPatterns: ["**/*.test.ts", "**/*.spec.ts"],
};

const mockProjectNoTests: ProjectInfo = {
  ...mockProjectInfo,
  hasExistingTests: false,
  existingTestPatterns: [],
};

// ─── buildScalePrompt ────────────────────────────────────────

describe("buildScalePrompt", () => {
  it("returns a system and user message", () => {
    const messages = buildScalePrompt(mockProjectInfo);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.role).toBe("user");
  });

  it("includes project name and root in user message", () => {
    const messages = buildScalePrompt(mockProjectInfo);
    const userContent = messages[1]!.content;
    expect(userContent).toContain("my-app");
    expect(userContent).toContain("/tmp/my-app");
  });

  it("includes framework and test framework in user message", () => {
    const messages = buildScalePrompt(mockProjectInfo);
    const userContent = messages[1]!.content;
    expect(userContent).toContain("nestjs");
    expect(userContent).toContain("vitest");
  });

  it("shows existing test status", () => {
    const messages = buildScalePrompt(mockProjectInfo);
    const userContent = messages[1]!.content;
    expect(userContent).toContain("Has Existing Tests: yes");
  });

  it("shows no tests status", () => {
    const messages = buildScalePrompt(mockProjectNoTests);
    const userContent = messages[1]!.content;
    expect(userContent).toContain("Has Existing Tests: no");
  });

  it("includes test patterns when present", () => {
    const messages = buildScalePrompt(mockProjectInfo);
    const userContent = messages[1]!.content;
    expect(userContent).toContain("**/*.test.ts");
    expect(userContent).toContain("**/*.spec.ts");
  });

  it("includes Diamond testing strategy in system prompt", () => {
    const messages = buildScalePrompt(mockProjectInfo);
    const systemContent = messages[0]!.content;
    expect(systemContent).toContain("Diamond Testing Strategy");
    expect(systemContent).toContain("Integration");
    expect(systemContent).toContain("Unit");
  });

  it("includes complexity classification criteria", () => {
    const messages = buildScalePrompt(mockProjectInfo);
    const systemContent = messages[0]!.content;
    expect(systemContent).toContain("low");
    expect(systemContent).toContain("medium");
    expect(systemContent).toContain("high");
  });

  it("includes JSON output format specification", () => {
    const messages = buildScalePrompt(mockProjectInfo);
    const systemContent = messages[0]!.content;
    expect(systemContent).toContain("sourceFiles");
    expect(systemContent).toContain("sourceLines");
    expect(systemContent).toContain("modules");
    expect(systemContent).toContain("journeys");
    expect(systemContent).toContain("contracts");
  });

  it("includes previous manifest context when provided", () => {
    const existingManifest = {
      version: 1 as const,
      createdAt: "2024-01-01",
      updatedAt: "2024-01-02",
      project: {
        name: "my-app",
        root: "/tmp/my-app",
        language: "typescript" as const,
        framework: "nestjs" as const,
        testFramework: "vitest" as const,
        sourceFiles: 20,
        sourceLines: 2000,
      },
      dimensions: {} as CoveritManifest["dimensions"],
      modules: [
        {
          path: "src/services",
          files: 5,
          lines: 500,
          complexity: "medium" as const,
          functionality: { tests: { unit: { expected: 6, current: 2, files: [] } } },
          security: { issues: 0, resolved: 0, findings: [] },
          stability: { score: 80, gaps: [] },
          conformance: { score: 90, violations: [] },
        },
      ],
      journeys: [],
      contracts: [],
      score: {
        overall: 45,
        breakdown: { functionality: 40, security: 0, stability: 0, conformance: 0, regression: 0 },
        gaps: { total: 10, critical: 2, byDimension: { functionality: { missing: 10, priority: "high" }, security: { issues: 0, priority: "low" }, stability: { gaps: 0, priority: "low" }, conformance: { violations: 0, priority: "low" } } },
        history: [],
      },
    };

    const messages = buildScalePrompt(mockProjectInfo, existingManifest);
    const userContent = messages[1]!.content;
    expect(userContent).toContain("Previous Analysis");
    expect(userContent).toContain("src/services");
    expect(userContent).toContain("score 45/100");
    expect(userContent).toContain("1 modules");
  });

  it("does not include previous analysis when no manifest provided", () => {
    const messages = buildScalePrompt(mockProjectInfo);
    const userContent = messages[1]!.content;
    expect(userContent).not.toContain("Previous Analysis");
  });
});

// ─── buildIncrementalScalePrompt ─────────────────────────────

describe("buildIncrementalScalePrompt", () => {
  it("includes changed files and affected modules in prompt", () => {
    const messages = buildIncrementalScalePrompt(
      mockProjectInfo,
      ["src/services/auth.ts", "src/services/user.ts"],
      ["src/services"],
      ["src/new/unknown.ts"],
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toContain("src/services/auth.ts");
    expect(messages[0]!.content).toContain("src/services");
    expect(messages[0]!.content).toContain("src/new/unknown.ts");
    expect(messages[0]!.content).toContain("ONLY these modules");
  });

  it("returns a system and user message", () => {
    const messages = buildIncrementalScalePrompt(
      mockProjectInfo,
      ["src/utils/helper.ts"],
      ["src/utils"],
      [],
    );
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.role).toBe("user");
  });

  it("includes INCREMENTAL in system prompt", () => {
    const messages = buildIncrementalScalePrompt(
      mockProjectInfo,
      ["src/utils/helper.ts"],
      ["src/utils"],
      [],
    );
    expect(messages[0]!.content).toContain("INCREMENTAL");
  });

  it("includes shared prompt sections", () => {
    const messages = buildIncrementalScalePrompt(
      mockProjectInfo,
      ["src/utils/helper.ts"],
      ["src/utils"],
      [],
    );
    const systemContent = messages[0]!.content;
    expect(systemContent).toContain("Module Detection Rules");
    expect(systemContent).toContain("Complexity Classification");
    expect(systemContent).toContain("Diamond Testing Strategy");
    expect(systemContent).toContain("Test Classification");
    expect(systemContent).toContain("Output Format");
  });

  it("includes project language and framework in user prompt", () => {
    const messages = buildIncrementalScalePrompt(
      mockProjectInfo,
      ["src/utils/helper.ts"],
      ["src/utils"],
      [],
    );
    const userContent = messages[1]!.content;
    expect(userContent).toContain("typescript");
    expect(userContent).toContain("nestjs");
  });

  it("omits unmapped section when no unmapped files", () => {
    const messages = buildIncrementalScalePrompt(
      mockProjectInfo,
      ["src/utils/helper.ts"],
      ["src/utils"],
      [],
    );
    expect(messages[0]!.content).not.toContain("Unmapped Files");
  });

  it("includes deleted module instruction", () => {
    const messages = buildIncrementalScalePrompt(
      mockProjectInfo,
      ["src/old/removed.ts"],
      ["src/old"],
      [],
    );
    expect(messages[0]!.content).toContain("files: 0");
  });
});

// ─── parseScaleResponse ──────────────────────────────────────

describe("parseScaleResponse", () => {
  const validResponse: ScaleAIResponse = {
    sourceFiles: 30,
    sourceLines: 3000,
    modules: [
      {
        path: "src/services",
        files: 10,
        lines: 1000,
        complexity: "medium",
        functionality: {
          tests: {
            unit: { expected: 6, current: 2, files: ["test1.ts"] },
            integration: { expected: 10, current: 5, files: ["test2.ts"] },
          },
        },
      },
    ],
    journeys: [
      {
        id: "j1",
        name: "User login flow",
        steps: ["Navigate to login", "Enter credentials", "Submit"],
        covered: true,
        testFile: "e2e/login.spec.ts",
      },
    ],
    contracts: [
      {
        endpoint: "POST /api/users",
        method: "POST",
        requestSchema: "CreateUserDto",
        responseSchema: "UserResponse",
        covered: false,
        testFile: null,
      },
    ],
  };

  it("parses a valid JSON response", () => {
    const result = parseScaleResponse(JSON.stringify(validResponse));
    expect(result.sourceFiles).toBe(30);
    expect(result.sourceLines).toBe(3000);
    expect(result.modules).toHaveLength(1);
    expect(result.journeys).toHaveLength(1);
    expect(result.contracts).toHaveLength(1);
  });

  it("strips markdown code fences", () => {
    const raw = "```json\n" + JSON.stringify(validResponse) + "\n```";
    const result = parseScaleResponse(raw);
    expect(result.modules).toHaveLength(1);
    expect(result.modules[0]!.path).toBe("src/services");
  });

  it("extracts JSON from surrounding text", () => {
    const raw = "Here is the analysis:\n" + JSON.stringify(validResponse) + "\nDone!";
    const result = parseScaleResponse(raw);
    expect(result.sourceFiles).toBe(30);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseScaleResponse("not json")).toThrow("Failed to parse AI response as JSON");
  });

  it("throws when modules array is missing", () => {
    expect(() => parseScaleResponse('{"sourceFiles": 10}')).toThrow("missing 'modules' array");
  });

  it("validates module fields with defaults", () => {
    const raw = JSON.stringify({
      modules: [{ path: "src/foo" }],
    });
    const result = parseScaleResponse(raw);
    const mod = result.modules[0]!;
    expect(mod.path).toBe("src/foo");
    expect(mod.files).toBe(0);
    expect(mod.lines).toBe(0);
    expect(mod.complexity).toBe("medium"); // default
  });

  it("defaults module path when missing", () => {
    const raw = JSON.stringify({
      modules: [{}],
    });
    const result = parseScaleResponse(raw);
    expect(result.modules[0]!.path).toBe("module-0");
  });

  it("normalizes invalid complexity to medium", () => {
    const raw = JSON.stringify({
      modules: [{ path: "src/x", complexity: "extreme" }],
    });
    const result = parseScaleResponse(raw);
    expect(result.modules[0]!.complexity).toBe("medium");
  });

  it("filters out invalid test types", () => {
    const raw = JSON.stringify({
      modules: [
        {
          path: "src/x",
          functionality: {
            tests: {
              unit: { expected: 5, current: 2, files: [] },
              invalid_type: { expected: 3, current: 1, files: [] },
            },
          },
        },
      ],
    });
    const result = parseScaleResponse(raw);
    const tests = result.modules[0]!.functionality.tests;
    expect(tests["unit"]).toBeDefined();
    expect(tests["invalid_type" as string]).toBeUndefined();
  });

  it("normalizes journey fields with defaults", () => {
    const raw = JSON.stringify({
      modules: [],
      journeys: [{ name: "My flow" }],
    });
    const result = parseScaleResponse(raw);
    const journey = result.journeys[0]!;
    expect(journey.name).toBe("My flow");
    expect(journey.id).toBeTruthy(); // auto-generated
    expect(journey.steps).toEqual([]);
    expect(journey.covered).toBe(false);
    expect(journey.testFile).toBeNull();
  });

  it("normalizes contract fields with defaults", () => {
    const raw = JSON.stringify({
      modules: [],
      contracts: [{ endpoint: "GET /health" }],
    });
    const result = parseScaleResponse(raw);
    const contract = result.contracts[0]!;
    expect(contract.endpoint).toBe("GET /health");
    expect(contract.method).toBe("GET");
    expect(contract.requestSchema).toBeNull();
    expect(contract.responseSchema).toBeNull();
    expect(contract.covered).toBe(false);
    expect(contract.testFile).toBeNull();
  });

  it("defaults to GET for invalid HTTP methods", () => {
    const raw = JSON.stringify({
      modules: [],
      contracts: [{ endpoint: "FOOBAR /test", method: "FOOBAR" }],
    });
    const result = parseScaleResponse(raw);
    expect(result.contracts[0]!.method).toBe("GET");
  });

  it("defaults to empty arrays when journeys/contracts are missing", () => {
    const raw = JSON.stringify({ modules: [] });
    const result = parseScaleResponse(raw);
    expect(result.journeys).toEqual([]);
    expect(result.contracts).toEqual([]);
  });

  it("defaults sourceFiles and sourceLines to 0 when not numbers", () => {
    const raw = JSON.stringify({
      sourceFiles: "many",
      sourceLines: null,
      modules: [],
    });
    const result = parseScaleResponse(raw);
    expect(result.sourceFiles).toBe(0);
    expect(result.sourceLines).toBe(0);
  });

  it("filters non-string entries from test file arrays", () => {
    const raw = JSON.stringify({
      modules: [
        {
          path: "src/x",
          functionality: {
            tests: {
              unit: { expected: 3, current: 1, files: ["valid.ts", 42, null] },
            },
          },
        },
      ],
    });
    const result = parseScaleResponse(raw);
    expect(result.modules[0]!.functionality.tests["unit"]!.files).toEqual(["valid.ts"]);
  });

  it("handles modules without functionality field", () => {
    const raw = JSON.stringify({
      modules: [{ path: "src/empty" }],
    });
    const result = parseScaleResponse(raw);
    expect(result.modules[0]!.functionality.tests).toEqual({});
  });
});
