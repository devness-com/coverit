import { defineConfig } from "coverit";

export default defineConfig({
  // ── Project ─────────────────────────────────────────────────
  // Root directory to analyze. Defaults to ".".
  projectRoot: ".",

  // Restrict analysis to specific files or directories.
  // Omit to analyze all changed files in the repo.
  // targetPaths: ["packages/api", "packages/web"],

  // ── Test Types ──────────────────────────────────────────────
  // Which test types to generate. Omit to generate all applicable types.
  // Options: "unit" | "integration" | "api" | "e2e-browser"
  //          | "e2e-mobile" | "e2e-desktop" | "snapshot" | "performance"
  testTypes: ["unit", "api", "e2e-browser"],

  // ── Execution ───────────────────────────────────────────────
  // Where to run tests.
  // Options: "local" | "cloud-sandbox" | "browser" | "mobile-simulator" | "desktop-app"
  environment: "local",

  // Override auto-detected test framework.
  // Options: "vitest" | "jest" | "playwright" | "detox" | "pytest"
  // framework: "vitest",

  // Generate tests but do not execute them.
  // skipExecution: false,

  // Same as skipExecution.
  // generateOnly: false,

  // ── Coverage ────────────────────────────────────────────────
  // Minimum coverage percentage. Fail the run if below this value.
  // coverageThreshold: 80,

  // ── Cloud Execution ─────────────────────────────────────────
  // Required when environment is "cloud-sandbox".
  // cloudConfig: {
  //   provider: "e2b",       // "e2b" | "docker" | "hetzner"
  //   image: "node:22",      // Container or VM image
  //   resources: {
  //     cpu: 2,              // vCPUs
  //     memory: "4GB",       // RAM
  //   },
  // },
});

// ── Example: API-only project (Hono/Express) ──────────────────
//
// export default defineConfig({
//   projectRoot: ".",
//   testTypes: ["unit", "api"],
//   environment: "local",
//   framework: "vitest",
//   coverageThreshold: 90,
// });

// ── Example: React SPA ────────────────────────────────────────
//
// export default defineConfig({
//   projectRoot: ".",
//   testTypes: ["unit", "snapshot", "e2e-browser"],
//   environment: "local",
//   framework: "vitest",
//   coverageThreshold: 80,
// });

// ── Example: Mobile app (Expo + Detox) ────────────────────────
//
// export default defineConfig({
//   projectRoot: ".",
//   testTypes: ["unit", "e2e-mobile"],
//   environment: "mobile-simulator",
//   framework: "detox",
//   coverageThreshold: 70,
// });

// ── Example: Full-stack monorepo ──────────────────────────────
//
// export default defineConfig({
//   projectRoot: ".",
//   targetPaths: ["packages/api", "packages/web", "packages/mobile"],
//   testTypes: ["unit", "api", "e2e-browser", "e2e-mobile"],
//   environment: "local",
//   coverageThreshold: 75,
// });
