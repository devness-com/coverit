/**
 * Simulator Runner — Execute tests on mobile simulators and desktop app shells.
 *
 * Supports three targets:
 *  - iOS Simulator via `xcrun simctl` + Detox
 *  - Android Emulator via `emulator` CLI + Detox
 *  - Tauri desktop via `cargo tauri dev` + WebDriver
 *
 * Each path checks for tool availability before attempting execution
 * and returns meaningful errors when the required toolchain is missing.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { BaseExecutor } from "./base-executor.js";
import type {
  GeneratedTest,
  ExecutionConfig,
  ExecutionResult,
} from "../types/index.js";

export class SimulatorRunner extends BaseExecutor {
  async execute(
    test: GeneratedTest,
    config: ExecutionConfig
  ): Promise<ExecutionResult> {
    const result = this.createBaseResult(test.planId);
    const start = Date.now();

    try {
      // Route to the correct simulator based on test type
      switch (test.testType) {
        case "e2e-mobile":
          return await this.withTimeout(
            this.executeMobile(test, config, result),
            config.timeout
          );
        case "e2e-desktop":
          return await this.withTimeout(
            this.executeDesktop(test, config, result),
            config.timeout
          );
        default:
          result.status = "error";
          result.output = `SimulatorRunner does not support test type: ${test.testType}. Expected e2e-mobile or e2e-desktop.`;
          result.duration = Date.now() - start;
          result.failures.push({
            testName: "(simulator-runner)",
            message: result.output,
          });
          return result;
      }
    } catch (err) {
      result.duration = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes("timed out")) {
        result.status = "timeout";
      } else {
        result.status = "error";
      }

      result.output = message;
      result.failures.push({ testName: "(simulator-runner)", message });
      return result;
    }
  }

  // ── Mobile (iOS / Android) ────────────────────────────────────

  private async executeMobile(
    test: GeneratedTest,
    config: ExecutionConfig,
    result: ExecutionResult
  ): Promise<ExecutionResult> {
    const start = Date.now();
    const platform = this.detectMobilePlatform();

    if (platform === "ios") {
      return this.executeIOS(test, config, result, start);
    } else if (platform === "android") {
      return this.executeAndroid(test, config, result, start);
    }

    result.duration = Date.now() - start;
    result.status = "error";
    result.output =
      "No mobile simulator available. " +
      "iOS: requires Xcode with `xcrun simctl`. " +
      "Android: requires Android SDK with `emulator` CLI.";
    result.failures.push({
      testName: "(mobile-simulator)",
      message: result.output,
    });
    return result;
  }

  private async executeIOS(
    test: GeneratedTest,
    _config: ExecutionConfig,
    result: ExecutionResult,
    start: number
  ): Promise<ExecutionResult> {
    // Check for booted simulator
    const devices = await this.exec("xcrun", [
      "simctl",
      "list",
      "devices",
      "--json",
    ]);

    const deviceJson = this.parseJsonOutput(devices.stdout);
    const bootedDevice = this.findBootedIOSDevice(deviceJson);

    if (!bootedDevice) {
      // Try to boot the first available iPhone simulator
      const availableDevice = this.findAvailableIOSDevice(deviceJson);
      if (availableDevice) {
        await this.exec("xcrun", ["simctl", "boot", availableDevice]);
      } else {
        result.duration = Date.now() - start;
        result.status = "error";
        result.output = "No iOS simulator device available. Create one in Xcode.";
        result.failures.push({
          testName: "(ios-simulator)",
          message: result.output,
        });
        return result;
      }
    }

    // Run Detox tests
    const cwd = this.findProjectRoot(test.filePath);
    const detoxResult = await this.exec(
      "bunx",
      ["detox", "test", "--configuration", "ios.sim.debug", test.filePath],
      cwd
    );

    result.duration = Date.now() - start;
    result.output = this.combineOutput(detoxResult.stdout, detoxResult.stderr);

    // Detox doesn't have a standard JSON reporter — parse exit code
    if (detoxResult.exitCode === 0) {
      result.status = "passed";
      result.totalTests = test.testCount;
      result.passed = test.testCount;
    } else {
      result.status = "failed";
      result.totalTests = test.testCount;
      result.failures.push({
        testName: "(detox-ios)",
        message: detoxResult.stderr.slice(0, 2000) || "Detox test failed",
      });
    }

    return result;
  }

  private async executeAndroid(
    test: GeneratedTest,
    _config: ExecutionConfig,
    result: ExecutionResult,
    start: number
  ): Promise<ExecutionResult> {
    // List available AVDs
    const avdResult = await this.exec("emulator", ["-list-avds"]);
    const avds = avdResult.stdout.trim().split("\n").filter(Boolean);

    if (avds.length === 0) {
      result.duration = Date.now() - start;
      result.status = "error";
      result.output =
        "No Android AVD available. Create one with Android Studio's AVD Manager.";
      result.failures.push({
        testName: "(android-emulator)",
        message: result.output,
      });
      return result;
    }

    // Check if emulator is already running via adb
    const adbResult = await this.exec("adb", ["devices"]);
    const hasRunningEmulator = adbResult.stdout.includes("emulator-");

    if (!hasRunningEmulator) {
      // Start the first available AVD in the background (don't wait for it)
      // Detox will handle waiting for the emulator to boot
      this.execBackground("emulator", ["-avd", avds[0]!, "-no-window"]);
      // Give the emulator a moment to begin booting
      await new Promise((r) => setTimeout(r, 5000));
    }

    // Run Detox tests
    const cwd = this.findProjectRoot(test.filePath);
    const detoxResult = await this.exec(
      "bunx",
      [
        "detox",
        "test",
        "--configuration",
        "android.emu.debug",
        test.filePath,
      ],
      cwd
    );

    result.duration = Date.now() - start;
    result.output = this.combineOutput(detoxResult.stdout, detoxResult.stderr);

    if (detoxResult.exitCode === 0) {
      result.status = "passed";
      result.totalTests = test.testCount;
      result.passed = test.testCount;
    } else {
      result.status = "failed";
      result.totalTests = test.testCount;
      result.failures.push({
        testName: "(detox-android)",
        message: detoxResult.stderr.slice(0, 2000) || "Detox test failed",
      });
    }

    return result;
  }

  // ── Desktop (Tauri) ───────────────────────────────────────────

  private async executeDesktop(
    test: GeneratedTest,
    _config: ExecutionConfig,
    result: ExecutionResult
  ): Promise<ExecutionResult> {
    const start = Date.now();

    // Check for Tauri CLI
    const hasCargo = await this.isCommandAvailable("cargo");
    if (!hasCargo) {
      result.duration = Date.now() - start;
      result.status = "error";
      result.output =
        "Tauri testing requires Rust and cargo. Install from https://rustup.rs/";
      result.failures.push({
        testName: "(tauri-desktop)",
        message: result.output,
      });
      return result;
    }

    const cwd = this.findProjectRoot(test.filePath);

    // Check for tauri.conf.json to confirm this is a Tauri project
    const hasTauriConfig =
      existsSync(join(cwd, "src-tauri", "tauri.conf.json")) ||
      existsSync(join(cwd, "src-tauri", "Cargo.toml"));

    if (!hasTauriConfig) {
      result.duration = Date.now() - start;
      result.status = "error";
      result.output =
        "No Tauri configuration found (src-tauri/tauri.conf.json). Is this a Tauri project?";
      result.failures.push({
        testName: "(tauri-desktop)",
        message: result.output,
      });
      return result;
    }

    // Run WebDriver-based tests via Playwright against the Tauri window
    // The test file should use @playwright/test with electron/tauri helpers
    const testResult = await this.exec(
      "bunx",
      ["playwright", "test", test.filePath, "--reporter=json"],
      cwd
    );

    result.duration = Date.now() - start;
    result.output = this.combineOutput(testResult.stdout, testResult.stderr);

    // Parse Playwright JSON output
    const json = this.parseJsonOutput(testResult.stdout);
    if (json?.stats) {
      result.passed = json.stats.expected ?? 0;
      result.failed = json.stats.unexpected ?? 0;
      result.skipped = json.stats.skipped ?? 0;
      result.totalTests = result.passed + result.failed + result.skipped;
      result.status =
        testResult.exitCode === 0 && result.failed === 0 ? "passed" : "failed";
    } else {
      result.status = testResult.exitCode === 0 ? "passed" : "failed";
      result.totalTests = test.testCount;
      if (testResult.exitCode === 0) {
        result.passed = test.testCount;
      }
    }

    return result;
  }

  // ── Tool Detection ────────────────────────────────────────────

  private detectMobilePlatform(): "ios" | "android" | null {
    // Prefer iOS on macOS since xcrun is likely available
    try {
      if (process.platform === "darwin") {
        return "ios";
      }
      return "android";
    } catch {
      return null;
    }
  }

  private findBootedIOSDevice(deviceJson: any): string | null {
    if (!deviceJson?.devices) return null;

    for (const runtime of Object.values(deviceJson.devices) as any[]) {
      if (!Array.isArray(runtime)) continue;
      for (const device of runtime) {
        if (device.state === "Booted" && device.isAvailable) {
          return device.udid;
        }
      }
    }
    return null;
  }

  private findAvailableIOSDevice(deviceJson: any): string | null {
    if (!deviceJson?.devices) return null;

    for (const [runtime, devices] of Object.entries(deviceJson.devices) as [
      string,
      any[],
    ][]) {
      if (!runtime.includes("iOS") || !Array.isArray(devices)) continue;
      for (const device of devices) {
        if (
          device.isAvailable &&
          device.name?.includes("iPhone")
        ) {
          return device.udid;
        }
      }
    }
    return null;
  }

  private async isCommandAvailable(cmd: string): Promise<boolean> {
    try {
      const result = await this.exec("which", [cmd]);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  // ── Process Helpers ───────────────────────────────────────────

  private exec(
    cmd: string,
    args: string[],
    cwd?: string
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;

      try {
        child = spawn(cmd, args, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
        });
      } catch (err) {
        reject(
          new Error(
            `Failed to spawn ${cmd}: ${err instanceof Error ? err.message : String(err)}`
          )
        );
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      child.on("error", (err) =>
        reject(new Error(`${cmd} error: ${err.message}`))
      );

      child.on("close", (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
          stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        });
      });
    });
  }

  /** Fire-and-forget process for background tasks like starting an emulator. */
  private execBackground(cmd: string, args: string[]): void {
    try {
      const child = spawn(cmd, args, {
        stdio: "ignore",
        detached: true,
      });
      child.unref();
    } catch {
      // Best-effort — the actual test run will fail if the emulator doesn't start
    }
  }

  private findProjectRoot(filePath: string): string {
    let dir = dirname(resolve(filePath));
    while (dir !== "/" && dir !== ".") {
      if (existsSync(join(dir, "package.json"))) return dir;
      dir = dirname(dir);
    }
    return dirname(resolve(filePath));
  }

  private combineOutput(stdout: string, stderr: string): string {
    const parts: string[] = [];
    if (stdout) parts.push(stdout);
    if (stderr) parts.push(`[stderr]\n${stderr}`);
    return parts.join("\n").slice(0, 50_000);
  }
}
