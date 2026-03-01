/**
 * Integration tests for src/cli/index.ts
 *
 * Tests CLI command handlers with real filesystem operations.
 * Commander is mocked to capture handlers, but filesystem I/O
 * and manifest reading/writing use real implementations.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type ActionHandler = (...args: any[]) => Promise<void>;

// ─── Hoisted shared state ───────────────────────────────────
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

// ─── Mock only AI-heavy dependencies ────────────────────────
// analyzer.js and pipeline.js require AI providers — must mock
vi.mock("../../scale/analyzer.js", () => ({
  scanCodebase: vi.fn(),
}));

vi.mock("../../cover/pipeline.js", () => ({
  cover: vi.fn(),
}));

vi.mock("../../run/pipeline.js", () => ({
  runTests: vi.fn(),
}));

// Mock renderDashboard to prevent stdout pollution
vi.mock("../../measure/dashboard.js", () => ({
  renderDashboard: vi.fn(),
}));

// Mock logger to suppress output and enable call assertions
vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    table: vi.fn(),
  },
}));

vi.mock("../../ai/provider-factory.js", () => ({
  detectAllProviders: vi.fn(),
  getProviderDisplayName: vi.fn().mockReturnValue("Mock Provider"),
}));

vi.mock("../../integrations/useai.js", () => ({
  useaiStart: vi.fn().mockResolvedValue(null),
  useaiEnd: vi.fn().mockResolvedValue(undefined),
}));

// Leave writer.js REAL for filesystem integration tests

// ─── Temp directory helpers ─────────────────────────────────
const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "coverit-cli-test-"));
  tempDirs.push(dir);
  return dir;
}

// ─── Setup / teardown ───────────────────────────────────────
beforeEach(async () => {
  actionHandlers.clear();
  vi.clearAllMocks();

  // Re-set spinner chainable returns (vi.clearAllMocks resets mockReturnValue)
  mockSpinner.start.mockReturnValue(mockSpinner);
  mockSpinner.stop.mockReturnValue(mockSpinner);
  mockSpinner.succeed.mockReturnValue(mockSpinner);
  mockSpinner.fail.mockReturnValue(mockSpinner);

  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.resetModules();
  await import("../index.js");
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

// ─── Fixtures ───────────────────────────────────────────────
const sampleManifest = {
  version: 1,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
  project: {
    name: "integration-test-project",
    root: "/tmp/test",
    language: "typescript",
    framework: "none",
    testFramework: "vitest",
    sourceFiles: 5,
    sourceLines: 200,
  },
  modules: [],
  journeys: [],
  contracts: [],
  score: {
    overall: 0,
    breakdown: {
      functionality: 0,
      security: 0,
      stability: 0,
      conformance: 0,
      regression: 0,
    },
    gaps: { total: 0, critical: 0, byDimension: {} },
    history: [],
  },
};

// ─── clear command: integration tests ───────────────────────

describe("clear command (integration)", () => {
  it("deletes both coverit.json and .coverit/ directory from disk", async () => {
    const dir = createTempDir();

    // Create coverit.json and .coverit/ with a nested file
    writeFileSync(join(dir, "coverit.json"), JSON.stringify({ version: 1 }));
    mkdirSync(join(dir, ".coverit"));
    writeFileSync(join(dir, ".coverit", "data.json"), "{}");

    // Verify files exist before clear
    expect(existsSync(join(dir, "coverit.json"))).toBe(true);
    expect(existsSync(join(dir, ".coverit"))).toBe(true);

    const handler = actionHandlers.get("clear")!;
    await handler(dir, {});

    // Both should be deleted
    expect(existsSync(join(dir, "coverit.json"))).toBe(false);
    expect(existsSync(join(dir, ".coverit"))).toBe(false);

    // Verify success message mentions deleted items
    const { logger } = await import("../../utils/logger.js");
    expect(logger.success).toHaveBeenCalledWith(
      expect.stringContaining("coverit.json"),
    );
  });

  it("with --manifest-only: deletes only coverit.json, preserves .coverit/", async () => {
    const dir = createTempDir();

    writeFileSync(join(dir, "coverit.json"), "{}");
    mkdirSync(join(dir, ".coverit"));
    writeFileSync(join(dir, ".coverit", "data.json"), "{}");

    const handler = actionHandlers.get("clear")!;
    await handler(dir, { manifestOnly: true });

    // coverit.json deleted, .coverit preserved
    expect(existsSync(join(dir, "coverit.json"))).toBe(false);
    expect(existsSync(join(dir, ".coverit"))).toBe(true);
    expect(existsSync(join(dir, ".coverit", "data.json"))).toBe(true);
  });

  it("warns when there is nothing to clear", async () => {
    const dir = createTempDir();
    // Empty dir — no coverit.json, no .coverit/

    const handler = actionHandlers.get("clear")!;
    await handler(dir, {});

    const { logger } = await import("../../utils/logger.js");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Nothing to clear"),
    );
  });
});

// ─── status command: integration tests ──────────────────────

describe("status command (integration)", () => {
  it("reads coverit.json from disk and passes manifest to renderDashboard", async () => {
    const dir = createTempDir();

    // Write a real coverit.json to the temp directory
    writeFileSync(
      join(dir, "coverit.json"),
      JSON.stringify(sampleManifest, null, 2),
    );

    const { renderDashboard } = await import("../../measure/dashboard.js");

    const handler = actionHandlers.get("status")!;
    await handler(dir);

    expect(renderDashboard).toHaveBeenCalledTimes(1);
    expect(renderDashboard).toHaveBeenCalledWith(
      expect.objectContaining({
        project: expect.objectContaining({
          name: "integration-test-project",
        }),
        version: 1,
      }),
    );
  });

  it("warns when no coverit.json exists on disk", async () => {
    const dir = createTempDir();
    // No coverit.json in the temp dir

    const { logger } = await import("../../utils/logger.js");

    const handler = actionHandlers.get("status")!;
    await handler(dir);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("No coverit.json found"),
    );

    const { renderDashboard } = await import("../../measure/dashboard.js");
    expect(renderDashboard).not.toHaveBeenCalled();
  });
});
