/**
 * UseAI Integration — Optional session tracking via UseAI daemon.
 *
 * Calls UseAI's local HTTP daemon (localhost:19200) to create dedicated
 * coverit sessions. Fail-silent — if UseAI isn't running, all functions
 * return gracefully without blocking coverit's core flow.
 */

import { request } from "node:http";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../utils/logger.js";

const DAEMON_HOST = "127.0.0.1";
const DAEMON_PORT = 19200;
const HEALTH_TIMEOUT_MS = 500;
const CALL_TIMEOUT_MS = 2_000;

// MCP session ID — assigned by the UseAI daemon after initialize handshake.
// Must NOT be sent with the initial `initialize` request (the server generates it).
let mcpSessionId: string | null = null;
let jsonRpcId = 0;
let daemonAvailable: boolean | null = null;
let mcpInitialized = false;

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

/**
 * Send MCP initialize handshake so UseAI knows the client/provider.
 * The clientName should be the actual AI provider (e.g. "claude-code",
 * "gemini-cli") — not "coverit", since coverit is just the orchestrator.
 *
 * The initialize request MUST be sent without a session ID header.
 * The server generates a session ID and returns it in the `mcp-session-id`
 * response header. All subsequent requests must include this server-assigned ID.
 */
async function ensureMcpInitialized(clientName?: string): Promise<void> {
  if (mcpInitialized) return;
  mcpInitialized = true;

  const payload = JSON.stringify({
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: clientName ?? "coverit", version: getVersion() },
    },
    id: ++jsonRpcId,
  });

  try {
    const { headers } = await httpPostWithHeaders("/mcp", payload, CALL_TIMEOUT_MS);
    // Capture server-assigned session ID for subsequent requests
    const sid = headers["mcp-session-id"];
    if (sid) {
      mcpSessionId = sid;
      logger.debug(`UseAI MCP session: ${sid}`);
    }

    // Send notifications/initialized (MCP spec requirement after initialize handshake).
    // This tells the server the client is ready and prevents orphaned "Untitled" sessions.
    const notifyPayload = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    await httpPost("/mcp", notifyPayload, CALL_TIMEOUT_MS).catch(() => {});
  } catch {
    // Non-fatal — tools/call may still work without initialize
  }
}

function getVersion(): string {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(dir, "..", "..", "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Call a UseAI MCP tool via the daemon's JSON-RPC endpoint. */
async function callTool(
  toolName: string,
  args: Record<string, unknown>,
  clientName?: string,
): Promise<Record<string, unknown> | null> {
  if (!(await isDaemonRunning())) return null;
  await ensureMcpInitialized(clientName);

  const payload = JSON.stringify({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: toolName, arguments: args },
    id: ++jsonRpcId,
  });

  try {
    const { body, headers } = await httpPostWithHeaders("/mcp", payload, CALL_TIMEOUT_MS);
    const json = extractJsonFromResponse(body);
    const parsed = JSON.parse(json) as Record<string, unknown>;

    // Check for JSON-RPC error indicating stale/expired MCP session
    if (parsed.error && mcpSessionId) {
      logger.debug(`UseAI ${toolName}: MCP session may be stale, re-initializing...`);
      mcpInitialized = false;
      mcpSessionId = null;
      await ensureMcpInitialized(clientName);

      // Retry with fresh session
      const retryPayload = JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: toolName, arguments: args },
        id: ++jsonRpcId,
      });
      const retryResponse = await httpPost("/mcp", retryPayload, CALL_TIMEOUT_MS);
      const retryJson = extractJsonFromResponse(retryResponse);
      return JSON.parse(retryJson) as Record<string, unknown>;
    }

    // Track refreshed session ID from response headers
    if (headers["mcp-session-id"] && headers["mcp-session-id"] !== mcpSessionId) {
      mcpSessionId = headers["mcp-session-id"];
    }

    return parsed;
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

export interface UseAIStartOptions {
  /** AI provider name (e.g. "claude-cli", "gemini-cli") */
  provider?: string;
  /** AI model ID (e.g. "claude-opus-4-6"). Shown in UseAI dashboard. */
  model?: string;
}

/**
 * Start a UseAI session for a coverit command.
 * Returns a session handle (or null if UseAI is unavailable).
 */
export async function useaiStart(
  command: CoveritCommand,
  projectRoot: string,
  options?: UseAIStartOptions,
): Promise<UseAISession | null> {
  const { title, privatePrefix } = COMMAND_TITLES[command];
  const projectName = basename(projectRoot);

  // Prefer model ID (e.g. "claude-opus-4-6"), fall back to provider name, then "coverit"
  const modelId = options?.model ?? options?.provider ?? "coverit";

  const result = await callTool("useai_start", {
    task_type: "testing",
    title,
    private_title: `${privatePrefix} ${projectName}`,
    project: projectName,
    model: modelId,
  }, options?.provider);

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

/**
 * Extract JSON from a response that may be plain JSON or SSE format.
 * MCP HTTP transport may return `event: message\ndata: {...}` (SSE)
 * or plain JSON depending on the server version.
 */
function extractJsonFromResponse(response: string): string {
  const trimmed = response.trim();
  // Plain JSON — starts with { or [
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }
  // SSE format — extract from "data: " lines
  for (const line of trimmed.split("\n")) {
    if (line.startsWith("data: ")) {
      return line.slice(6);
    }
  }
  return trimmed;
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
  return httpPostWithHeaders(path, body, timeoutMs).then((r) => r.body);
}

function httpPostWithHeaders(
  path: string,
  body: string,
  timeoutMs: number,
): Promise<{ body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Content-Length": String(Buffer.byteLength(body)),
    };
    // Only include session ID after the initialize handshake has assigned one
    if (mcpSessionId) {
      headers["mcp-session-id"] = mcpSessionId;
    }

    const req = request(
      {
        hostname: DAEMON_HOST,
        port: DAEMON_PORT,
        path,
        method: "POST",
        timeout: timeoutMs,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => {
          // Collect response headers (lowercased keys)
          const resHeaders: Record<string, string> = {};
          for (const [key, val] of Object.entries(res.headers)) {
            if (typeof val === "string") resHeaders[key] = val;
          }
          resolve({ body: data, headers: resHeaders });
        });
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
