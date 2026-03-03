# UseAI Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integrate coverit with UseAI's daemon HTTP API so every scan/cover/run creates a dedicated UseAI session with coverit-specific milestones.

**Architecture:** A single `src/integrations/useai.ts` module provides `useaiStart`, `useaiEnd`, and `useaiHeartbeat` functions that call UseAI's local daemon at `localhost:19200` via JSON-RPC 2.0. Both CLI and MCP code paths call these at the orchestration level. All calls are fail-silent — if UseAI isn't installed, coverit works exactly as before.

**Tech Stack:** Node.js built-in `http` module (no new dependencies), JSON-RPC 2.0, `crypto.randomUUID()` for MCP session IDs.

---

### Task 1: Create UseAI client module

**Files:**
- Create: `src/integrations/useai.ts`

**Step 1: Create the module**

```typescript
/**
 * UseAI Integration — Optional session tracking via UseAI daemon.
 *
 * Calls UseAI's local HTTP daemon (localhost:19200) to create dedicated
 * coverit sessions. Fail-silent — if UseAI isn't running, all functions
 * return gracefully without blocking coverit's core flow.
 */

import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { logger } from "../utils/logger.js";

const DAEMON_HOST = "127.0.0.1";
const DAEMON_PORT = 19200;
const HEALTH_TIMEOUT_MS = 500;
const CALL_TIMEOUT_MS = 2_000;

// Single MCP session ID per coverit invocation
const mcpSessionId = randomUUID();
let jsonRpcId = 0;
let daemonAvailable: boolean | null = null;

/** Check if UseAI daemon is running (cached after first check). */
async function isDaemonRunning(): Promise<boolean> {
  if (daemonAvailable !== null) return daemonAvailable;

  try {
    await httpGet("/health", HEALTH_TIMEOUT_MS);
    daemonAvailable = true;
    logger.debug("UseAI daemon detected at localhost:19200");
  } catch {
    daemonAvailable = false;
    logger.debug("UseAI daemon not available — session tracking disabled");
  }
  return daemonAvailable;
}

/** Call a UseAI MCP tool via the daemon's JSON-RPC endpoint. */
async function callTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (!(await isDaemonRunning())) return null;

  const payload = JSON.stringify({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: toolName, arguments: args },
    id: ++jsonRpcId,
  });

  try {
    const response = await httpPost("/mcp", payload, CALL_TIMEOUT_MS);
    return JSON.parse(response) as Record<string, unknown>;
  } catch (err) {
    logger.debug(
      `UseAI ${toolName} call failed:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────

export type CoveritCommand = "scan" | "cover" | "fix";

interface UseAISession {
  sessionId: string | null;
  command: CoveritCommand;
  projectRoot: string;
}

const COMMAND_TITLES: Record<CoveritCommand, { title: string; privatePrefix: string }> = {
  scan: { title: "Codebase quality scan", privatePrefix: "Coverit scan on" },
  cover: { title: "Test generation", privatePrefix: "Coverit cover on" },
  run: { title: "Test run and fix", privatePrefix: "Coverit run on" },
};

/**
 * Start a UseAI session for a coverit command.
 * Returns a session handle (or null if UseAI is unavailable).
 */
export async function useaiStart(
  command: CoveritCommand,
  projectRoot: string,
): Promise<UseAISession | null> {
  const { title, privatePrefix } = COMMAND_TITLES[command];
  const projectName = basename(projectRoot);

  const result = await callTool("useai_start", {
    task_type: "testing",
    title,
    private_title: `${privatePrefix} ${projectName}`,
    project: projectName,
  });

  if (!result) return null;

  // Extract session_id from response text
  const text = extractText(result);
  const sessionMatch = text.match(/· ([a-f0-9]+) ·/);
  const sessionId = sessionMatch?.[1] ?? null;

  return { sessionId, command, projectRoot };
}

export interface UseAIEndData {
  score?: number;
  modules?: number;
  scoreBefore?: number;
  scoreAfter?: number;
  testsGenerated?: number;
  testsPassed?: number;
  testsFailed?: number;
  totalTests?: number;
  passed?: number;
  failed?: number;
  fixed?: number;
  language?: string;
}

/**
 * End a UseAI session with coverit-specific milestones.
 */
export async function useaiEnd(
  session: UseAISession | null,
  data: UseAIEndData,
): Promise<void> {
  if (!session) return;

  const milestone = buildMilestone(session.command, data);
  const languages = data.language ? [data.language] : [];
  const filesTouched = (data.testsGenerated ?? 0) + (data.fixed ?? 0);

  await callTool("useai_end", {
    session_id: session.sessionId ?? undefined,
    task_type: "testing",
    languages,
    files_touched_count: filesTouched,
    milestones: [milestone],
  });
}

/**
 * Send a heartbeat to keep a long-running session alive.
 */
export async function useaiHeartbeat(): Promise<void> {
  if (!(await isDaemonRunning())) return;
  await callTool("useai_heartbeat", {});
}

// ─── Helpers ─────────────────────────────────────────────────

function buildMilestone(
  command: CoveritCommand,
  data: UseAIEndData,
): { title: string; private_title: string; category: string } {
  switch (command) {
    case "scan":
      return {
        title: `Scanned ${data.modules ?? 0} modules, score ${data.score ?? 0}/100`,
        private_title: `Coverit scanned ${data.modules ?? 0} modules, score ${data.score ?? 0}/100`,
        category: "analysis",
      };
    case "cover": {
      const delta = (data.scoreAfter ?? 0) - (data.scoreBefore ?? 0);
      const deltaStr = delta > 0 ? `+${delta}` : String(delta);
      return {
        title: `Generated ${data.testsGenerated ?? 0} tests, score ${data.scoreBefore ?? 0} -> ${data.scoreAfter ?? 0} (${deltaStr})`,
        private_title: `Coverit generated ${data.testsGenerated ?? 0} tests, ${data.testsPassed ?? 0} passed, ${data.testsFailed ?? 0} failed`,
        category: "test",
      };
    }
    case "fix": {
      const delta = (data.scoreAfter ?? 0) - (data.scoreBefore ?? 0);
      const deltaStr = delta > 0 ? `+${delta}` : String(delta);
      return {
        title: `Ran ${data.totalTests ?? 0} tests, fixed ${data.fixed ?? 0}, score ${data.scoreBefore ?? 0} -> ${data.scoreAfter ?? 0} (${deltaStr})`,
        private_title: `Coverit ran ${data.totalTests ?? 0} tests: ${data.passed ?? 0} passed, ${data.failed ?? 0} failed, ${data.fixed ?? 0} AI-fixed`,
        category: "test",
      };
    }
  }
}

function extractText(response: Record<string, unknown>): string {
  const result = response.result as { content?: Array<{ text?: string }> } | undefined;
  if (!result?.content) return "";
  return result.content.map((c) => c.text ?? "").join(" ");
}

// ─── HTTP Helpers (zero dependencies) ────────────────────────

function httpGet(path: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: DAEMON_HOST, port: DAEMON_PORT, path, method: "GET", timeout: timeoutMs },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

function httpPost(path: string, body: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: DAEMON_HOST,
        port: DAEMON_PORT,
        path,
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "mcp-session-id": mcpSessionId,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}
```

**Step 2: Verify it compiles**

Run: `bun run build`
Expected: Clean compilation, no errors.

**Step 3: Commit**

```bash
git add src/integrations/useai.ts
git commit -m "feat: add UseAI daemon client for session tracking"
```

---

### Task 2: Integrate UseAI into CLI handlers

**Files:**
- Modify: `src/cli/index.ts`

**Step 1: Add imports at the top of cli/index.ts**

After the existing imports, add:

```typescript
import { useaiStart, useaiEnd } from "../integrations/useai.js";
```

**Step 2: Add useai calls to the scan handler**

Wrap the scan handler's try block. Before the provider resolution:

```typescript
const session = await useaiStart("scan", projectRoot);
```

In the success path, after `renderDashboard(manifest)`:

```typescript
await useaiEnd(session, {
  modules: manifest.modules.length,
  score: manifest.score.overall,
  language: manifest.project.language,
});
```

In the catch block, before `process.exit(1)`:

```typescript
await useaiEnd(session, {});
```

**Step 3: Add useai calls to the cover handler**

Before provider resolution:

```typescript
const session = await useaiStart("cover", projectRoot);
```

In the success path, after the results table:

```typescript
await useaiEnd(session, {
  scoreBefore: result.scoreBefore,
  scoreAfter: result.scoreAfter,
  testsGenerated: result.testsGenerated,
  testsPassed: result.testsPassed,
  testsFailed: result.testsFailed,
  language: undefined, // not available in cover result
});
```

In the catch block:

```typescript
await useaiEnd(session, {});
```

**Step 4: Add useai calls to the run handler**

Before provider resolution:

```typescript
const session = await useaiStart("fix", projectRoot);
```

In the success path:

```typescript
await useaiEnd(session, {
  scoreBefore: result.scoreBefore,
  scoreAfter: result.scoreAfter,
  totalTests: result.totalTests,
  passed: result.passed,
  failed: result.failed,
  fixed: result.fixed,
});
```

In the catch block:

```typescript
await useaiEnd(session, {});
```

**Step 5: Verify it compiles**

Run: `bun run build`
Expected: Clean compilation.

**Step 6: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat: add UseAI session tracking to CLI scan/cover/run commands"
```

---

### Task 3: Integrate UseAI into MCP server

**Files:**
- Modify: `src/mcp/server.ts`

**Step 1: Add imports**

After existing imports:

```typescript
import { useaiStart, useaiEnd } from "../integrations/useai.js";
```

**Step 2: Add useai calls to coverit_scan tool**

At the start of the handler (inside the try, before `scanCodebase`):

```typescript
const session = await useaiStart("scan", projectRoot);
```

After `writeManifest`, before the return:

```typescript
await useaiEnd(session, {
  modules: manifest.modules.length,
  score: manifest.score.overall,
  language: manifest.project.language,
});
```

In the catch block:

```typescript
await useaiEnd(session, {});
```

Wait — `session` is declared inside the try. Move the session declaration before try, or add useaiEnd to both try's catch and outer catch. Simplest: declare `let session` before try, assign inside.

**Step 3: Add useai calls to coverit_cover tool**

Same pattern: `useaiStart` at the top, `useaiEnd` with result data on success, empty `useaiEnd` on error.

```typescript
await useaiEnd(session, {
  scoreBefore: result.scoreBefore,
  scoreAfter: result.scoreAfter,
  testsGenerated: result.testsGenerated,
  testsPassed: result.testsPassed,
  testsFailed: result.testsFailed,
});
```

**Step 4: Add useai calls to coverit_fix tool**

```typescript
await useaiEnd(session, {
  scoreBefore: result.scoreBefore,
  scoreAfter: result.scoreAfter,
  totalTests: result.totalTests,
  passed: result.passed,
  failed: result.failed,
  fixed: result.fixed,
});
```

**Step 5: Verify it compiles**

Run: `bun run build`
Expected: Clean compilation.

**Step 6: Commit**

```bash
git add src/mcp/server.ts
git commit -m "feat: add UseAI session tracking to MCP scan/cover/run tools"
```

---

### Task 4: Add heartbeat for long scans

**Files:**
- Modify: `src/scale/analyzer.ts`

**Step 1: Add heartbeat calls between dimension scans**

Import at the top:

```typescript
import { useaiHeartbeat } from "../integrations/useai.js";
```

Add heartbeat calls before each dimension scan (after phase events):

```typescript
// Before Security scan (step 7)
await useaiHeartbeat();

// Before Stability scan (step 8)
await useaiHeartbeat();

// Before Conformance scan (step 9)
await useaiHeartbeat();

// Before Regression scan (step 10)
await useaiHeartbeat();
```

This ensures sessions stay alive during long multi-dimension scans.

**Step 2: Verify it compiles**

Run: `bun run build`
Expected: Clean compilation.

**Step 3: Run all tests**

Run: `bun run test`
Expected: Same pass/fail count as before (17 pre-existing failures, 641 passes).

**Step 4: Commit**

```bash
git add src/scale/analyzer.ts
git commit -m "feat: add UseAI heartbeat between dimension scans"
```

---

### Task 5: Final verification

**Step 1: Full build**

Run: `bun run build`
Expected: Clean.

**Step 2: Full test suite**

Run: `bun run test`
Expected: 641 passed, 17 failed (all pre-existing).

**Step 3: Manual smoke test (if UseAI daemon is running)**

Run: `useai daemon start` (if not already running)
Run: `npx @devness/coverit status .` (quick command, verifies no crashes)

**Step 4: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "chore: finalize UseAI integration"
```
