/**
 * Unit tests for cover-prompts.ts
 * Tests buildCoverPrompt and parseCoverResponse in isolation.
 */
import { describe, it, expect } from "vitest";
import {
  buildCoverPrompt,
  parseCoverResponse,
  type ModuleGap,
  type CoverAISummary,
} from "../cover-prompts.js";
import type { ManifestProject } from "../../schema/coverit-manifest.js";

// ─── Fixtures ────────────────────────────────────────────────

const mockProject: ManifestProject = {
  name: "test-project",
  root: "/tmp/test-project",
  language: "typescript",
  framework: "nestjs",
  testFramework: "vitest",
  sourceFiles: 50,
  sourceLines: 5000,
};

const mockGap: ModuleGap = {
  path: "src/services",
  complexity: "high",
  gaps: {
    unit: { expected: 12, current: 3, gap: 9 },
    integration: { expected: 20, current: 5, gap: 15 },
  },
  totalGap: 24,
  existingTestFiles: ["src/services/__tests__/auth.test.ts"],
};

const mockGapNoExistingTests: ModuleGap = {
  path: "src/utils",
  complexity: "low",
  gaps: {
    unit: { expected: 3, current: 0, gap: 3 },
  },
  totalGap: 3,
  existingTestFiles: [],
};

// ─── buildCoverPrompt ────────────────────────────────────────

describe("buildCoverPrompt", () => {
  it("returns a system and user message", () => {
    const messages = buildCoverPrompt(mockGap, mockProject);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.role).toBe("user");
  });

  it("includes module path in the system prompt", () => {
    const messages = buildCoverPrompt(mockGap, mockProject);
    expect(messages[0]!.content).toContain("src/services/");
  });

  it("includes gap descriptions in the system prompt", () => {
    const messages = buildCoverPrompt(mockGap, mockProject);
    const systemContent = messages[0]!.content;
    expect(systemContent).toContain("unit: need 9 more (3/12)");
    expect(systemContent).toContain("integration: need 15 more (5/20)");
  });

  it("includes existing test files when present", () => {
    const messages = buildCoverPrompt(mockGap, mockProject);
    const systemContent = messages[0]!.content;
    expect(systemContent).toContain("src/services/__tests__/auth.test.ts");
    expect(systemContent).toContain("Existing test files for this module:");
  });

  it("indicates no existing tests when list is empty", () => {
    const messages = buildCoverPrompt(mockGapNoExistingTests, mockProject);
    const systemContent = messages[0]!.content;
    expect(systemContent).toContain("No existing test files for this module.");
  });

  it("includes project language and framework", () => {
    const messages = buildCoverPrompt(mockGap, mockProject);
    const systemContent = messages[0]!.content;
    expect(systemContent).toContain("typescript");
    expect(systemContent).toContain("nestjs");
  });

  it("includes test framework in system prompt", () => {
    const messages = buildCoverPrompt(mockGap, mockProject);
    const systemContent = messages[0]!.content;
    expect(systemContent).toContain("vitest");
    expect(systemContent).toContain("describe/it/expect from 'vitest'");
  });

  it("uses jest describe for jest projects", () => {
    const jestProject: ManifestProject = {
      ...mockProject,
      testFramework: "jest",
    };
    const messages = buildCoverPrompt(mockGap, jestProject);
    const systemContent = messages[0]!.content;
    expect(systemContent).toContain("describe/it/expect from @jest/globals or global jest");
  });

  it("uses vitest run command for vitest projects", () => {
    const messages = buildCoverPrompt(mockGap, mockProject);
    const systemContent = messages[0]!.content;
    expect(systemContent).toContain("npx vitest run");
  });

  it("uses jest command for jest projects", () => {
    const jestProject: ManifestProject = {
      ...mockProject,
      testFramework: "jest",
    };
    const messages = buildCoverPrompt(mockGap, jestProject);
    const systemContent = messages[0]!.content;
    expect(systemContent).toContain("npx jest");
  });

  it("includes total gap count in user message", () => {
    const messages = buildCoverPrompt(mockGap, mockProject);
    const userContent = messages[1]!.content;
    expect(userContent).toContain("24 test gaps");
  });

  it("includes complexity level in system prompt", () => {
    const messages = buildCoverPrompt(mockGap, mockProject);
    const systemContent = messages[0]!.content;
    expect(systemContent).toContain("high complexity");
  });

  it("includes JSON output format instructions", () => {
    const messages = buildCoverPrompt(mockGap, mockProject);
    const systemContent = messages[0]!.content;
    expect(systemContent).toContain("testsWritten");
    expect(systemContent).toContain("testsPassed");
    expect(systemContent).toContain("testsFailed");
  });
});

// ─── parseCoverResponse ──────────────────────────────────────

describe("parseCoverResponse", () => {
  it("parses a clean JSON response", () => {
    const raw = '{"testsWritten": 5, "testsPassed": 4, "testsFailed": 1, "files": ["a.test.ts", "b.test.ts"]}';
    const result = parseCoverResponse(raw);
    expect(result.testsWritten).toBe(5);
    expect(result.testsPassed).toBe(4);
    expect(result.testsFailed).toBe(1);
    expect(result.files).toEqual(["a.test.ts", "b.test.ts"]);
  });

  it("strips markdown code fences", () => {
    const raw = '```json\n{"testsWritten": 3, "testsPassed": 3, "testsFailed": 0, "files": ["x.test.ts"]}\n```';
    const result = parseCoverResponse(raw);
    expect(result.testsWritten).toBe(3);
    expect(result.testsPassed).toBe(3);
  });

  it("finds JSON with testsWritten key in surrounding text", () => {
    const raw = 'Here is the summary:\n{"testsWritten": 2, "testsPassed": 2, "testsFailed": 0, "files": ["y.test.ts"]}\nDone!';
    const result = parseCoverResponse(raw);
    expect(result.testsWritten).toBe(2);
    expect(result.files).toEqual(["y.test.ts"]);
  });

  it("falls back to generic JSON extraction", () => {
    const raw = 'Some text before {"result": "ok", "files": ["z.test.ts"]} some text after';
    const result = parseCoverResponse(raw);
    // Without testsWritten key, should extract generic JSON and default to 0
    expect(result.testsWritten).toBe(0);
  });

  it("returns zeros for completely unparseable input", () => {
    const raw = "This is not JSON at all!";
    const result = parseCoverResponse(raw);
    expect(result.testsWritten).toBe(0);
    expect(result.testsPassed).toBe(0);
    expect(result.testsFailed).toBe(0);
    expect(result.files).toEqual([]);
  });

  it("handles missing fields gracefully with defaults", () => {
    const raw = '{"testsWritten": 1}';
    const result = parseCoverResponse(raw);
    expect(result.testsWritten).toBe(1);
    expect(result.testsPassed).toBe(0);
    expect(result.testsFailed).toBe(0);
    expect(result.files).toEqual([]);
  });

  it("filters out non-string entries from files array", () => {
    const raw = '{"testsWritten": 1, "testsPassed": 1, "testsFailed": 0, "files": ["valid.test.ts", 123, null, "also-valid.test.ts"]}';
    const result = parseCoverResponse(raw);
    expect(result.files).toEqual(["valid.test.ts", "also-valid.test.ts"]);
  });

  it("handles non-number values for numeric fields", () => {
    const raw = '{"testsWritten": "five", "testsPassed": true, "testsFailed": null, "files": []}';
    const result = parseCoverResponse(raw);
    expect(result.testsWritten).toBe(0);
    expect(result.testsPassed).toBe(0);
    expect(result.testsFailed).toBe(0);
  });

  it("handles code fences without json language tag", () => {
    const raw = '```\n{"testsWritten": 7, "testsPassed": 7, "testsFailed": 0, "files": []}\n```';
    const result = parseCoverResponse(raw);
    expect(result.testsWritten).toBe(7);
  });

  it("handles empty string input", () => {
    const result = parseCoverResponse("");
    expect(result.testsWritten).toBe(0);
    expect(result.files).toEqual([]);
  });
});
