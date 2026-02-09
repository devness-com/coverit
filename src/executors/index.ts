/**
 * Executor Factory — Maps execution environments to concrete runner instances.
 */

import type { ExecutionEnvironment } from "../types/index.js";
import { BaseExecutor } from "./base-executor.js";
import { LocalRunner } from "./local-runner.js";
import { CloudRunner } from "./cloud-runner.js";
import { BrowserRunner } from "./browser-runner.js";
import { SimulatorRunner } from "./simulator-runner.js";

const executorMap: Record<ExecutionEnvironment, () => BaseExecutor> = {
  local: () => new LocalRunner(),
  "cloud-sandbox": () => new CloudRunner(),
  browser: () => new BrowserRunner(),
  "mobile-simulator": () => new SimulatorRunner(),
  "desktop-app": () => new SimulatorRunner(),
};

export function createExecutor(environment: ExecutionEnvironment): BaseExecutor {
  const factory = executorMap[environment];
  if (!factory) {
    throw new Error(
      `Unknown execution environment: ${environment}. ` +
        `Supported: ${Object.keys(executorMap).join(", ")}`
    );
  }
  return factory();
}

export { BaseExecutor } from "./base-executor.js";
export { LocalRunner } from "./local-runner.js";
export { CloudRunner } from "./cloud-runner.js";
export { BrowserRunner } from "./browser-runner.js";
export { SimulatorRunner } from "./simulator-runner.js";
