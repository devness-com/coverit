/**
 * Coverit — AI Triage
 *
 * Single AI call decides what tests to write.
 * The AI uses Read/Grep/Glob tools to incrementally examine files.
 * No heuristic fallback — AI makes all decisions.
 */

import type { AIProvider } from "../ai/types.js";
import type {
  ContextBundle,
  TestType,
  TriageResult,
} from "../types/index.js";
import { buildTriagePrompt, parseTriageResponse } from "../ai/triage-prompts.js";
import { logger } from "../utils/logger.js";

/**
 * Use AI to decide what tests to write for the given context.
 * The AI uses Read/Grep/Glob tools to incrementally examine files.
 * Retries once on failure. No heuristic fallback.
 */
export async function triageWithAI(
  context: ContextBundle,
  aiProvider: AIProvider,
  options?: { testTypes?: TestType[]; projectRoot?: string; scanMode?: "all" | "diff" },
): Promise<TriageResult> {
  const MAX_ATTEMPTS = 2;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const messages = buildTriagePrompt(context, { testTypes: options?.testTypes, scanMode: options?.scanMode });
      const response = await aiProvider.generate(messages, {
        temperature: attempt === 1 ? 0.1 : 0.2, // slightly higher temp on retry
        maxTokens: 16384,
        allowedTools: ["Read", "Grep", "Glob"],
        cwd: options?.projectRoot,
      });

      // Log response info for debugging
      const contentLen = response.content.length;
      const contentTail = response.content.slice(-500);
      logger.debug(`AI triage attempt ${attempt}: response length=${contentLen}, model=${response.model}`);
      logger.debug(`AI triage response tail: ...${contentTail}`);

      const result = parseTriageResponse(response.content);

      if (result.plans.length === 0 && context.changedFiles.length > 0) {
        logger.warn(`AI triage attempt ${attempt}: returned no plans (response ${contentLen} chars)`);
        logger.debug(`AI triage: skipped=${result.skipped.length}, first 200 chars: ${response.content.slice(0, 200)}`);
        if (attempt < MAX_ATTEMPTS) {
          logger.info("Retrying AI triage...");
          continue;
        }
        // Return result with skipped items even if no plans — don't fall back
        logger.warn("AI triage returned no plans after retries");
        return result;
      }

      // Apply test type filter if specified
      if (options?.testTypes && options.testTypes.length > 0) {
        const allowed = new Set(options.testTypes);
        result.plans = result.plans
          .map((plan) => ({
            ...plan,
            testTypes: plan.testTypes.filter((t) => allowed.has(t)),
          }))
          .filter((plan) => plan.testTypes.length > 0);
      }

      logger.info(`AI triage: ${result.plans.length} plans, ${result.skipped.length} skipped (attempt ${attempt})`);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;
      logger.warn(`AI triage attempt ${attempt} failed: ${msg}`);
      if (attempt < MAX_ATTEMPTS) {
        logger.info("Retrying AI triage...");
        continue;
      }
    }
  }

  // All attempts failed — return empty result with error info, no fallback
  logger.error(`AI triage failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
  return { plans: [], skipped: [] };
}
