/**
 * Unit tests for src/index.ts (public API barrel file)
 * Verifies that all expected functions, constants, and types
 * are correctly re-exported from the public API surface.
 */
import { describe, it, expect } from "vitest";

import * as publicAPI from "../index.js";

// ─── Core Pipeline Exports ──────────────────────────────────

describe("core pipeline exports", () => {
  it("exports scanCodebase function", () => {
    expect(publicAPI.scanCodebase).toBeDefined();
    expect(typeof publicAPI.scanCodebase).toBe("function");
  });

  it("exports cover function", () => {
    expect(publicAPI.cover).toBeDefined();
    expect(typeof publicAPI.cover).toBe("function");
  });

  it("exports fixTests function", () => {
    expect(publicAPI.fixTests).toBeDefined();
    expect(typeof publicAPI.fixTests).toBe("function");
  });
});

// ─── Manifest I/O Exports ───────────────────────────────────

describe("manifest I/O exports", () => {
  it("exports readManifest function", () => {
    expect(publicAPI.readManifest).toBeDefined();
    expect(typeof publicAPI.readManifest).toBe("function");
  });

  it("exports writeManifest function", () => {
    expect(publicAPI.writeManifest).toBeDefined();
    expect(typeof publicAPI.writeManifest).toBe("function");
  });
});

// ─── Scoring Exports ────────────────────────────────────────

describe("scoring exports", () => {
  it("exports rescoreManifest function", () => {
    expect(publicAPI.rescoreManifest).toBeDefined();
    expect(typeof publicAPI.rescoreManifest).toBe("function");
  });

  it("exports scanTests function", () => {
    expect(publicAPI.scanTests).toBeDefined();
    expect(typeof publicAPI.scanTests).toBe("function");
  });
});

// ─── AI Provider Exports ────────────────────────────────────

describe("AI provider exports", () => {
  it("exports createAIProvider factory function", () => {
    expect(publicAPI.createAIProvider).toBeDefined();
    expect(typeof publicAPI.createAIProvider).toBe("function");
  });
});

// ─── Utility Exports ────────────────────────────────────────

describe("utility exports", () => {
  it("exports detectFramework function", () => {
    expect(publicAPI.detectFramework).toBeDefined();
    expect(typeof publicAPI.detectFramework).toBe("function");
  });

  it("exports detectTestFramework function", () => {
    expect(publicAPI.detectTestFramework).toBeDefined();
    expect(typeof publicAPI.detectTestFramework).toBe("function");
  });

  it("exports detectPackageManager function", () => {
    expect(publicAPI.detectPackageManager).toBeDefined();
    expect(typeof publicAPI.detectPackageManager).toBe("function");
  });

  it("exports detectProjectInfo function", () => {
    expect(publicAPI.detectProjectInfo).toBeDefined();
    expect(typeof publicAPI.detectProjectInfo).toBe("function");
  });

  it("exports logger instance", () => {
    expect(publicAPI.logger).toBeDefined();
    expect(typeof publicAPI.logger).toBe("object");
  });
});

// ─── Export Completeness ────────────────────────────────────

describe("export completeness", () => {
  it("exports exactly the expected set of runtime values", () => {
    const expectedExports = [
      "scanCodebase",
      "cover",
      "fixTests",
      "readManifest",
      "writeManifest",
      "rescoreManifest",
      "scanTests",
      "createAIProvider",
      "detectFramework",
      "detectTestFramework",
      "detectPackageManager",
      "detectProjectInfo",
      "logger",
    ];

    for (const name of expectedExports) {
      expect(publicAPI).toHaveProperty(name);
    }
  });

  it("does not export internal implementation details", () => {
    // These are internal modules that should NOT be in the public API
    const internalNames = [
      "calculateScore",
      "calculateDimensionScore",
      "calculateFunctionalityScore",
      "calculateSecurityScore",
      "appendHistory",
      "discoverTestFiles",
      "countTests",
      "classifyTestType",
    ];

    for (const name of internalNames) {
      expect(publicAPI).not.toHaveProperty(name);
    }
  });
});
