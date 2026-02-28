/**
 * Unit tests for scanner.ts — classification and counting logic
 * Tests classifyTestType content heuristics, countTests edge cases,
 * and findNearestModule with nested modules via the public scanTests API.
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

describe("scanner — classifyTestType content heuristics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("classifies as api when content contains supertest import", async () => {
    vi.mocked(fg).mockResolvedValue([
      "/project/src/services/__tests__/booking.test.ts",
    ]);

    mockReadFile.mockResolvedValueOnce(
      `import request from "supertest";
import { app } from "../app";
describe("Booking API", () => {
  it("POST /bookings creates a booking", async () => {
    const res = await request(app).post("/bookings").send({ date: "2024-01-01" });
    expect(res.status).toBe(201);
  });
});` as any,
    );

    const modules = [makeModule("src/services")];
    const result = await scanTests("/project", modules);

    const svcData = result.byModule.get("src/services")!;
    expect(svcData.tests.api).toBeDefined();
    expect(svcData.tests.api!.current).toBe(1);
  });

  it("classifies as e2e when content contains playwright page.goto", async () => {
    vi.mocked(fg).mockResolvedValue([
      "/project/src/services/__tests__/checkout.test.ts",
    ]);

    mockReadFile.mockResolvedValueOnce(
      `import { test, expect } from "@playwright/test";
test("checkout flow works end to end", async ({ page }) => {
  await page.goto("/checkout");
  await page.click("button.submit");
});` as any,
    );

    const modules = [makeModule("src/services")];
    const result = await scanTests("/project", modules);

    const svcData = result.byModule.get("src/services")!;
    expect(svcData.tests.e2e).toBeDefined();
    expect(svcData.tests.e2e!.current).toBe(1);
  });

  it("classifies as contract when content contains pactum", async () => {
    vi.mocked(fg).mockResolvedValue([
      "/project/src/services/__tests__/api-contract.test.ts",
    ]);

    mockReadFile.mockResolvedValueOnce(
      `import { spec } from "pactum";
describe("API contract", () => {
  it("validates booking response schema", async () => {
    await spec().get("/api/bookings").expectStatus(200);
  });
});` as any,
    );

    const modules = [makeModule("src/services")];
    const result = await scanTests("/project", modules);

    const svcData = result.byModule.get("src/services")!;
    expect(svcData.tests.contract).toBeDefined();
    expect(svcData.tests.contract!.current).toBe(1);
  });

  it("classifies as api when file path contains .api in the name", async () => {
    vi.mocked(fg).mockResolvedValue([
      "/project/src/services/booking.api.test.ts",
    ]);

    mockReadFile.mockResolvedValueOnce(
      `describe("Booking API tests", () => {
  it("returns bookings", () => {});
});` as any,
    );

    const modules = [makeModule("src/services")];
    const result = await scanTests("/project", modules);

    const svcData = result.byModule.get("src/services")!;
    expect(svcData.tests.api).toBeDefined();
    expect(svcData.tests.api!.current).toBe(1);
  });

  it("classifies as contract when path contains /contracts/", async () => {
    vi.mocked(fg).mockResolvedValue([
      "/project/src/services/contracts/booking.test.ts",
    ]);

    mockReadFile.mockResolvedValueOnce(
      `describe("booking contract", () => {
  it("validates schema", () => {});
});` as any,
    );

    const modules = [makeModule("src/services")];
    const result = await scanTests("/project", modules);

    const svcData = result.byModule.get("src/services")!;
    expect(svcData.tests.contract).toBeDefined();
    expect(svcData.tests.contract!.current).toBe(1);
  });

  it("defaults to unit when no filename or content signals match", async () => {
    vi.mocked(fg).mockResolvedValue([
      "/project/src/services/__tests__/utils.test.ts",
    ]);

    mockReadFile.mockResolvedValueOnce(
      `describe("utils", () => {
  it("adds two numbers", () => {
    expect(1 + 2).toBe(3);
  });
});` as any,
    );

    const modules = [makeModule("src/services")];
    const result = await scanTests("/project", modules);

    const svcData = result.byModule.get("src/services")!;
    expect(svcData.tests.unit).toBeDefined();
    expect(svcData.tests.unit!.current).toBe(1);
    // No other test types should be set
    expect(svcData.tests.api).toBeUndefined();
    expect(svcData.tests.e2e).toBeUndefined();
    expect(svcData.tests.contract).toBeUndefined();
    expect(svcData.tests.integration).toBeUndefined();
  });
});

describe("scanner — countTests edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not count commented-out tests starting with //", async () => {
    vi.mocked(fg).mockResolvedValue([
      "/project/src/utils/helper.test.ts",
    ]);

    mockReadFile.mockResolvedValueOnce(
      `describe("helper", () => {
  // it("this is commented out", () => {});
  it("this is real", () => {});
});` as any,
    );

    const modules = [makeModule("src/utils")];
    const result = await scanTests("/project", modules);

    expect(result.totalTestCount).toBe(1);
  });

  it("does not count commented-out tests starting with *", async () => {
    vi.mocked(fg).mockResolvedValue([
      "/project/src/utils/helper.test.ts",
    ]);

    mockReadFile.mockResolvedValueOnce(
      `describe("helper", () => {
  /*
  * it("this is in a block comment", () => {});
  */
  it("this is real", () => {});
});` as any,
    );

    const modules = [makeModule("src/utils")];
    const result = await scanTests("/project", modules);

    expect(result.totalTestCount).toBe(1);
  });

  it("counts test.each, test.only, test.skip, and test.todo variants", async () => {
    vi.mocked(fg).mockResolvedValue([
      "/project/src/utils/variants.test.ts",
    ]);

    mockReadFile.mockResolvedValueOnce(
      `describe("variants", () => {
  test.each([1, 2, 3])("handles %i", (n) => {});
  test.only("focused test", () => {});
  test.skip("skipped test", () => {});
  test.todo("todo test");
  it.each([1])("it.each %i", (n) => {});
  it.only("it.only focused", () => {});
  it.skip("it.skip test", () => {});
});` as any,
    );

    const modules = [makeModule("src/utils")];
    const result = await scanTests("/project", modules);

    // All 7 variants should be counted
    expect(result.totalTestCount).toBe(7);
  });

  it("does not count words like imit( or retest( that contain it/test", async () => {
    vi.mocked(fg).mockResolvedValue([
      "/project/src/utils/falsepos.test.ts",
    ]);

    mockReadFile.mockResolvedValueOnce(
      `describe("false positives", () => {
  it("real test", () => {
    const limit = 5;
    submitForm();
  });
});` as any,
    );

    const modules = [makeModule("src/utils")];
    const result = await scanTests("/project", modules);

    // Only the real `it(` should count
    expect(result.totalTestCount).toBe(1);
  });
});

describe("scanner — findNearestModule with nested modules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps test to most specific (deepest) module when modules are nested", async () => {
    vi.mocked(fg).mockResolvedValue([
      "/project/src/services/booking/__tests__/create.test.ts",
      "/project/src/services/__tests__/index.test.ts",
    ]);

    mockReadFile
      .mockResolvedValueOnce(
        `it("creates a booking", () => {});` as any,
      )
      .mockResolvedValueOnce(
        `it("service index", () => {});` as any,
      );

    const modules = [
      makeModule("src/services"),
      makeModule("src/services/booking"),
    ];
    const result = await scanTests("/project", modules);

    // The deeper module should get the booking test
    const bookingData = result.byModule.get("src/services/booking")!;
    expect(bookingData.tests.unit).toBeDefined();
    expect(bookingData.tests.unit!.current).toBe(1);

    // The parent module should get the index test
    const servicesData = result.byModule.get("src/services")!;
    expect(servicesData.tests.unit).toBeDefined();
    expect(servicesData.tests.unit!.current).toBe(1);
  });

  it("classifies as integration when content contains drizzle", async () => {
    vi.mocked(fg).mockResolvedValue([
      "/project/src/db/__tests__/queries.test.ts",
    ]);

    mockReadFile.mockResolvedValueOnce(
      `import { drizzle } from "drizzle-orm/node-postgres";
describe("DB queries", () => {
  it("inserts a record", async () => {
    const db = drizzle(pool);
  });
});` as any,
    );

    const modules = [makeModule("src/db")];
    const result = await scanTests("/project", modules);

    const dbData = result.byModule.get("src/db")!;
    expect(dbData.tests.integration).toBeDefined();
    expect(dbData.tests.integration!.current).toBe(1);
  });
});
