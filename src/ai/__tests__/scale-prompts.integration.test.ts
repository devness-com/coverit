/**
 * Integration tests for scale-prompts.ts
 * Tests buildScalePrompt and parseScaleResponse with realistic data and edge cases.
 */
import { describe, it, expect } from "vitest";
import {
  buildScalePrompt,
  parseScaleResponse,
  type ScaleAIResponse,
} from "../scale-prompts.js";
import type { ProjectInfo } from "../../types/index.js";
import type { CoveritManifest } from "../../schema/coverit-manifest.js";

// ─── Realistic Project Infos ─────────────────────────────────

const nestjsProject: ProjectInfo = {
  name: "booking-api",
  root: "/home/user/booking-api",
  language: "typescript",
  framework: "nestjs",
  testFramework: "jest",
  packageManager: "pnpm",
  hasExistingTests: true,
  existingTestPatterns: ["**/*.spec.ts", "**/*.e2e-spec.ts"],
};

const greenFieldProject: ProjectInfo = {
  name: "new-app",
  root: "/home/user/new-app",
  language: "typescript",
  framework: "express",
  testFramework: "vitest",
  packageManager: "bun",
  hasExistingTests: false,
  existingTestPatterns: [],
};

// ─── Realistic AI Responses ──────────────────────────────────

const fullAnalysisResponse: ScaleAIResponse = {
  sourceFiles: 85,
  sourceLines: 12500,
  modules: [
    {
      path: "src/booking",
      files: 15,
      lines: 3000,
      complexity: "high",
      functionality: {
        tests: {
          unit: { expected: 12, current: 4, files: ["src/booking/__tests__/booking.service.spec.ts"] },
          integration: { expected: 20, current: 8, files: ["src/booking/__tests__/booking.integration.spec.ts"] },
          api: { expected: 8, current: 3, files: ["src/booking/__tests__/booking.controller.spec.ts"] },
          e2e: { expected: 2, current: 0, files: [] },
          contract: { expected: 4, current: 1, files: ["test/contracts/booking.pact.ts"] },
        },
      },
    },
    {
      path: "src/auth",
      files: 8,
      lines: 1200,
      complexity: "medium",
      functionality: {
        tests: {
          unit: { expected: 6, current: 6, files: ["src/auth/__tests__/auth.service.spec.ts"] },
          integration: { expected: 10, current: 5, files: [] },
          api: { expected: 4, current: 4, files: ["src/auth/__tests__/auth.controller.spec.ts"] },
        },
      },
    },
    {
      path: "src/utils",
      files: 3,
      lines: 250,
      complexity: "low",
      functionality: {
        tests: {
          unit: { expected: 3, current: 3, files: ["src/utils/__tests__/helpers.spec.ts"] },
          integration: { expected: 5, current: 5, files: ["src/utils/__tests__/helpers.integration.spec.ts"] },
        },
      },
    },
  ],
  journeys: [
    {
      id: "j1",
      name: "Search → Book → Pay → Confirm",
      steps: ["Search available rooms", "Select room", "Enter payment", "Confirm booking"],
      covered: false,
      testFile: null,
    },
    {
      id: "j2",
      name: "Login → View Dashboard",
      steps: ["Login with credentials", "View dashboard"],
      covered: true,
      testFile: "test/e2e/dashboard.e2e-spec.ts",
    },
  ],
  contracts: [
    {
      endpoint: "POST /api/bookings",
      method: "POST",
      requestSchema: "CreateBookingDto",
      responseSchema: "BookingResponse",
      covered: true,
      testFile: "test/contracts/booking.pact.ts",
    },
    {
      endpoint: "GET /api/bookings/:id",
      method: "GET",
      requestSchema: null,
      responseSchema: "BookingResponse",
      covered: false,
      testFile: null,
    },
  ],
};

// ─── Integration Tests ───────────────────────────────────────

describe("scale-prompts integration", () => {
  describe("buildScalePrompt with NestJS project", () => {
    it("generates comprehensive prompt with all required sections", () => {
      const messages = buildScalePrompt(nestjsProject);
      const system = messages[0]!.content;
      const user = messages[1]!.content;

      // System prompt should cover methodology
      expect(system).toContain("Module Detection Rules");
      expect(system).toContain("Complexity Classification");
      expect(system).toContain("Diamond Testing Strategy");
      expect(system).toContain("Test Classification");
      expect(system).toContain("Output Format");

      // User message should include project details
      expect(user).toContain("booking-api");
      expect(user).toContain("nestjs");
      expect(user).toContain("jest");
    });

    it("includes test patterns in user message", () => {
      const messages = buildScalePrompt(nestjsProject);
      const user = messages[1]!.content;

      expect(user).toContain("**/*.spec.ts");
      expect(user).toContain("**/*.e2e-spec.ts");
    });
  });

  describe("buildScalePrompt with green-field project", () => {
    it("generates prompt for project with no existing tests", () => {
      const messages = buildScalePrompt(greenFieldProject);
      const user = messages[1]!.content;

      expect(user).toContain("Has Existing Tests: no");
      expect(user).not.toContain("Test Patterns Found:");
    });
  });

  describe("buildScalePrompt with existing manifest", () => {
    it("includes previous analysis context when manifest provided", () => {
      const manifest: CoveritManifest = {
        version: 1,
        createdAt: "2024-06-01",
        updatedAt: "2024-06-15",
        project: {
          name: "booking-api",
          root: "/home/user/booking-api",
          language: "typescript",
          framework: "nestjs",
          testFramework: "jest",
          sourceFiles: 80,
          sourceLines: 11000,
        },
        dimensions: {} as CoveritManifest["dimensions"],
        modules: [
          {
            path: "src/booking",
            files: 14,
            lines: 2800,
            complexity: "high",
            functionality: {
              tests: {
                unit: { expected: 12, current: 4, files: ["test1.ts"] },
              },
            },
            security: { issues: 1, resolved: 0, findings: ["injection:booking.service.ts:42"] },
            stability: { score: 70, gaps: ["No timeout handling"] },
            conformance: { score: 85, violations: [] },
          },
        ],
        journeys: [
          { id: "j1", name: "Booking flow", steps: ["Search", "Book"], covered: false, testFile: null },
        ],
        contracts: [
          { endpoint: "POST /api/bookings", method: "POST", requestSchema: "CreateBookingDto", responseSchema: "BookingResponse", covered: true, testFile: "test.ts" },
        ],
        score: {
          overall: 55,
          breakdown: { functionality: 50, security: 60, stability: 70, conformance: 85, regression: 0 },
          gaps: { total: 20, critical: 5, byDimension: { functionality: { missing: 15, priority: "high" }, security: { issues: 1, priority: "medium" }, stability: { gaps: 2, priority: "low" }, conformance: { violations: 0, priority: "low" } } },
          history: [{ date: "2024-06-01", score: 40, scope: "first-time" }],
        },
      };

      const messages = buildScalePrompt(nestjsProject, manifest);
      const user = messages[1]!.content;

      expect(user).toContain("Previous Analysis");
      expect(user).toContain("score 55/100");
      expect(user).toContain("1 modules");
      expect(user).toContain("src/booking");
      expect(user).toContain("do NOT start from scratch");
    });
  });

  describe("parseScaleResponse with realistic AI output", () => {
    it("parses a full multi-module analysis response", () => {
      const result = parseScaleResponse(JSON.stringify(fullAnalysisResponse));

      expect(result.sourceFiles).toBe(85);
      expect(result.sourceLines).toBe(12500);
      expect(result.modules).toHaveLength(3);
      expect(result.journeys).toHaveLength(2);
      expect(result.contracts).toHaveLength(2);

      // Module details
      const booking = result.modules[0]!;
      expect(booking.path).toBe("src/booking");
      expect(booking.complexity).toBe("high");
      expect(booking.functionality.tests["unit"]!.expected).toBe(12);
      expect(booking.functionality.tests["unit"]!.current).toBe(4);

      const utils = result.modules[2]!;
      expect(utils.path).toBe("src/utils");
      expect(utils.complexity).toBe("low");

      // Journey details
      expect(result.journeys[0]!.name).toContain("Search");
      expect(result.journeys[0]!.covered).toBe(false);
      expect(result.journeys[1]!.covered).toBe(true);
      expect(result.journeys[1]!.testFile).toBe("test/e2e/dashboard.e2e-spec.ts");

      // Contract details
      expect(result.contracts[0]!.method).toBe("POST");
      expect(result.contracts[0]!.covered).toBe(true);
      expect(result.contracts[1]!.covered).toBe(false);
    });

    it("handles AI response with verbose text wrapping", () => {
      const verboseResponse = `After thorough analysis of the codebase, here are my findings:

\`\`\`json
${JSON.stringify(fullAnalysisResponse)}
\`\`\`

This analysis covers all 85 source files across 3 modules.`;

      const result = parseScaleResponse(verboseResponse);
      expect(result.modules).toHaveLength(3);
      expect(result.sourceFiles).toBe(85);
    });

    it("handles response with minimal module data", () => {
      const minimalResponse = JSON.stringify({
        sourceFiles: 5,
        sourceLines: 200,
        modules: [
          { path: "src" },
        ],
      });

      const result = parseScaleResponse(minimalResponse);
      expect(result.modules).toHaveLength(1);
      expect(result.modules[0]!.path).toBe("src");
      expect(result.modules[0]!.files).toBe(0);
      expect(result.modules[0]!.lines).toBe(0);
      expect(result.modules[0]!.complexity).toBe("medium"); // default
      expect(result.modules[0]!.functionality.tests).toEqual({});
    });

    it("handles all HTTP methods in contracts", () => {
      const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
      const contracts = methods.map((m) => ({
        endpoint: `${m} /api/test`,
        method: m,
        requestSchema: null,
        responseSchema: null,
        covered: false,
        testFile: null,
      }));

      const raw = JSON.stringify({ modules: [], contracts });
      const result = parseScaleResponse(raw);

      methods.forEach((method, i) => {
        expect(result.contracts[i]!.method).toBe(method);
      });
    });

    it("round-trips: prompt format matches expected parser output structure", () => {
      // Build a prompt
      const messages = buildScalePrompt(nestjsProject);
      const system = messages[0]!.content;

      // The system prompt should describe the output format
      expect(system).toContain('"sourceFiles"');
      expect(system).toContain('"sourceLines"');
      expect(system).toContain('"modules"');
      expect(system).toContain('"journeys"');
      expect(system).toContain('"contracts"');

      // A response matching the format should parse successfully
      const result = parseScaleResponse(JSON.stringify(fullAnalysisResponse));
      expect(result.modules).toHaveLength(3);
    });

    it("rejects response that is not JSON at all", () => {
      expect(() => parseScaleResponse("I couldn't analyze the project because..."))
        .toThrow("Failed to parse AI response as JSON");
    });

    it("rejects response with modules as non-array", () => {
      expect(() => parseScaleResponse('{"modules": "not an array"}'))
        .toThrow("missing 'modules' array");
    });
  });
});
