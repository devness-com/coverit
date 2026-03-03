import { createToolRegistry, createSetupRunner } from '@devness/mcp-setup';

const COVERIT_INSTRUCTIONS_TEXT = [
  '## Coverit — AI Test Generation',
  '',
  'Coverit generates and runs tests. Available via MCP tools or slash commands:',
  '- `/coverit:scan` — AI scans and analyzes codebase, creates coverit.json',
  '- `/coverit:cover` — AI generates tests from gaps and updates your score',
  '- `/coverit:fix` — Fix failing tests, update your score',
  '- `/coverit:status` — Show quality dashboard from coverit.json',
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
  pluginId: 'coverit@coverit',
});

const runner = createSetupRunner({
  productName: 'Coverit',
  ...registry,
  instructionsText: COVERIT_INSTRUCTIONS_TEXT,
});

export const { runSetup } = runner;
export { registry };
