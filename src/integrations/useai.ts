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
  // Never call UseAI during test runs
  if (process.env["VITEST"] || process.env["JEST_WORKER_ID"] || process.env["NODE_ENV"] === "test") {
    return false;
  }

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

export type CoveritCommand = "scan" | "cover" | "run";

export interface UseAISession {
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
 *
 * @param model — AI provider name (e.g. "claude-cli", "gemini-cli"). Shown in UseAI dashboard.
 */
export async function useaiStart(
  command: CoveritCommand,
  projectRoot: string,
  model?: string,
): Promise<UseAISession | null> {
  const { title, privatePrefix } = COMMAND_TITLES[command];
  const projectName = basename(projectRoot);

  const result = await callTool("useai_start", {
    task_type: "testing",
    title,
    private_title: `${privatePrefix} ${projectName}`,
    project: projectName,
    model: model ?? "coverit",
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
    case "run": {
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
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => resolve(data));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
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
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => resolve(data));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.write(body);
    req.end();
  });
}
