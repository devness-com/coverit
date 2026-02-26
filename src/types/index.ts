/**
 * Coverit — Core Types
 *
 * Minimal type definitions used across the codebase.
 */

export type Language =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "unknown";

export type Framework =
  | "hono"
  | "express"
  | "nestjs"
  | "next"
  | "react"
  | "react-native"
  | "expo"
  | "tauri"
  | "electron"
  | "fastify"
  | "none"
  | "unknown";

export type TestFramework =
  | "vitest"
  | "jest"
  | "mocha"
  | "playwright"
  | "cypress"
  | "detox"
  | "pytest"
  | "go-test"
  | "unknown";

export type PackageManager = "bun" | "pnpm" | "npm" | "yarn";

export interface ProjectInfo {
  name: string;
  root: string;
  language: Language;
  framework: Framework;
  testFramework: TestFramework;
  packageManager: PackageManager;
  hasExistingTests: boolean;
  existingTestPatterns: string[];
}
