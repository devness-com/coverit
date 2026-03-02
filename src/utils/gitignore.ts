/**
 * Ensures `.coverit/` is listed in the project's `.gitignore`.
 *
 * Called automatically when the `.coverit` directory is created so that
 * scan logs and other generated artifacts don't end up in git.
 */

import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";

const ENTRY = ".coverit/";

export async function ensureCoveritIgnored(projectRoot: string): Promise<void> {
  const gitignorePath = join(projectRoot, ".gitignore");

  let content: string;
  try {
    content = await readFile(gitignorePath, "utf-8");
  } catch {
    // No .gitignore yet — only create one if this is a git repo
    try {
      await access(join(projectRoot, ".git"));
    } catch {
      return; // Not a git repo, nothing to do
    }
    await writeFile(gitignorePath, `${ENTRY}\n`, "utf-8");
    return;
  }

  // Check if .coverit/ is already ignored (exact line match)
  const lines = content.split("\n");
  if (lines.some((line) => line.trim() === ENTRY || line.trim() === ".coverit")) {
    return; // Already present
  }

  // Append to existing .gitignore
  const separator = content.endsWith("\n") ? "" : "\n";
  await writeFile(gitignorePath, `${content}${separator}${ENTRY}\n`, "utf-8");
}
