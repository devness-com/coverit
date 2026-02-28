/**
 * Integration tests for cover-prompts.ts
 * Tests the full buildCoverPrompt + parseCoverResponse pipeline with realistic data.
 */
import { describe, it, expect } from "vitest";
import {
  buildCoverPrompt,
  parseCoverResponse,
  type ModuleGap,
} from "../cover-prompts.js";
import type { ManifestProject } from "../../schema/coverit-manifest.js";

// ─── Realistic Fixtures ──────────────────────────────────────

const nestjsProject: ManifestProject = {
  name: "booking-api",
  root: "/home/user/booking-api",
  language: "typescript",
  framework: "nestjs",
  testFramework: "jest",
  sourceFiles: 120,
  sourceLines: 15000,
};

const vitestProject: ManifestProject = {
  name: "coverit",
  root: "/Users/dev/coverit",
  language: "typescript",
  framework: "none",
  testFramework: "vitest",
  sourceFiles: 29,
  sourceLines: 3500,
};

const highComplexityGap: ModuleGap = {
  path: "src/booking",
  complexity: "high",
  gaps: {
    unit: { expected: 12, current: 3, gap: 9 },
    integration: { expected: 20, current: 8, gap: 12 },
    api: { expected: 8, current: 2, gap: 6 },
    e2e: { expected: 2, current: 0, gap: 2 },
    contract: { expected: 4, current: 1, gap: 3 },
  },
  totalGap: 32,
  existingTestFiles: [
    "src/booking/__tests__/booking.service.spec.ts",
    "src/booking/__tests__/booking.controller.spec.ts",
  ],
};

const lowComplexityGap: ModuleGap = {
  path: "src/utils",
  complexity: "low",
  gaps: {
    unit: { expected: 3, current: 0, gap: 3 },
    integration: { expected: 5, current: 2, gap: 3 },
  },
  totalGap: 6,
  existingTestFiles: [],
};

// ─── Integration: Prompt → Response Pipeline ─────────────────

describe("cover-prompts integration", () => {
  describe("buildCoverPrompt with NestJS project", () => {
    it("generates a complete prompt for high-complexity module with all test types", () => {
      const messages = buildCoverPrompt(highComplexityGap, nestjsProject);
      const system = messages[0]!.content;
      const user = messages[1]!.content;

      // All 5 test types should be mentioned in gaps
      expect(system).toContain("unit: need 9 more");
      expect(system).toContain("integration: need 12 more");
      expect(system).toContain("api: need 6 more");
      expect(system).toContain("e2e: need 2 more");
      expect(system).toContain("contract: need 3 more");

      // Existing test files listed
      expect(system).toContain("booking.service.spec.ts");
      expect(system).toContain("booking.controller.spec.ts");

      // User message references the module and total gap
      expect(user).toContain("src/booking/");
      expect(user).toContain("32 test gaps");
    });

    it("generates jest-specific instructions for jest projects", () => {
      const messages = buildCoverPrompt(highComplexityGap, nestjsProject);
      const system = messages[0]!.content;

      expect(system).toContain("npx jest");
      expect(system).toContain("@jest/globals");
    });
  });

  describe("buildCoverPrompt with vitest project", () => {
    it("generates vitest-specific instructions", () => {
      const messages = buildCoverPrompt(lowComplexityGap, vitestProject);
      const system = messages[0]!.content;

      expect(system).toContain("npx vitest run");
      expect(system).toContain("from 'vitest'");
    });

    it("handles low complexity module correctly", () => {
      const messages = buildCoverPrompt(lowComplexityGap, vitestProject);
      const system = messages[0]!.content;

      expect(system).toContain("low complexity");
      expect(system).toContain("unit: need 3 more");
      expect(system).toContain("integration: need 3 more");
    });
  });

  describe("parseCoverResponse with realistic AI outputs", () => {
    it("parses a typical successful AI response", () => {
      const aiOutput = `I've analyzed the module and written the tests. Here's the summary:

{"testsWritten": 5, "testsPassed": 4, "testsFailed": 1, "files": ["src/booking/__tests__/booking.service.unit.test.ts", "src/booking/__tests__/booking.controller.api.test.ts", "src/booking/__tests__/booking.integration.test.ts"]}`;

      const result = parseCoverResponse(aiOutput);
      expect(result.testsWritten).toBe(5);
      expect(result.testsPassed).toBe(4);
      expect(result.testsFailed).toBe(1);
      expect(result.files).toHaveLength(3);
    });

    it("parses a response wrapped in markdown fences", () => {
      const aiOutput = `Here are the results:

\`\`\`json
{"testsWritten": 3, "testsPassed": 3, "testsFailed": 0, "files": ["src/utils/__tests__/helpers.test.ts"]}
\`\`\`

All tests pass!`;

      const result = parseCoverResponse(aiOutput);
      expect(result.testsWritten).toBe(3);
      expect(result.testsPassed).toBe(3);
      expect(result.testsFailed).toBe(0);
      expect(result.files).toEqual(["src/utils/__tests__/helpers.test.ts"]);
    });

    it("handles a response where AI failed to write any tests", () => {
      const aiOutput = `I was unable to write tests due to missing dependencies.

{"testsWritten": 0, "testsPassed": 0, "testsFailed": 0, "files": []}`;

      const result = parseCoverResponse(aiOutput);
      expect(result.testsWritten).toBe(0);
      expect(result.files).toEqual([]);
    });

    it("handles garbled AI response gracefully", () => {
      const aiOutput = `The task is complete but I can't format the output properly because
of an error in my reasoning. Tests were written to src/booking/__tests__/ directory.`;

      const result = parseCoverResponse(aiOutput);
      // Should return zeros since JSON couldn't be parsed
      expect(result.testsWritten).toBe(0);
      expect(result.testsPassed).toBe(0);
    });

    it("round-trips: prompt mentions output format that parseCoverResponse can parse", () => {
      const messages = buildCoverPrompt(lowComplexityGap, vitestProject);
      const system = messages[0]!.content;

      // The prompt should mention the expected output format
      expect(system).toContain('"testsWritten"');
      expect(system).toContain('"testsPassed"');
      expect(system).toContain('"testsFailed"');
      expect(system).toContain('"files"');

      // Simulate a valid AI response matching the format
      const simulatedResponse = '{"testsWritten": 6, "testsPassed": 6, "testsFailed": 0, "files": ["src/utils/__tests__/a.test.ts", "src/utils/__tests__/b.test.ts"]}';
      const parsed = parseCoverResponse(simulatedResponse);
      expect(parsed.testsWritten).toBe(6);
      expect(parsed.files).toHaveLength(2);
    });
  });

  describe("edge cases across frameworks", () => {
    it("handles all valid test types in gaps", () => {
      const allGaps: ModuleGap = {
        path: "src/complex",
        complexity: "high",
        gaps: {
          unit: { expected: 10, current: 5, gap: 5 },
          integration: { expected: 20, current: 10, gap: 10 },
          api: { expected: 8, current: 3, gap: 5 },
          e2e: { expected: 2, current: 0, gap: 2 },
          contract: { expected: 4, current: 2, gap: 2 },
        },
        totalGap: 24,
        existingTestFiles: [],
      };

      const messages = buildCoverPrompt(allGaps, nestjsProject);
      const system = messages[0]!.content;

      // Every gap type should appear
      expect(system).toContain("unit:");
      expect(system).toContain("integration:");
      expect(system).toContain("api:");
      expect(system).toContain("e2e:");
      expect(system).toContain("contract:");
    });

    it("handles single gap type", () => {
      const singleGap: ModuleGap = {
        path: "src/helpers",
        complexity: "low",
        gaps: {
          unit: { expected: 3, current: 0, gap: 3 },
        },
        totalGap: 3,
        existingTestFiles: [],
      };

      const messages = buildCoverPrompt(singleGap, vitestProject);
      const system = messages[0]!.content;

      expect(system).toContain("unit: need 3 more");
      expect(system).not.toContain("integration:");
    });
  });
});
