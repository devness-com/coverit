/**
 * Cloud Runner — Execute tests in isolated cloud sandboxes.
 *
 * Supports two providers:
 *  - E2B: AI-optimized sandboxes with fast cold start
 *  - Docker: Container-based execution for self-hosted setups
 *
 * Both paths produce a standard ExecutionResult. Providers are selected
 * via ExecutionConfig.cloudConfig.provider.
 *
 * TODO: Implement when cloud provider is configured — the interfaces
 * and flow are defined but actual SDK calls are stubbed.
 */

import { BaseExecutor } from "./base-executor.js";
import type {
  GeneratedTest,
  ExecutionConfig,
  ExecutionResult,
  CloudConfig,
} from "../types/index.js";

interface SandboxHandle {
  id: string;
  status: "ready" | "running" | "stopped" | "error";
}

export class CloudRunner extends BaseExecutor {
  async execute(
    test: GeneratedTest,
    config: ExecutionConfig
  ): Promise<ExecutionResult> {
    const result = this.createBaseResult(test.planId);
    const start = Date.now();

    try {
      const provider = config.cloudConfig?.provider ?? "docker";

      switch (provider) {
        case "e2b":
          return await this.withTimeout(
            this.executeInE2B(test, config, result),
            config.timeout
          );
        case "docker":
          return await this.withTimeout(
            this.executeInDocker(test, config, result),
            config.timeout
          );
        default:
          result.status = "error";
          result.output = `Unsupported cloud provider: ${provider}. Supported: e2b, docker.`;
          result.failures.push({
            testName: "(cloud-runner)",
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
      result.failures.push({ testName: "(cloud-runner)", message });
      return result;
    }
  }

  // ── E2B Sandbox ───────────────────────────────────────────────

  /**
   * E2B execution flow:
   * 1. Create sandbox with project dependencies
   * 2. Upload the generated test file
   * 3. Run the test command inside the sandbox
   * 4. Download results and coverage artifacts
   * 5. Clean up the sandbox
   */
  private async executeInE2B(
    test: GeneratedTest,
    config: ExecutionConfig,
    result: ExecutionResult
  ): Promise<ExecutionResult> {
    const start = Date.now();
    let sandbox: SandboxHandle | null = null;

    try {
      // Step 1: Create sandbox
      sandbox = await this.createE2BSandbox(config.cloudConfig!);

      // Step 2: Upload test file
      await this.uploadToSandbox(sandbox, test.filePath, test.content);

      // Step 3: Run test command
      const output = await this.runInSandbox(sandbox, test);

      // Step 4: Parse results
      const json = this.parseJsonOutput(output);
      if (json) {
        result.totalTests = json.numTotalTests ?? 0;
        result.passed = json.numPassedTests ?? 0;
        result.failed = json.numFailedTests ?? 0;
        result.status = result.failed > 0 ? "failed" : "passed";
      } else {
        result.status = "passed";
        result.output = output;
      }

      result.duration = Date.now() - start;
      result.output = output;
    } catch (err) {
      result.duration = Date.now() - start;
      result.status = "error";
      result.output = err instanceof Error ? err.message : String(err);
      result.failures.push({
        testName: "(e2b-sandbox)",
        message: result.output,
      });
    } finally {
      // Step 5: Cleanup
      if (sandbox) await this.destroySandbox(sandbox);
    }

    return result;
  }

  // TODO: Implement when E2B SDK is added as a dependency
  private async createE2BSandbox(_config: CloudConfig): Promise<SandboxHandle> {
    throw new Error(
      "E2B sandbox not configured. Install @e2b/code-interpreter and set E2B_API_KEY."
    );
  }

  // TODO: Implement when E2B SDK is added as a dependency
  private async uploadToSandbox(
    _sandbox: SandboxHandle,
    _path: string,
    _content: string
  ): Promise<void> {
    throw new Error("E2B sandbox upload not implemented.");
  }

  // TODO: Implement when E2B SDK is added as a dependency
  private async runInSandbox(
    _sandbox: SandboxHandle,
    _test: GeneratedTest
  ): Promise<string> {
    throw new Error("E2B sandbox execution not implemented.");
  }

  // TODO: Implement when E2B SDK is added as a dependency
  private async destroySandbox(_sandbox: SandboxHandle): Promise<void> {
    // No-op until SDK is integrated
  }

  // ── Docker Execution ──────────────────────────────────────────

  /**
   * Docker execution flow:
   * 1. Build or pull an image with project dependencies
   * 2. Mount the generated test file into the container
   * 3. Run the test command as the container entrypoint
   * 4. Parse stdout/stderr for results
   * 5. Remove the container
   */
  private async executeInDocker(
    _test: GeneratedTest,
    config: ExecutionConfig,
    result: ExecutionResult
  ): Promise<ExecutionResult> {
    const start = Date.now();

    try {
      const image = config.cloudConfig?.image ?? "node:20-slim";

      // TODO: Implement when Docker provider is configured
      // const containerId = await this.createContainer(image, test, config);
      // const output = await this.waitForContainer(containerId);
      // await this.removeContainer(containerId);

      result.duration = Date.now() - start;
      result.status = "error";
      result.output = `Docker execution not yet implemented. Would use image: ${image}`;
      result.failures.push({
        testName: "(docker-runner)",
        message:
          "Docker execution is not yet implemented. Configure a cloud provider or use local execution.",
      });
    } catch (err) {
      result.duration = Date.now() - start;
      result.status = "error";
      result.output = err instanceof Error ? err.message : String(err);
      result.failures.push({
        testName: "(docker-runner)",
        message: result.output,
      });
    }

    return result;
  }
}
