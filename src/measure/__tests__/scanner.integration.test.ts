/**
 * Integration tests for scanner.ts
 * Tests scanTests against a real filesystem with temp directories.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanTests } from "../scanner.js";
import type { ModuleEntry } from "../../schema/coverit-manifest.js";

// --- Helpers ---

function makeModule(path: string, complexity: "low" | "medium" | "high" = "medium"): ModuleEntry {
  return {
    path,
    files: 5,
    lines: 500,
    complexity,
    functionality: {
      tests: {
        unit: { expected: 6, current: 0, files: [] },
        integration: { expected: 10, current: 0, files: [] },
      },
    },
    security: { issues: 0, resolved: 0, findings: [] },
    stability: { score: 80, gaps: [] },
    conformance: { score: 90, violations: [] },
  };
}

async function createFile(dir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = join(dir, relativePath);
  const parentDir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  await mkdir(parentDir, { recursive: true });
  await writeFile(fullPath, content, "utf-8");
}

// --- Test Suite ---

describe("scanner integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "coverit-scanner-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("discovers .test.ts files and counts it()/test() calls", async () => {
    await createFile(tempDir, "src/services/booking.test.ts", `
describe("BookingService", () => {
  it("should create a booking", () => {
    expect(true).toBe(true);
  });
  it("should cancel a booking", () => {
    expect(true).toBe(true);
  });
  test("should update a booking", () => {
    expect(true).toBe(true);
  });
});
`);

    const modules = [makeModule("src/services")];
    const result = await scanTests(tempDir, modules);

    expect(result.totalTestFiles).toBe(1);
    expect(result.totalTestCount).toBe(3);

    const svcData = result.byModule.get("src/services")!;
    expect(svcData.tests.unit).toBeDefined();
    expect(svcData.tests.unit!.current).toBe(3);
    expect(svcData.tests.unit!.files).toHaveLength(1);
    expect(svcData.tests.unit!.files[0]).toContain("booking.test.ts");
  });

  it("discovers .spec.ts files and files in __tests__ directories", async () => {
    await createFile(tempDir, "src/utils/helpers.spec.ts", `
it("formats a date", () => {});
it("parses a string", () => {});
`);

    await createFile(tempDir, "src/utils/__tests__/format.ts", `
test("formats currency", () => {});
`);

    const modules = [makeModule("src/utils")];
    const result = await scanTests(tempDir, modules);

    expect(result.totalTestFiles).toBe(2);
    expect(result.totalTestCount).toBe(3);
  });

  it("classifies e2e tests from filename patterns (.e2e-spec.ts)", async () => {
    await createFile(tempDir, "src/services/booking.e2e-spec.ts", `
describe("Booking E2E", () => {
  it("completes the full booking flow", () => {});
});
`);

    const modules = [makeModule("src/services")];
    const result = await scanTests(tempDir, modules);

    const svcData = result.byModule.get("src/services")!;
    expect(svcData.tests.e2e).toBeDefined();
    expect(svcData.tests.e2e!.current).toBe(1);
  });

  it("classifies integration tests from filename containing .integration", async () => {
    await createFile(tempDir, "src/services/booking.integration.test.ts", `
describe("BookingService integration", () => {
  it("creates via DI container", () => {});
  it("queries the database", () => {});
});
`);

    const modules = [makeModule("src/services")];
    const result = await scanTests(tempDir, modules);

    const svcData = result.byModule.get("src/services")!;
    expect(svcData.tests.integration).toBeDefined();
    expect(svcData.tests.integration!.current).toBe(2);
  });

  it("classifies API tests from content containing supertest", async () => {
    await createFile(tempDir, "src/services/booking.test.ts", `
import request from "supertest";
describe("Booking API", () => {
  it("POST /bookings returns 201", async () => {
    await request(app).post("/bookings").expect(201);
  });
});
`);

    const modules = [makeModule("src/services")];
    const result = await scanTests(tempDir, modules);

    const svcData = result.byModule.get("src/services")!;
    expect(svcData.tests.api).toBeDefined();
    expect(svcData.tests.api!.current).toBe(1);
  });

  it("maps test files to the nearest module by longest path prefix", async () => {
    await createFile(tempDir, "src/services/auth/login.test.ts", `
it("authenticates user", () => {});
`);

    await createFile(tempDir, "src/services/booking.test.ts", `
test("creates booking", () => {});
`);

    const modules = [
      makeModule("src/services"),
      makeModule("src/services/auth"),
    ];
    const result = await scanTests(tempDir, modules);

    // login.test.ts should map to the more specific "src/services/auth" module
    const authData = result.byModule.get("src/services/auth")!;
    expect(authData.tests.unit).toBeDefined();
    expect(authData.tests.unit!.files[0]).toContain("login.test.ts");

    // booking.test.ts should map to "src/services"
    const svcData = result.byModule.get("src/services")!;
    expect(svcData.tests.unit).toBeDefined();
    expect(svcData.tests.unit!.files[0]).toContain("booking.test.ts");
  });

  it("ignores commented-out tests (// and * prefixed lines)", async () => {
    await createFile(tempDir, "src/services/booking.test.ts", `
describe("BookingService", () => {
  it("active test", () => {});
  // it("commented out with double slash", () => {});
  * it("jsdoc-style commented test", () => {});
  it("another active test", () => {});
});
`);

    const modules = [makeModule("src/services")];
    const result = await scanTests(tempDir, modules);

    // Only 2 active tests: the // and * prefixed lines are skipped
    expect(result.totalTestCount).toBe(2);
  });

  it("handles empty project with no test files", async () => {
    // Create only a source file, no test files
    await createFile(tempDir, "src/services/booking.ts", `
export class BookingService {
  create() { return {}; }
}
`);

    const modules = [makeModule("src/services")];
    const result = await scanTests(tempDir, modules);

    expect(result.totalTestFiles).toBe(0);
    expect(result.totalTestCount).toBe(0);
    expect(result.byModule.get("src/services")!.tests).toEqual({});
  });

  it("skips test files in node_modules and dist directories", async () => {
    await createFile(tempDir, "node_modules/lib/test.test.ts", `
it("should be ignored", () => {});
`);

    await createFile(tempDir, "dist/services/booking.test.ts", `
it("should also be ignored", () => {});
`);

    await createFile(tempDir, "src/services/real.test.ts", `
it("should be counted", () => {});
`);

    const modules = [makeModule("src/services")];
    const result = await scanTests(tempDir, modules);

    expect(result.totalTestFiles).toBe(1);
    expect(result.totalTestCount).toBe(1);
  });

  it("classifies contract tests from .contract in filename", async () => {
    await createFile(tempDir, "src/services/booking.contract.test.ts", `
describe("Booking API contract", () => {
  test("validates response schema", () => {});
});
`);

    const modules = [makeModule("src/services")];
    const result = await scanTests(tempDir, modules);

    const svcData = result.byModule.get("src/services")!;
    // .contract pattern is not in classifyTestType's file patterns.
    // Contract classification checks for ".contract" — not present.
    // Actually checking: lower.includes(".contract") → yes it does!
    // Wait, looking at the source: if (lower.includes(".contract") || lower.includes("/contracts/"))
    // "booking.contract.test.ts" includes ".contract" → true!
    expect(svcData.tests.contract).toBeDefined();
    expect(svcData.tests.contract!.current).toBe(1);
  });
});
