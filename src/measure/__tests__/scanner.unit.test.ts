/**
 * Unit tests for scanner.ts
 * Tests scanTests with mocked filesystem and glob dependencies.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fast-glob", () => ({
  default: vi.fn(),
}));

const { mockReadFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({
  default: { readFile: mockReadFile },
  readFile: mockReadFile,
}));

import fg from "fast-glob";
import { scanTests } from "../scanner.js";
import type { ModuleEntry } from "../../schema/coverit-manifest.js";

// --- Fixtures ---

function makeModule(path: string): ModuleEntry {
  return {
    path,
    files: 5,
    lines: 500,
    complexity: "medium",
    functionality: {
      tests: {
        unit: { expected: 6, current: 0, files: [] },
      },
    },
    security: { issues: 0, resolved: 0, findings: [] },
    stability: { score: 80, gaps: [] },
    conformance: { score: 90, violations: [] },
  };
}

// --- Tests ---

describe("scanTests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty ScanResult when no test files are discovered", async () => {
    vi.mocked(fg).mockResolvedValue([]);
    const modules = [makeModule("src/services")];

    const result = await scanTests("/project", modules);

    expect(result.totalTestFiles).toBe(0);
    expect(result.totalTestCount).toBe(0);
    expect(result.byModule.size).toBe(1);
    // Module still initialized but with empty tests
    expect(result.byModule.get("src/services")!.tests).toEqual({});
  });

  it("maps discovered test files to modules and classifies types correctly", async () => {
    vi.mocked(fg).mockResolvedValue([
      "/project/src/services/__tests__/booking.test.ts",
      "/project/src/services/__tests__/booking.e2e-spec.ts",
    ]);

    // Unit test file
    mockReadFile
      .mockResolvedValueOnce(
        `describe("booking", () => {
  it("should create a booking", () => {});
  it("should cancel a booking", () => {});
});` as any,
      )
      // E2E test file
      .mockResolvedValueOnce(
        `describe("booking e2e", () => {
  test("should complete booking flow", () => {});
});` as any,
      );

    const modules = [makeModule("src/services")];
    const result = await scanTests("/project", modules);

    expect(result.totalTestFiles).toBe(2);
    expect(result.totalTestCount).toBe(3);

    const svcData = result.byModule.get("src/services")!;
    expect(svcData.tests.unit).toEqual({
      current: 2,
      files: ["src/services/__tests__/booking.test.ts"],
    });
    expect(svcData.tests.e2e).toEqual({
      current: 1,
      files: ["src/services/__tests__/booking.e2e-spec.ts"],
    });
  });

  it("accumulates counts from multiple test files for the same module and type", async () => {
    vi.mocked(fg).mockResolvedValue([
      "/project/src/utils/helpers.test.ts",
      "/project/src/utils/format.test.ts",
    ]);

    mockReadFile
      .mockResolvedValueOnce(
        `it("helper 1", () => {});
it("helper 2", () => {});` as any,
      )
      .mockResolvedValueOnce(
        `test("format date", () => {});` as any,
      );

    const modules = [makeModule("src/utils")];
    const result = await scanTests("/project", modules);

    expect(result.totalTestFiles).toBe(2);
    expect(result.totalTestCount).toBe(3);

    const utilsData = result.byModule.get("src/utils")!;
    expect(utilsData.tests.unit!.current).toBe(3);
    expect(utilsData.tests.unit!.files).toEqual([
      "src/utils/helpers.test.ts",
      "src/utils/format.test.ts",
    ]);
  });

  it("skips files with zero test count", async () => {
    vi.mocked(fg).mockResolvedValue([
      "/project/src/services/empty.test.ts",
    ]);

    // File with describe but no it/test calls
    mockReadFile.mockResolvedValueOnce(
      `describe("empty", () => {
  // TODO: add tests
});` as any,
    );

    const modules = [makeModule("src/services")];
    const result = await scanTests("/project", modules);

    expect(result.totalTestFiles).toBe(0);
    expect(result.totalTestCount).toBe(0);
  });

  it("handles test files that match no module", async () => {
    vi.mocked(fg).mockResolvedValue([
      "/project/test/global.test.ts",
    ]);

    mockReadFile.mockResolvedValueOnce(
      `it("global test", () => {});` as any,
    );

    // Module is src/services, but test file is test/global.test.ts — no prefix match
    const modules = [makeModule("src/services")];
    const result = await scanTests("/project", modules);

    // File is counted globally but NOT mapped to any module
    expect(result.totalTestFiles).toBe(1);
    expect(result.totalTestCount).toBe(1);
    expect(result.byModule.get("src/services")!.tests).toEqual({});
  });

  it("classifies integration tests from content containing createTestingModule", async () => {
    vi.mocked(fg).mockResolvedValue([
      "/project/src/services/__tests__/booking.test.ts",
    ]);

    mockReadFile.mockResolvedValueOnce(
      `import { Test } from "@nestjs/testing";
describe("BookingService integration", () => {
  it("creates a booking via DI", async () => {
    const module = await Test.createTestingModule({}).compile();
  });
});` as any,
    );

    const modules = [makeModule("src/services")];
    const result = await scanTests("/project", modules);

    const svcData = result.byModule.get("src/services")!;
    expect(svcData.tests.integration).toBeDefined();
    expect(svcData.tests.integration!.current).toBe(1);
  });
});
