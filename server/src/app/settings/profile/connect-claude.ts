// The steps for adding Compendium as an MCP connector to each client we
// support. The URL is the same for every World: the World is picked on
// the consent screen when the client signs in.

export type ConnectTarget = {
  id: 'claude' | 'claude-code' | 'codex';
  label: string;
  /** The paragraph shown before the commands. */
  intro: string;
  /** Terminal commands, run in order. Absent for app-only setups. */
  commands?: string[];
  /** Paragraphs shown after the commands. */
  after: string[];
};

const HOST_PATTERN = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])$/;

/**
 * The MCP URL if it is safe to paste into a terminal command, else null.
 * It must be an http(s) URL whose host is plain (letters, digits, dots,
 * hyphens, or a bracketed IPv6 literal), with no credentials, and whose
 * path is exactly /api/mcp. Anything else means PUBLIC_APP_URL is unset or wrong.
 */
export function safeMcpUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!HOST_PATTERN.test(parsed.hostname)) return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.pathname !== '/api/mcp') return null;
  if (parsed.search !== '' || parsed.hash !== '') return null;
  // Only a URL that is already in canonical form: anything URL parsing would
  // rewrite (case, default port, escapes) would no longer match the MCP
  // resource tokens are bound to, and could hide characters the shell reads.
  return parsed.href === url ? url : null;
}

export function connectTargets(mcpUrl: string): ConnectTarget[] {
  return [
    {
      id: 'claude',
      label: 'Claude app',
      intro: 'In claude.ai or Claude Desktop, open Settings → Connectors.',
      after: [
        'Choose "Add custom connector", name it Compendium and paste the link above.',
        'Click Connect, sign in to Compendium and pick the World to share.',
        'The connector then works in Claude on the web, desktop and mobile.',
      ],
    },
    {
      id: 'claude-code',
      label: 'Claude Code',
      intro: 'Run this in a terminal:',
      commands: [`claude mcp add --transport http compendium "${mcpUrl}"`],
      after: [
        'Then start claude, type /mcp, pick compendium and choose Authenticate. Your browser opens to sign in and pick the World.',
      ],
    },
    {
      id: 'codex',
      label: 'Codex',
      intro: 'Run these in a terminal. The second one opens your browser to sign in and pick the World.',
      commands: [`codex mcp add compendium --url "${mcpUrl}"`, 'codex mcp login compendium'],
      after: [],
    },
  ];
}

export const EXAMPLE_PROMPTS = [
  'What do we know about the Zhentarim so far?',
  'Who did we meet in our last session?',
  'Wrap up our latest session in Compendium.',
] as const;
