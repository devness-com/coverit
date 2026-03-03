/**
 * Claude CLI Provider
 *
 * Leverages the user's existing Claude Code installation by spawning
 * the `claude` CLI binary. This is the preferred provider since it
 * uses the user's existing Claude Pro/Max subscription with zero
 * additional cost or API key configuration.
 *
 * The CLI is invoked with `--output-format=stream-json` and we parse
 * the streaming NDJSON to extract the assistant's text response.
 */

import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { trackProcess } from "../utils/process-tracker.js";
import { join } from "node:path";

import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIUsage,
  AIGenerateOptions,
  AIProviderConfig,
  AIProgressEvent,
} from "./types.js";

/** Known filesystem locations where the claude binary might live */
const CLAUDE_BINARY_PATHS = [
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
  join(homedir(), ".claude", "bin", "claude"),
  join(homedir(), ".local", "bin", "claude"),
];

/**
 * Resolve the path to the claude CLI binary.
 * Tries `which` first, then falls back to known filesystem locations.
 */
async function findClaudeBinary(): Promise<string | null> {
  // Fast path: check if `claude` is on PATH
  const whichResult = await new Promise<string | null>((resolve) => {
    const proc = spawn("which", ["claude"]);
    let stdout = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.on("close", (code) => {
      resolve(code === 0 ? stdout.trim() : null);
    });
    proc.on("error", () => resolve(null));
  });

  if (whichResult) return whichResult;

  // Fallback: probe known locations
  for (const binPath of CLAUDE_BINARY_PATHS) {
    try {
      await access(binPath, constants.X_OK);
      return binPath;
    } catch {
      // Not found or not executable at this path
    }
  }

  return null;
}

/**
 * Parse streaming JSON lines from the claude CLI.
 *
 * The CLI emits newline-delimited JSON objects. We look for assistant
 * messages that contain text content blocks and accumulate them into
 * the final response string.
 */
function parseStreamingOutput(raw: string): {
  content: string;
  model: string;
  usage?: AIUsage;
} {
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const assistantParts: string[] = [];
  let resultContent: string | null = null;
  let model = "claude-cli";
  let usage: AIUsage | undefined;

  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object") continue;

      const obj = parsed as Record<string, unknown>;

      // Extract model info from any message that carries it
      if (typeof obj["model"] === "string") {
        model = obj["model"];
      }

      // Look for assistant messages with content blocks
      if (obj["type"] === "assistant" && Array.isArray(obj["content"])) {
        for (const block of obj["content"] as Array<
          Record<string, unknown>
        >) {
          if (block["type"] === "text" && typeof block["text"] === "string") {
            assistantParts.push(block["text"]);
          }
        }
      }

      // Also handle content_block_delta streaming events
      if (
        obj["type"] === "content_block_delta" &&
        obj["delta"] &&
        typeof obj["delta"] === "object"
      ) {
        const delta = obj["delta"] as Record<string, unknown>;
        if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
          assistantParts.push(delta["text"]);
        }
      }

      // Handle result messages — prefer this as the canonical response
      if (obj["type"] === "result") {
        if (typeof obj["result"] === "string") {
          resultContent = obj["result"];
        } else if (
          obj["result"] &&
          typeof obj["result"] === "object" &&
          !Array.isArray(obj["result"])
        ) {
          const result = obj["result"] as Record<string, unknown>;
          if (Array.isArray(result["content"])) {
            const parts: string[] = [];
            for (const block of result["content"] as Array<
              Record<string, unknown>
            >) {
              if (
                block["type"] === "text" &&
                typeof block["text"] === "string"
              ) {
                parts.push(block["text"]);
              }
            }
            if (parts.length > 0) {
              resultContent = parts.join("");
            }
          }
        }

        // Extract usage data from result event
        usage = extractUsageFromResult(obj);
      }
    } catch {
      // Skip malformed JSON lines (progress indicators, etc.)
    }
  }

  // Prefer `result` event content (avoids duplication from multi-turn tool use)
  // Fall back to concatenated assistant text parts if no result event
  const content = resultContent ?? assistantParts.join("");

  return { content, model, usage };
}

/**
 * Extract token usage statistics from a Claude CLI result event.
 *
 * The result event (SDKResultMessage) contains:
 *   usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
 *   total_cost_usd, duration_ms, duration_api_ms, num_turns
 */
function extractUsageFromResult(obj: Record<string, unknown>): AIUsage | undefined {
  const usageObj = obj["usage"] as Record<string, unknown> | undefined;
  if (!usageObj || typeof usageObj !== "object") return undefined;

  const inputTokens = typeof usageObj["input_tokens"] === "number" ? usageObj["input_tokens"] : 0;
  const outputTokens = typeof usageObj["output_tokens"] === "number" ? usageObj["output_tokens"] : 0;

  // If both are 0, the result event likely doesn't have usage data
  if (inputTokens === 0 && outputTokens === 0) return undefined;

  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens: typeof usageObj["cache_read_input_tokens"] === "number" ? usageObj["cache_read_input_tokens"] : 0,
    cacheCreationInputTokens: typeof usageObj["cache_creation_input_tokens"] === "number" ? usageObj["cache_creation_input_tokens"] : 0,
    totalCostUsd: typeof obj["total_cost_usd"] === "number" ? obj["total_cost_usd"] : 0,
    durationMs: typeof obj["duration_ms"] === "number" ? obj["duration_ms"] : 0,
    durationApiMs: typeof obj["duration_api_ms"] === "number" ? obj["duration_api_ms"] : 0,
    numTurns: typeof obj["num_turns"] === "number" ? obj["num_turns"] : 0,
  };
}

export class ClaudeCliProvider implements AIProvider {
  readonly name = "claude-cli";
  readonly model: string | undefined;
  private binaryPath: string | null = null;

  constructor(config?: Partial<AIProviderConfig>) {
    // Use explicit config → COVERIT_MODEL env var → undefined (inherit user's default)
    this.model = config?.model ?? process.env["COVERIT_MODEL"] ?? undefined;
  }

  async isAvailable(): Promise<boolean> {
    this.binaryPath = await findClaudeBinary();
    return this.binaryPath !== null;
  }

  async generate(
    messages: AIMessage[],
    options?: AIGenerateOptions,
  ): Promise<AIResponse> {
    if (!this.binaryPath) {
      this.binaryPath = await findClaudeBinary();
    }
    if (!this.binaryPath) {
      throw new Error(
        "Claude CLI binary not found. Install Claude Code: https://docs.anthropic.com/en/docs/claude-code",
      );
    }

    // Separate system prompt from user content for proper Claude CLI handling
    const systemMessages = messages.filter((m) => m.role === "system");
    const userMessages = messages.filter((m) => m.role !== "system");

    // The user prompt is piped via stdin
    const prompt = userMessages
      .map((msg) => msg.content)
      .join("\n\n");

    // Use --print with prompt piped via stdin to avoid CLI arg length limits.
    // --no-session-persistence prevents the subprocess from writing to
    //   ~/.claude/.claude.json — avoids corrupting the user's auth state
    //   when the subprocess runs concurrently with an interactive session.
    // --setting-sources "" prevents loading user/project CLAUDE.md files
    //   (avoids UseAI/AutoDo hooks interfering with analysis prompts)
    // --strict-mcp-config prevents loading any MCP servers from user config
    //   (avoids UseAI MCP tools being available in the subprocess)
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--setting-sources",
      "",
      "--strict-mcp-config",
    ];

    // Pass system prompt as a proper CLI flag
    if (systemMessages.length > 0) {
      const systemPrompt = systemMessages.map((m) => m.content).join("\n\n");
      args.push("--system-prompt", systemPrompt);
    }

    // Only pass --model when explicitly configured; otherwise inherit user's default
    if (this.model) {
      args.push("--model", this.model);
    }

    // Enable tool access for agentic calls (e.g. triage reads files incrementally)
    if (options?.allowedTools && options.allowedTools.length > 0) {
      args.push("--allowedTools", options.allowedTools.join(","));
      args.push("--dangerously-skip-permissions"); // safe: restricted to read-only tools
    }

    const result = await this.spawnClaude(args, prompt, options?.cwd, options?.timeoutMs, options?.maxWallTimeMs, options?.onProgress);

    if (result.exitCode !== 0 && !result.stdout.trim()) {
      throw new Error(
        `Claude CLI exited with code ${result.exitCode}: ${result.stderr || "Unknown error"}`,
      );
    }

    const { content, model, usage } = parseStreamingOutput(result.stdout);

    if (!content) {
      throw new Error(
        "Claude CLI returned no text content. stderr: " +
          (result.stderr || "(empty)"),
      );
    }

    return { content, model, usage };
  }

  private spawnClaude(
    args: string[],
    stdinData?: string,
    cwd?: string,
    callTimeoutMs?: number,
    callMaxWallTimeMs?: number,
    onProgress?: (event: AIProgressEvent) => void,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      // Strip Claude Code internal env vars to avoid blocking nested sessions
      const env = { ...process.env };
      delete env["CLAUDECODE"];
      delete env["CLAUDE_CODE_ENTRYPOINT"];
      delete env["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"];

      const proc = spawn(this.binaryPath!, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        ...(cwd ? { cwd } : {}),
      });
      trackProcess(proc);

      let stdout = "";
      let stderr = "";
      let killed = false;
      let lineBuffer = ""; // Buffer for incomplete NDJSON lines

      // Activity-based timeout: resets on every stdout chunk so productive
      // AI sessions that keep generating output are never killed prematurely.
      const timeoutMs = callTimeoutMs ?? 600_000; // default 10 minutes
      let timeout: ReturnType<typeof setTimeout>;
      const resetTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          killed = true;
          proc.kill("SIGTERM");
          reject(new Error(`Claude CLI timed out after ${timeoutMs / 1000}s of inactivity`));
        }, timeoutMs);
      };
      resetTimeout();

      // Absolute wall-time timeout: kills the process regardless of activity.
      // Prevents runaway scans on large codebases where the AI is continuously
      // active but never converges on a final answer.
      const maxWallTimeMs = callMaxWallTimeMs ?? 1_800_000; // default 30 minutes
      const wallTimeout = setTimeout(() => {
        if (!killed) {
          killed = true;
          proc.kill("SIGTERM");
          const mins = Math.round(maxWallTimeMs / 60_000);
          reject(new Error(`Claude CLI exceeded ${mins}m absolute wall-time limit`));
        }
      }, maxWallTimeMs);

      proc.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        resetTimeout(); // Reset inactivity timer on output

        // Stream progress events in real-time
        if (onProgress) {
          lineBuffer += text;
          const lines = lineBuffer.split("\n");
          // Keep the last incomplete line in the buffer
          lineBuffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const obj = JSON.parse(trimmed) as Record<string, unknown>;
              emitProgressEvent(obj, onProgress);
            } catch {
              // Skip malformed lines
            }
          }
        }
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("close", (code) => {
        clearTimeout(timeout);
        clearTimeout(wallTimeout);
        if (!killed) {
          resolve({ stdout, stderr, exitCode: code ?? 1 });
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        clearTimeout(wallTimeout);
        if (!killed) {
          reject(
            new Error(`Failed to spawn Claude CLI: ${err.message}`),
          );
        }
      });

      // Pipe prompt via stdin and close to signal EOF
      if (stdinData) {
        proc.stdin.write(stdinData);
        proc.stdin.end();
      } else {
        proc.stdin.end();
      }
    });
  }
}

/**
 * Extract progress events from a parsed streaming JSON object.
 *
 * Claude CLI stream-json format emits objects like:
 *   {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Glob",...}]}}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 *   {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
 */
function emitProgressEvent(
  obj: Record<string, unknown>,
  onProgress: (event: AIProgressEvent) => void,
): void {
  // Emit model_detected when we see the model in the stream
  if (typeof obj["model"] === "string") {
    onProgress({ type: "model_detected", model: obj["model"] });
  }

  // Handle assistant messages with content blocks (tool_use, text)
  if (obj["type"] === "assistant") {
    const message = obj["message"] as Record<string, unknown> | undefined;
    const contentBlocks =
      (message && Array.isArray(message["content"]) ? message["content"] : null) ??
      (Array.isArray(obj["content"]) ? obj["content"] : null);

    if (contentBlocks) {
      for (const block of contentBlocks as Array<Record<string, unknown>>) {
        if (block["type"] === "tool_use" && typeof block["name"] === "string") {
          const input = block["input"] as Record<string, unknown> | undefined;
          // Extract a brief description of what the tool is doing
          const inputSummary = input
            ? summarizeToolInput(block["name"], input)
            : undefined;
          onProgress({ type: "tool_use", tool: block["name"], input: inputSummary });
        }
        if (block["type"] === "text" && typeof block["text"] === "string") {
          onProgress({ type: "text_delta", text: block["text"] });
        }
      }
    }
  }

  // Handle streaming text deltas
  if (obj["type"] === "content_block_delta") {
    const delta = obj["delta"] as Record<string, unknown> | undefined;
    if (delta && delta["type"] === "text_delta" && typeof delta["text"] === "string") {
      onProgress({ type: "text_delta", text: delta["text"] });
    }
  }
}

/** Produce a short human-readable summary of a tool's input */
function summarizeToolInput(
  tool: string,
  input: Record<string, unknown>,
): string {
  switch (tool) {
    case "Read":
      return typeof input["file_path"] === "string"
        ? input["file_path"]
        : "";
    case "Glob":
      return typeof input["pattern"] === "string"
        ? input["pattern"]
        : "";
    case "Grep":
      return typeof input["pattern"] === "string"
        ? input["pattern"]
        : "";
    case "Bash": {
      const cmd = typeof input["command"] === "string" ? input["command"] : "";
      return cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
    }
    default:
      return "";
  }
}
