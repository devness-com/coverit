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
  // Terminal with no args — show status or run setup
  const { registry, runSetup } = await import('./mcp-setup/index.js');
  const { readFileSync } = await import('node:fs');
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

  const configured = registry.tools
    .filter(t => { try { return t.isConfigured(); } catch { return false; } })
    .map(t => t.name);

  if (configured.length === 0) {
    await runSetup([]);
  } else {
    console.log(`\nCoverit v${version}\n`);
    console.log(`Configured in: ${configured.join(', ')}\n`);
    console.log('Commands:');
    console.log('  npx @devness/coverit mcp       Reconfigure AI tools');
    console.log('  npx @devness/coverit scan      AI scans codebase → coverit.json');
    console.log('  npx @devness/coverit cover     AI generates tests from gaps');
    console.log('  npx @devness/coverit run       Run tests, fix failures');
    console.log('  npx @devness/coverit status    Show quality dashboard');
    console.log();
  }
  process.exit(0);
} else if (!subcommand) {
  // Piped/non-TTY: MCP server (this is what AI tool configs invoke)
  await import('./mcp/server.js');
} else {
  // Forward to CLI for all other commands (scan, cover, run, status, clear)
  await import('./cli/index.js');
}
