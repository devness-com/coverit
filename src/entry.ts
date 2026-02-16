#!/usr/bin/env node

/**
 * Coverit — Unified Entry Point
 *
 * npx @devness/coverit            → MCP server (stdio, what AI tool configs invoke)
 * npx @devness/coverit mcp        → setup wizard (configure AI tools)
 * npx @devness/coverit scan/run/… → delegates to CLI (backward compatible)
 */

export {};

const subcommand = process.argv[2];

if (subcommand === 'mcp') {
  // Setup wizard
  const { runSetup } = await import('./mcp-setup/index.js');
  await runSetup(process.argv.slice(3));
  process.exit(0);
} else if (!subcommand) {
  // Default: MCP server (this is what AI tool configs invoke)
  await import('./mcp/server.js');
} else {
  // Forward to CLI for all other commands (scan, run, fix, etc.)
  await import('./cli/index.js');
}
