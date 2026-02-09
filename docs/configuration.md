# Configuration

coverit can be configured via a `coverit.config.ts` file in your project root, CLI flags, or environment variables.

## Config File

Create `coverit.config.ts` at your project root:

```ts
import { defineConfig } from "coverit";

export default defineConfig({
  projectRoot: ".",
  testTypes: ["unit", "api", "e2e-browser"],
  environment: "local",
  coverageThreshold: 80,
});
```

### All Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `projectRoot` | `string` | `"."` | Root directory of the project to analyze. |
| `targetPaths` | `string[]` | `undefined` | Restrict analysis to specific files or directories. |
| `testTypes` | `TestType[]` | all types | Which test types to generate: `unit`, `integration`, `api`, `e2e-browser`, `e2e-mobile`, `e2e-desktop`, `snapshot`, `performance`. |
| `environment` | `ExecutionEnvironment` | `"local"` | Where to run tests: `local`, `cloud-sandbox`, `browser`, `mobile-simulator`, `desktop-app`. |
| `framework` | `TestFramework` | auto-detected | Override the test framework: `vitest`, `jest`, `playwright`, `detox`, `pytest`. |
| `skipExecution` | `boolean` | `false` | Generate tests but do not execute them. |
| `generateOnly` | `boolean` | `false` | Same as `skipExecution`. |
| `coverageThreshold` | `number` | `undefined` | Minimum coverage percentage. The run fails if coverage is below this value. |
| `cloudConfig` | `CloudConfig` | `undefined` | Cloud execution settings (see below). |

### CloudConfig

```ts
{
  cloudConfig: {
    provider: "e2b",      // "e2b" | "docker" | "hetzner"
    image: "node:22",     // container/VM image
    resources: {
      cpu: 2,             // vCPUs
      memory: "4GB",      // RAM
    },
  }
}
```

### TestType Values

| Value | Description |
|-------|-------------|
| `unit` | Isolated function and class tests |
| `integration` | Tests spanning multiple modules |
| `api` | HTTP endpoint tests |
| `e2e-browser` | Browser-based end-to-end tests (Playwright) |
| `e2e-mobile` | Mobile app tests (Detox) |
| `e2e-desktop` | Desktop app tests (Tauri/Electron) |
| `snapshot` | Component snapshot tests |
| `performance` | Performance and load tests |

### ExecutionEnvironment Values

| Value | Description |
|-------|-------------|
| `local` | Run on the local machine |
| `cloud-sandbox` | Run in a cloud sandbox (E2B, Docker, Hetzner) |
| `browser` | Run in a managed browser instance |
| `mobile-simulator` | Run in an iOS Simulator or Android Emulator |
| `desktop-app` | Run inside a desktop application window |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `COVERIT_DEBUG` | Set to `1` to enable debug logging. |
| `COVERIT_CLOUD_KEY` | API key for cloud sandbox providers (E2B, Hetzner). |
| `COVERIT_CLOUD_PROVIDER` | Default cloud provider: `e2b`, `docker`, or `hetzner`. |
| `COVERIT_TIMEOUT` | Default execution timeout in milliseconds. |
| `COVERIT_RETRIES` | Number of retry attempts for failed test executions. |
| `COVERIT_COVERAGE` | Set to `1` to always collect coverage. |

## Examples

### API-Only Project (Hono)

```ts
import { defineConfig } from "coverit";

export default defineConfig({
  projectRoot: ".",
  testTypes: ["unit", "api"],
  environment: "local",
  framework: "vitest",
  coverageThreshold: 90,
});
```

### React SPA

```ts
import { defineConfig } from "coverit";

export default defineConfig({
  projectRoot: ".",
  testTypes: ["unit", "snapshot", "e2e-browser"],
  environment: "local",
  framework: "vitest",
  coverageThreshold: 80,
});
```

### Full-Stack Monorepo

```ts
import { defineConfig } from "coverit";

export default defineConfig({
  projectRoot: ".",
  testTypes: ["unit", "api", "e2e-browser"],
  environment: "local",
  coverageThreshold: 75,
});
```

For monorepos with multiple packages, you can scope to specific paths:

```ts
import { defineConfig } from "coverit";

export default defineConfig({
  projectRoot: ".",
  targetPaths: ["packages/api", "packages/web"],
  testTypes: ["unit", "api", "e2e-browser"],
  environment: "local",
});
```

### Mobile App (Expo)

```ts
import { defineConfig } from "coverit";

export default defineConfig({
  projectRoot: ".",
  testTypes: ["unit", "e2e-mobile"],
  environment: "mobile-simulator",
  framework: "detox",
  coverageThreshold: 70,
});
```

### Cloud Execution

```ts
import { defineConfig } from "coverit";

export default defineConfig({
  projectRoot: ".",
  testTypes: ["unit", "api", "e2e-browser"],
  environment: "cloud-sandbox",
  cloudConfig: {
    provider: "e2b",
    resources: {
      cpu: 4,
      memory: "8GB",
    },
  },
});
```

## CLI Flag Overrides

CLI flags take precedence over config file values:

```bash
# Override test type
coverit run --type unit

# Override environment
coverit run --env cloud-sandbox

# Enable coverage even if not in config
coverit run --coverage

# Dry run (no file writes, no execution)
coverit scan --dry-run

# Debug output
coverit run --verbose
```
