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
import { join } from "node:path";

import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIGenerateOptions,
  AIProviderConfig,
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
} {
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const textParts: string[] = [];
  let model = "claude-cli";

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
            textParts.push(block["text"]);
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
          textParts.push(delta["text"]);
        }
      }

      // Handle result messages that wrap the final content
      if (obj["type"] === "result" && typeof obj["result"] === "string") {
        textParts.push(obj["result"]);
      }

      // Handle result messages with nested content
      if (
        obj["type"] === "result" &&
        obj["result"] &&
        typeof obj["result"] === "object" &&
        !Array.isArray(obj["result"])
      ) {
        const result = obj["result"] as Record<string, unknown>;
        if (Array.isArray(result["content"])) {
          for (const block of result["content"] as Array<
            Record<string, unknown>
          >) {
            if (
              block["type"] === "text" &&
              typeof block["text"] === "string"
            ) {
              textParts.push(block["text"]);
            }
          }
        }
      }
    } catch {
      // Skip malformed JSON lines (progress indicators, etc.)
    }
  }

  return { content: textParts.join(""), model };
}

export class ClaudeCliProvider implements AIProvider {
  readonly name = "claude-cli";
  private readonly model: string;
  private binaryPath: string | null = null;

  constructor(config?: Partial<AIProviderConfig>) {
    this.model = config?.model ?? "sonnet";
  }

  async isAvailable(): Promise<boolean> {
    this.binaryPath = await findClaudeBinary();
    return this.binaryPath !== null;
  }

  async generate(
    messages: AIMessage[],
    _options?: AIGenerateOptions,
  ): Promise<AIResponse> {
    if (!this.binaryPath) {
      this.binaryPath = await findClaudeBinary();
    }
    if (!this.binaryPath) {
      throw new Error(
        "Claude CLI binary not found. Install Claude Code: https://docs.anthropic.com/en/docs/claude-code",
      );
    }

    // Flatten messages into a single prompt string.
    const prompt = messages
      .map((msg) => {
        if (msg.role === "system") return `[System Instructions]\n${msg.content}\n`;
        if (msg.role === "user") return `[User]\n${msg.content}\n`;
        return `[Assistant]\n${msg.content}\n`;
      })
      .join("\n");

    // Use --print with prompt piped via stdin to avoid CLI arg length limits.
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      this.model,
    ];

    const result = await this.spawnClaude(args, prompt);

    if (result.exitCode !== 0 && !result.stdout.trim()) {
      throw new Error(
        `Claude CLI exited with code ${result.exitCode}: ${result.stderr || "Unknown error"}`,
      );
    }

    const { content, model } = parseStreamingOutput(result.stdout);

    if (!content) {
      throw new Error(
        "Claude CLI returned no text content. stderr: " +
          (result.stderr || "(empty)"),
      );
    }

    return { content, model };
  }

  private spawnClaude(
    args: string[],
    stdinData?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.binaryPath!, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      let stdout = "";
      let stderr = "";
      let killed = false;

      const timeout = setTimeout(() => {
        killed = true;
        proc.kill("SIGTERM");
        reject(new Error("Claude CLI timed out after 120s"));
      }, 120_000);

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("close", (code) => {
        clearTimeout(timeout);
        if (!killed) {
          resolve({ stdout, stderr, exitCode: code ?? 1 });
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
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
