/**
 * Unit tests for src/cli/index.ts (the CLI entry point)
 *
 * Mocks Commander to capture action handlers, then tests each
 * handler in isolation with all external dependencies mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type ActionHandler = (...args: any[]) => Promise<void>;

// ─── Hoisted shared state (available to vi.mock factories) ──
const { actionHandlers, mockSpinner } = vi.hoisted(() => {
  const start = vi.fn();
  const stop = vi.fn();
  const succeed = vi.fn();
  const fail = vi.fn();
  const spinner = { start, stop, succeed, fail, text: "" };
  start.mockReturnValue(spinner);
  stop.mockReturnValue(spinner);
  succeed.mockReturnValue(spinner);
  fail.mockReturnValue(spinner);

  return {
    actionHandlers: new Map<string, ActionHandler>(),
    mockSpinner: spinner,
  };
});

// ─── Mock Commander ─────────────────────────────────────────
vi.mock("commander", () => ({
  Command: class {
    name() { return this; }
    version() { return this; }
    description() { return this; }
    option() { return this; }
    opts() { return {}; }
    hook() { return this; }
    parse() {}
    command(cmdName: string) {
      const b: Record<string, any> = {};
      b.argument = () => b;
      b.description = () => b;
      b.option = () => b;
      b.action = (fn: ActionHandler) => {
        actionHandlers.set(cmdName, fn);
        return b;
      };
      return b;
    }
  },
}));

// ─── Mock chalk (pass-through) ──────────────────────────────
vi.mock("chalk", () => {
  const h: ProxyHandler<any> = {
    get: () => new Proxy((...a: any[]) => a[0] ?? "", h),
    apply: (_t: any, _c: any, a: any[]) => a[0] ?? "",
  };
  return { default: new Proxy({}, h) };
});

// ─── Mock ora ───────────────────────────────────────────────
vi.mock("ora", () => ({
  default: vi.fn(() => mockSpinner),
}));

// ─── Mock all external dependencies ─────────────────────────
const mockScanCodebase = vi.fn();
const mockWriteManifest = vi.fn();
const mockReadManifest = vi.fn();
const mockCover = vi.fn();
const mockFixTests = vi.fn();
const mockRenderDashboard = vi.fn();

vi.mock("../../scale/analyzer.js", () => ({
  scanCodebase: (...args: unknown[]) => mockScanCodebase(...args),
}));

vi.mock("../../scale/writer.js", () => ({
  readManifest: (...args: unknown[]) => mockReadManifest(...args),
  writeManifest: (...args: unknown[]) => mockWriteManifest(...args),
}));

vi.mock("../../cover/pipeline.js", () => ({
  cover: (...args: unknown[]) => mockCover(...args),
}));

vi.mock("../../fix/pipeline.js", () => ({
  fixTests: (...args: unknown[]) => mockFixTests(...args),
}));

vi.mock("../../measure/dashboard.js", () => ({
  renderDashboard: (...args: unknown[]) => mockRenderDashboard(...args),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    table: vi.fn(),
  },
  setLogInterceptor: vi.fn(),
}));

const mockCliProvider = {
  name: "mock-provider",
  generate: vi.fn().mockResolvedValue({ content: "{}", model: "mock" }),
  isAvailable: vi.fn().mockResolvedValue(true),
};

vi.mock("../../ai/provider-factory.js", () => ({
  detectAllProviders: vi.fn(),
  getProviderDisplayName: vi.fn().mockReturnValue("Mock Provider"),
}));

vi.mock("../../integrations/useai.js", () => ({
  useaiStart: vi.fn().mockResolvedValue(null),
  useaiEnd: vi.fn().mockResolvedValue(undefined),
}));

// ─── Setup / teardown ───────────────────────────────────────
let mockExit: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  actionHandlers.clear();
  vi.clearAllMocks();

  // Re-set spinner chainable returns (vi.clearAllMocks resets mockReturnValue)
  mockSpinner.start.mockReturnValue(mockSpinner);
  mockSpinner.stop.mockReturnValue(mockSpinner);
  mockSpinner.succeed.mockReturnValue(mockSpinner);
  mockSpinner.fail.mockReturnValue(mockSpinner);

  // Re-set provider mock (vi.clearAllMocks resets mockResolvedValue)
  mockCliProvider.generate.mockResolvedValue({ content: "{}", model: "mock" });

  mockExit = vi
    .spyOn(process, "exit")
    .mockImplementation(() => undefined as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.resetModules();
  await import("../index.js");

  // Set up provider detection after import (so mock is fresh)
  const { detectAllProviders } = await import("../../ai/provider-factory.js");
  vi.mocked(detectAllProviders).mockResolvedValue([mockCliProvider]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Fixtures ───────────────────────────────────────────────
const sampleManifest = {
  version: 1,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
  project: {
    name: "test-project",
    root: "/tmp/test",
    language: "typescript",
    framework: "none",
    testFramework: "vitest",
    sourceFiles: 10,
    sourceLines: 500,
  },
  modules: [
    {
      path: "src/services",
      files: 5,
      lines: 300,
      complexity: "medium",
      functionality: {
        tests: { unit: { expected: 10, current: 5, files: ["test.ts"] } },
      },
      security: { issues: 0, resolved: 0, findings: [] },
      stability: { score: 80, gaps: [] },
      conformance: { score: 90, violations: [] },
    },
  ],
  journeys: [],
  contracts: [],
  score: {
    overall: 42,
    breakdown: {
      functionality: 50,
      security: 0,
      stability: 0,
      conformance: 0,
      regression: 0,
    },
    gaps: { total: 5, critical: 2, byDimension: {} },
    history: [],
  },
};

// ─── Unit Tests ─────────────────────────────────────────────

describe("CLI command registration (unit)", () => {
  it("registers all 5 commands: scan, cover, fix, status, clear", () => {
    expect(actionHandlers.size).toBe(5);
    expect(actionHandlers.has("scan")).toBe(true);
    expect(actionHandlers.has("cover")).toBe(true);
    expect(actionHandlers.has("fix")).toBe(true);
    expect(actionHandlers.has("status")).toBe(true);
    expect(actionHandlers.has("clear")).toBe(true);
  });
});

describe("scan handler (unit)", () => {
  it("calls scanCodebase, writeManifest, and renderDashboard on success", async () => {
    mockScanCodebase.mockResolvedValue(sampleManifest);
    mockWriteManifest.mockResolvedValue(undefined);

    const handler = actionHandlers.get("scan")!;
    await handler(".", {});

    expect(mockScanCodebase).toHaveBeenCalledTimes(1);
    expect(mockWriteManifest).toHaveBeenCalledTimes(1);
    expect(mockRenderDashboard).toHaveBeenCalledWith(sampleManifest);
    expect(mockSpinner.succeed).toHaveBeenCalledWith(
      expect.stringContaining("1 modules"),
    );
  });

  it("handles errors: shows failure message and exits with code 1", async () => {
    mockScanCodebase.mockRejectedValue(
      new Error("AI provider unavailable"),
    );

    const handler = actionHandlers.get("scan")!;
    await handler(".", {});

    expect(mockSpinner.fail).toHaveBeenCalledWith("Scan failed");
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockRenderDashboard).not.toHaveBeenCalled();
  });
});

describe("cover handler (unit)", () => {
  it("calls cover() with correct options and stops spinner on success", async () => {
    mockCover.mockResolvedValue({
      scoreBefore: 40,
      scoreAfter: 65,
      modulesProcessed: 3,
      testsGenerated: 12,
      testsPassed: 10,
      testsFailed: 2,
    });

    const handler = actionHandlers.get("cover")!;
    await handler(".", {});

    expect(mockCover).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: expect.any(String),
        modules: undefined,
      }),
    );
    expect(mockSpinner.stop).toHaveBeenCalled();
  });

  it("parses comma-separated --modules option into array", async () => {
    mockCover.mockResolvedValue({
      scoreBefore: 40,
      scoreAfter: 55,
      modulesProcessed: 2,
      testsGenerated: 5,
      testsPassed: 5,
      testsFailed: 0,
    });

    const handler = actionHandlers.get("cover")!;
    await handler(".", { modules: "src/a, src/b, src/c" });

    expect(mockCover).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: expect.any(String),
        modules: ["src/a", "src/b", "src/c"],
      }),
    );
  });

  it("handles cover errors: shows failure and exits with code 1", async () => {
    mockCover.mockRejectedValue(new Error("No coverit.json found"));

    const handler = actionHandlers.get("cover")!;
    await handler(".", {});

    expect(mockSpinner.fail).toHaveBeenCalledWith("Cover failed");
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

describe("fix handler (unit)", () => {
  it("calls fixTests() with correct options and stops spinner on success", async () => {
    mockFixTests.mockResolvedValue({
      scoreBefore: 40,
      scoreAfter: 45,
      totalTests: 20,
      passed: 18,
      failed: 2,
      fixed: 3,
    });

    const handler = actionHandlers.get("fix")!;
    await handler(".", {});

    expect(mockFixTests).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: expect.any(String),
        modules: undefined,
      }),
    );
    expect(mockSpinner.stop).toHaveBeenCalled();
  });

  it("parses comma-separated --modules option into array", async () => {
    mockFixTests.mockResolvedValue({
      scoreBefore: 40,
      scoreAfter: 42,
      totalTests: 10,
      passed: 10,
      failed: 0,
      fixed: 0,
    });

    const handler = actionHandlers.get("fix")!;
    await handler(".", { modules: "src/a, src/b" });

    expect(mockFixTests).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: expect.any(String),
        modules: ["src/a", "src/b"],
      }),
    );
  });

  it("handles fix errors: shows failure and exits with code 1", async () => {
    mockFixTests.mockRejectedValue(new Error("No coverit.json found"));

    const handler = actionHandlers.get("fix")!;
    await handler(".", {});

    expect(mockSpinner.fail).toHaveBeenCalledWith("Fix failed");
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

describe("status handler (unit)", () => {
  it("renders dashboard when manifest exists", async () => {
    mockReadManifest.mockResolvedValue(sampleManifest);

    const handler = actionHandlers.get("status")!;
    await handler(".");

    expect(mockReadManifest).toHaveBeenCalledTimes(1);
    expect(mockRenderDashboard).toHaveBeenCalledWith(sampleManifest);
  });

  it("warns when no manifest is found", async () => {
    mockReadManifest.mockResolvedValue(null);
    const { logger } = await import("../../utils/logger.js");

    const handler = actionHandlers.get("status")!;
    await handler(".");

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("No coverit.json found"),
    );
    expect(mockRenderDashboard).not.toHaveBeenCalled();
  });
});
