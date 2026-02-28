#!/usr/bin/env node

/**
 * Coverit — Unified Entry Point
 *
 * npx @devness/coverit                → TTY: status/setup wizard; piped: MCP server
 * npx @devness/coverit mcp            → setup wizard (configure AI tools)
 * npx @devness/coverit scan/cover/run/… → delegates to CLI
 */

export {};

const subcommand = process.argv[2];

if (subcommand === 'mcp' || subcommand?.startsWith('--')) {
  // Setup wizard (also handles --flags like --tool)
  const { runSetup } = await import('./mcp-setup/index.js');
  await runSetup(process.argv.slice(subcommand === 'mcp' ? 3 : 2));
  process.exit(0);
} else if (!subcommand && process.stdin.isTTY) {
  // Terminal with no args — run setup wizard (shows detected tools, lets user choose)
  const { runSetup } = await import('./mcp-setup/index.js');
  await runSetup([]);
  process.exit(0);
} else if (!subcommand) {
  // Piped/non-TTY: MCP server (this is what AI tool configs invoke)
  await import('./mcp/server.js');
} else {
  // Forward to CLI for all other commands (scan, cover, run, status, clear)
  await import('./cli/index.js');
}
