/**
 * Integration tests for analyzer.ts
 * Tests the full scanCodebase pipeline with a realistic mock AI provider,
 * real scoring engine, real project info detection, and real writer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Only mock the AI and external detection — let scoring engine and writer be real
vi.mock("../../utils/framework-detector.js", () => ({
  detectProjectInfo: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock writer.readManifest but use real scoring engine
vi.mock("../writer.js", () => ({
  readManifest: vi.fn(),
}));

vi.mock("../../ai/security-prompts.js", () => ({
  buildSecurityPrompt: vi.fn().mockReturnValue([
    { role: "user", content: "Security prompt" },
  ]),
  parseSecurityResponse: vi.fn().mockReturnValue({ modules: [] }),
}));

vi.mock("../../ai/stability-prompts.js", () => ({
  buildStabilityPrompt: vi.fn().mockReturnValue([
    { role: "user", content: "Stability prompt" },
  ]),
  parseStabilityResponse: vi.fn().mockReturnValue({ modules: [] }),
}));

vi.mock("../../ai/conformance-prompts.js", () => ({
  buildConformancePrompt: vi.fn().mockReturnValue([
    { role: "user", content: "Conformance prompt" },
  ]),
  parseConformanceResponse: vi.fn().mockReturnValue({ modules: [] }),
}));

vi.mock("../../run/pipeline.js", () => ({
  collectTestFiles: vi.fn().mockReturnValue([]),
  detectTestRunner: vi.fn().mockReturnValue("jest"),
  executeTests: vi.fn().mockResolvedValue({ total: 0, passed: 0, failed: 0 }),
}));

vi.mock("../../utils/scan-logger.js", () => ({
  ScanLogger: vi.fn().mockImplementation(() => ({
    record: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    path: "/tmp/.coverit/scan.log",
  })),
}));

vi.mock("../../integrations/useai.js", () => ({
  useaiHeartbeat: vi.fn().mockResolvedValue(undefined),
}));

import { scanCodebase } from "../analyzer.js";
import { detectProjectInfo } from "../../utils/framework-detector.js";
import { readManifest } from "../writer.js";
import type { AIProvider, AIResponse, AIMessage, AIGenerateOptions } from "../../ai/types.js";
import type { ProjectInfo } from "../../types/index.js";
import type { ScaleAIResponse } from "../../ai/scale-prompts.js";

// ─── Realistic AI Provider Mock ──────────────────────────────

/**
 * Creates a mock AI provider that returns a realistic JSON response.
 * Simulates what a real AI would return after exploring a codebase.
 */
function createRealisticProvider(aiResponse: ScaleAIResponse): AIProvider {
  return {
    name: "test-provider",
    generate: vi.fn(async (_messages: AIMessage[], _options?: AIGenerateOptions): Promise<AIResponse> => {
      return {
        content: JSON.stringify(aiResponse),
        model: "test-model",
        tokensUsed: 5000,
      };
    }),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
}

// ─── Realistic Fixtures ──────────────────────────────────────

const nestjsProjectInfo: ProjectInfo = {
  name: "booking-api",
  root: "/home/user/booking-api",
  language: "typescript",
  framework: "nestjs",
  testFramework: "jest",
  packageManager: "pnpm",
  hasExistingTests: true,
  existingTestPatterns: ["*.spec.ts", "*.e2e-spec.ts"],
};

const fullAIAnalysis: ScaleAIResponse = {
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
      name: "Search -> Book -> Pay -> Confirm",
      steps: ["Search available rooms", "Select room", "Enter payment", "Confirm booking"],
      covered: false,
      testFile: null,
    },
    {
      id: "j2",
      name: "Login -> View Dashboard",
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

// ─── Tests ───────────────────────────────────────────────────

describe("analyzer integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(detectProjectInfo).mockResolvedValue(nestjsProjectInfo);
    vi.mocked(readManifest).mockResolvedValue(null);
  });

  describe("full analysis pipeline", () => {
    it("produces a complete manifest from AI analysis of a NestJS project", async () => {
      const provider = createRealisticProvider(fullAIAnalysis);

      const manifest = await scanCodebase("/home/user/booking-api", provider);

      // Top-level structure
      expect(manifest.version).toBe(1);
      expect(manifest.createdAt).toBeTruthy();
      expect(manifest.updatedAt).toBeTruthy();

      // Project metadata from detectProjectInfo
      expect(manifest.project.name).toBe("booking-api");
      expect(manifest.project.framework).toBe("nestjs");
      expect(manifest.project.testFramework).toBe("jest");
      expect(manifest.project.sourceFiles).toBe(85);
      expect(manifest.project.sourceLines).toBe(12500);

      // Modules from AI analysis
      expect(manifest.modules).toHaveLength(3);
      expect(manifest.modules.map((m) => m.path)).toEqual([
        "src/booking",
        "src/auth",
        "src/utils",
      ]);

      // Journeys and contracts
      expect(manifest.journeys).toHaveLength(2);
      expect(manifest.contracts).toHaveLength(2);

      // Score computed by real engine
      expect(manifest.score.overall).toBeGreaterThanOrEqual(0);
      expect(manifest.score.overall).toBeLessThanOrEqual(100);
      expect(manifest.score.breakdown.functionality).toBeGreaterThan(0);
    });

    it("correctly maps module complexity and test coverage", async () => {
      const provider = createRealisticProvider(fullAIAnalysis);

      const manifest = await scanCodebase("/home/user/booking-api", provider);

      const booking = manifest.modules.find((m) => m.path === "src/booking")!;
      expect(booking.complexity).toBe("high");
      expect(booking.functionality.tests.unit!.expected).toBe(12);
      expect(booking.functionality.tests.unit!.current).toBe(4);
      expect(booking.functionality.tests.e2e!.current).toBe(0);

      const auth = manifest.modules.find((m) => m.path === "src/auth")!;
      expect(auth.complexity).toBe("medium");
      expect(auth.functionality.tests.unit!.expected).toBe(6);
      expect(auth.functionality.tests.unit!.current).toBe(6); // fully covered

      const utils = manifest.modules.find((m) => m.path === "src/utils")!;
      expect(utils.complexity).toBe("low");
    });

    it("has a functionality score reflecting partial test coverage", async () => {
      const provider = createRealisticProvider(fullAIAnalysis);

      const manifest = await scanCodebase("/home/user/booking-api", provider);

      // src/booking: low coverage, src/auth: partial, src/utils: full coverage
      // Weighted by complexity: high=3, medium=2, low=1
      const funcScore = manifest.score.breakdown.functionality;
      expect(funcScore).toBeGreaterThan(0);
      expect(funcScore).toBeLessThan(100); // not fully covered
    });

    it("includes functionality gap count in score summary", async () => {
      const provider = createRealisticProvider(fullAIAnalysis);

      const manifest = await scanCodebase("/home/user/booking-api", provider);

      // There are missing tests across modules
      expect(manifest.score.gaps.total).toBeGreaterThan(0);
      expect(manifest.score.gaps.byDimension.functionality.missing).toBeGreaterThan(0);
    });
  });

  describe("scoring integration", () => {
    it("scores 0 functionality when all modules have zero current tests", async () => {
      const emptyTestsResponse: ScaleAIResponse = {
        sourceFiles: 10,
        sourceLines: 1000,
        modules: [
          {
            path: "src/services",
            files: 5,
            lines: 500,
            complexity: "medium",
            functionality: {
              tests: {
                unit: { expected: 6, current: 0, files: [] },
                integration: { expected: 10, current: 0, files: [] },
              },
            },
          },
        ],
        journeys: [],
        contracts: [],
      };
      const provider = createRealisticProvider(emptyTestsResponse);

      const manifest = await scanCodebase("/home/user/booking-api", provider);

      expect(manifest.score.breakdown.functionality).toBe(0);
    });

    it("scores higher when modules have full test coverage", async () => {
      const fullCoverageResponse: ScaleAIResponse = {
        sourceFiles: 10,
        sourceLines: 1000,
        modules: [
          {
            path: "src/services",
            files: 5,
            lines: 500,
            complexity: "medium",
            functionality: {
              tests: {
                unit: { expected: 6, current: 6, files: ["a.test.ts"] },
                integration: { expected: 10, current: 10, files: ["b.test.ts"] },
                api: { expected: 4, current: 4, files: ["c.test.ts"] },
              },
            },
          },
        ],
        journeys: [],
        contracts: [],
      };
      const provider = createRealisticProvider(fullCoverageResponse);

      const manifest = await scanCodebase("/home/user/booking-api", provider);

      expect(manifest.score.breakdown.functionality).toBe(100);
    });

    it("higher complexity modules have more influence on the overall functionality score", async () => {
      // High-complexity module with full coverage + low-complexity module with zero coverage
      const weightedResponse: ScaleAIResponse = {
        sourceFiles: 20,
        sourceLines: 3000,
        modules: [
          {
            path: "src/core",
            files: 15,
            lines: 2500,
            complexity: "high",
            functionality: {
              tests: {
                unit: { expected: 12, current: 12, files: [] },
                integration: { expected: 20, current: 20, files: [] },
              },
            },
          },
          {
            path: "src/utils",
            files: 3,
            lines: 100,
            complexity: "low",
            functionality: {
              tests: {
                unit: { expected: 3, current: 0, files: [] },
              },
            },
          },
        ],
        journeys: [],
        contracts: [],
      };
      const provider = createRealisticProvider(weightedResponse);

      const manifest = await scanCodebase("/home/user/booking-api", provider);

      // High-complexity module (weight=3) is fully covered, low (weight=1) is 0
      // Score should be heavily influenced by the high module: (100*3 + 0*1) / (3+1) = 75
      expect(manifest.score.breakdown.functionality).toBeGreaterThanOrEqual(70);
    });
  });

  describe("AI provider interaction", () => {
    it("passes correct tools and working directory to AI provider", async () => {
      const provider = createRealisticProvider(fullAIAnalysis);

      await scanCodebase("/home/user/booking-api", provider);

      expect(provider.generate).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ role: "system" }),
          expect.objectContaining({ role: "user" }),
        ]),
        expect.objectContaining({
          allowedTools: ["Read", "Glob", "Grep", "Bash"],
          cwd: "/home/user/booking-api",
          timeoutMs: 1_200_000,
        }),
      );
    });

    it("user prompt includes project-specific context", async () => {
      const provider = createRealisticProvider(fullAIAnalysis);

      await scanCodebase("/home/user/booking-api", provider);

      const callArgs = vi.mocked(provider.generate).mock.calls[0]!;
      const messages = callArgs[0] as AIMessage[];
      const userMsg = messages.find((m) => m.role === "user")!;

      expect(userMsg.content).toContain("booking-api");
      expect(userMsg.content).toContain("nestjs");
      expect(userMsg.content).toContain("jest");
    });
  });

  describe("incremental analysis", () => {
    it("passes existing manifest to prompt builder for incremental analysis", async () => {
      const existingManifest = {
        version: 1 as const,
        createdAt: "2024-01-01",
        updatedAt: "2024-01-15",
        project: {
          name: "booking-api",
          root: "/home/user/booking-api",
          language: "typescript" as const,
          framework: "nestjs" as const,
          testFramework: "jest" as const,
          sourceFiles: 80,
          sourceLines: 11000,
        },
        dimensions: {
          functionality: { enabled: true, weight: 0.35, targets: { unit: { coverage: "critical-paths" as const }, integration: { coverage: "all-boundaries" as const }, api: { coverage: "all-endpoints" as const }, e2e: { coverage: "critical-journeys" as const }, contract: { coverage: "all-public-apis" as const } } },
          security: { enabled: true, weight: 0.25, checks: [] as any[] },
          stability: { enabled: true, weight: 0.15, checks: [] as any[] },
          conformance: { enabled: true, weight: 0.15, checks: [] as any[] },
          regression: { enabled: true, weight: 0.10, strategy: "all-existing-tests-pass" as const },
        },
        modules: [
          {
            path: "src/booking",
            files: 14,
            lines: 2800,
            complexity: "high" as const,
            functionality: { tests: { unit: { expected: 12, current: 4, files: [] } } },
            security: { issues: 0, resolved: 0, findings: [] },
            stability: { score: 70, gaps: [] },
            conformance: { score: 85, violations: [] },
          },
        ],
        journeys: [],
        contracts: [],
        score: {
          overall: 40,
          breakdown: { functionality: 40, security: 0, stability: 0, conformance: 0, regression: 0 },
          gaps: { total: 10, critical: 0, byDimension: { functionality: { missing: 10, priority: "high" }, security: { issues: 0, priority: "none" }, stability: { gaps: 0, priority: "none" }, conformance: { violations: 0, priority: "none" } } },
          history: [{ date: "2024-01-01", score: 40, scope: "first-time" }],
          scanned: { functionality: "2024-01-01" },
        },
      };

      vi.mocked(readManifest).mockResolvedValue(existingManifest as any);
      const provider = createRealisticProvider(fullAIAnalysis);

      const manifest = await scanCodebase("/home/user/booking-api", provider);

      // Preserves original createdAt
      expect(manifest.createdAt).toBe("2024-01-01");

      // Preserves existing dimensions
      expect(manifest.dimensions).toEqual(existingManifest.dimensions);

      // History includes original + new entry
      expect(manifest.score.history.length).toBeGreaterThanOrEqual(2);
      expect(manifest.score.history[0]!.scope).toBe("first-time");
      expect(manifest.score.history[manifest.score.history.length - 1]!.scope).toBe("re-analysis");

      // Preserves scanned dates from existing + adds new functionality scan
      expect(manifest.score.scanned?.functionality).toBeTruthy();
    });
  });

  describe("edge cases", () => {
    it("handles AI returning empty modules list", async () => {
      const emptyResponse: ScaleAIResponse = {
        sourceFiles: 0,
        sourceLines: 0,
        modules: [],
        journeys: [],
        contracts: [],
      };
      const provider = createRealisticProvider(emptyResponse);

      const manifest = await scanCodebase("/home/user/booking-api", provider);

      expect(manifest.modules).toEqual([]);
      expect(manifest.score.breakdown.functionality).toBe(0);
    });

    it("handles AI response wrapped in markdown code fences", async () => {
      const provider: AIProvider = {
        name: "verbose-ai",
        generate: vi.fn().mockResolvedValue({
          content: "```json\n" + JSON.stringify(fullAIAnalysis) + "\n```",
          model: "verbose-model",
        }),
        isAvailable: vi.fn().mockResolvedValue(true),
      };

      const manifest = await scanCodebase("/home/user/booking-api", provider);

      expect(manifest.modules).toHaveLength(3);
      expect(manifest.project.sourceFiles).toBe(85);
    });
  });
});
