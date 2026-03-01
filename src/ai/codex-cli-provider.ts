/**
 * Codex CLI Provider
 *
 * Leverages OpenAI's Codex CLI binary to run prompts using the user's
 * existing OpenAI subscription. Modelled after the Claude CLI provider:
 * spawns the `codex` binary, pipes the prompt via stdin, and parses
 * the output.
 *
 * The Codex CLI is invoked with `--print` for non-interactive single-shot
 * mode. Output is expected as plain text.
 *
 * TODO: Confirm exact CLI flags once Codex CLI stabilizes.
 *       Current implementation is based on the documented `codex` CLI interface.
 */

import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { trackProcess } from "../utils/process-tracker.js";

import type {
  AIProvider,
  AIMessage,
  AIResponse,
  AIGenerateOptions,
  AIProviderConfig,
} from "./types.js";

/** Known filesystem locations where the codex binary might live */
const CODEX_BINARY_PATHS = [
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
  join(homedir(), ".local", "bin", "codex"),
  join(homedir(), ".npm-global", "bin", "codex"),
];

/**
 * Resolve the path to the codex CLI binary.
 * Tries `which` first, then falls back to known filesystem locations.
 */
async function findCodexBinary(): Promise<string | null> {
  // Fast path: check if `codex` is on PATH
  const whichResult = await new Promise<string | null>((resolve) => {
    const proc = spawn("which", ["codex"]);
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
  for (const binPath of CODEX_BINARY_PATHS) {
    try {
      await access(binPath, constants.X_OK);
      return binPath;
    } catch {
      // Not found or not executable at this path
    }
  }

  return null;
}

export class CodexCliProvider implements AIProvider {
  readonly name = "codex-cli";
  readonly model: string | undefined;
  private binaryPath: string | null = null;

  constructor(config?: Partial<AIProviderConfig>) {
    // Use explicit config -> COVERIT_MODEL env var -> undefined (inherit CLI default)
    this.model = config?.model ?? process.env["COVERIT_MODEL"] ?? undefined;
  }

  async isAvailable(): Promise<boolean> {
    this.binaryPath = await findCodexBinary();
    return this.binaryPath !== null;
  }

  async generate(
    messages: AIMessage[],
    options?: AIGenerateOptions,
  ): Promise<AIResponse> {
    if (!this.binaryPath) {
      this.binaryPath = await findCodexBinary();
    }
    if (!this.binaryPath) {
      throw new Error(
        "Codex CLI binary not found. Install the Codex CLI: https://github.com/openai/codex",
      );
    }

    // Separate system prompt from user content
    const systemMessages = messages.filter((m) => m.role === "system");
    const userMessages = messages.filter((m) => m.role !== "system");

    // Build the prompt to pipe via stdin
    const prompt = userMessages
      .map((msg) => msg.content)
      .join("\n\n");

    // TODO: Verify exact Codex CLI flags when stable release is available.
    // Current assumption: `codex` accepts a prompt from stdin in non-interactive mode.
    // -c mcp.enabled=false disables all MCP servers from user config
    //   (avoids hooks/tools from user config interfering with analysis prompts)
    const args = ["--print", "-c", "mcp.enabled=false"];

    // Pass system prompt via CLI flag if available
    if (systemMessages.length > 0) {
      const systemPrompt = systemMessages.map((m) => m.content).join("\n\n");
      args.push("--system-prompt", systemPrompt);
    }

    // Pass model override if explicitly configured
    if (this.model) {
      args.push("--model", this.model);
    }

    const result = await this.spawnCodex(args, prompt, options?.cwd, options?.timeoutMs);

    if (result.exitCode !== 0 && !result.stdout.trim()) {
      throw new Error(
        `Codex CLI exited with code ${result.exitCode}: ${result.stderr || "Unknown error"}`,
      );
    }

    const content = result.stdout.trim();

    if (!content) {
      throw new Error(
        "Codex CLI returned no content. stderr: " +
          (result.stderr || "(empty)"),
      );
    }

    return { content, model: this.model ?? "codex-cli" };
  }

  private spawnCodex(
    args: string[],
    stdinData?: string,
    cwd?: string,
    callTimeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.binaryPath!, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
        ...(cwd ? { cwd } : {}),
      });
      trackProcess(proc);

      let stdout = "";
      let stderr = "";
      let killed = false;

      const timeoutMs = callTimeoutMs ?? 600_000; // default 10 minutes
      const timeout = setTimeout(() => {
        killed = true;
        proc.kill("SIGTERM");
        reject(new Error(`Codex CLI timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);

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
            new Error(`Failed to spawn Codex CLI: ${err.message}`),
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
