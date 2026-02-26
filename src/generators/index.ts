import type { AIProvider } from "../ai/types.js";
import type { ProjectInfo } from "../types/index.js";
import { AIGenerator } from "./ai-generator.js";

export { AIGenerator } from "./ai-generator.js";

// Gap-driven generation
export { analyzeGaps } from "./gap-analyzer.js";
export type { Gap, GapAnalysis } from "./gap-analyzer.js";
export { generateForGaps } from "./targeted-generator.js";

/**
 * Factory function that returns an AIGenerator for the given project.
 * The AI generator handles all test types with a single unified implementation.
 */
export function createAIGenerator(
  aiProvider: AIProvider | null,
  project: ProjectInfo,
): AIGenerator {
  return new AIGenerator(aiProvider, project);
}
