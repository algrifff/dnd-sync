// The steps for adding Compendium as an MCP connector to each client we
// support. The URL is the same for every World: the World is picked on
// the consent screen when the client signs in.

export type ConnectTarget = {
  id: 'claude' | 'claude-code' | 'codex';
  label: string;
  steps: string[];
  /** Terminal commands, run in order. Absent for app-only setups. */
  commands?: string[];
};

export function connectTargets(mcpUrl: string): ConnectTarget[] {
  return [
    {
      id: 'claude',
      label: 'Claude app',
      steps: [
        'In claude.ai or Claude Desktop, open Settings → Connectors.',
        'Choose "Add custom connector", name it Compendium and paste the link above.',
        'Click Connect, sign in to Compendium and pick the World to share.',
        'The connector then works in Claude on the web, desktop and mobile.',
      ],
    },
    {
      id: 'claude-code',
      label: 'Claude Code',
      steps: [
        'Run this in a terminal:',
        'Then start claude, type /mcp, pick compendium and choose Authenticate. Your browser opens to sign in and pick the World.',
      ],
      commands: [`claude mcp add --transport http compendium ${mcpUrl}`],
    },
    {
      id: 'codex',
      label: 'Codex',
      steps: [
        'Run these in a terminal. The second one opens your browser to sign in and pick the World.',
      ],
      commands: [`codex mcp add compendium --url ${mcpUrl}`, 'codex mcp login compendium'],
    },
  ];
}

export const EXAMPLE_PROMPTS = [
  'What do we know about the Zhentarim so far?',
  'Who did we meet in our last session?',
  'Wrap up our latest session in Compendium.',
] as const;
