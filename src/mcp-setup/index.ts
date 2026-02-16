import { createToolRegistry, createSetupRunner } from '@devness/mcp-setup';

const COVERIT_INSTRUCTIONS_TEXT = [
  '## Coverit — AI Test Generation',
  '',
  'Coverit generates and runs tests. Available via MCP tools or slash commands:',
  '- `/coverit:scan` — Analyze changes and show test strategy',
  '- `/coverit:full` — Complete pipeline: scan, generate, run, fix',
  '- `/coverit:fix` — Fix failing tests from the last run',
].join('\n');

const registry = createToolRegistry({
  serverName: 'Coverit',
  legacyName: 'coverit',
  mcpEntry: { command: 'npx', args: ['-y', '@devness/coverit@latest'] },
  instructions: {
    text: COVERIT_INSTRUCTIONS_TEXT,
    startMarker: '<!-- coverit:start -->',
    endMarker: '<!-- coverit:end -->',
  },
  instructionFileName: 'coverit',
});

const runner = createSetupRunner({
  productName: 'Coverit',
  ...registry,
  instructionsText: COVERIT_INSTRUCTIONS_TEXT,
});

export const { runSetup } = runner;
