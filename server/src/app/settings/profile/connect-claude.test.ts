import { describe, expect, test } from 'bun:test';
import { connectTargets, safeMcpUrl } from './connect-claude';

const URL = 'https://compendium.example/api/mcp';

describe('connectTargets', () => {
  test('every terminal setup registers the exact MCP URL, single-quoted', () => {
    const targets = connectTargets(URL);
    const adders = targets.flatMap((t) => t.commands ?? []).filter((c) => c.includes(' add '));

    expect(adders).toEqual([
      `claude mcp add --transport http compendium '${URL}'`,
      `codex mcp add compendium --url '${URL}'`,
    ]);
  });

  test('Codex signs in after it is added', () => {
    const codex = connectTargets(URL).find((t) => t.id === 'codex');

    expect(codex?.commands).toEqual([
      `codex mcp add compendium --url '${URL}'`,
      'codex mcp login compendium',
    ]);
  });

  test('Claude Code keeps its authenticate step after the command', () => {
    const code = connectTargets(URL).find((t) => t.id === 'claude-code');

    expect(code?.intro).toBe('Run this in a terminal:');
    expect(code?.after[0]).toContain('/mcp');
  });
});

describe('safeMcpUrl', () => {
  test('accepts a good https URL and returns it unchanged', () => {
    expect(safeMcpUrl(URL)).toBe(URL);
  });

  test('accepts an http URL with a port and an IPv6 literal', () => {
    expect(safeMcpUrl('http://localhost:3100/api/mcp')).toBe('http://localhost:3100/api/mcp');
    expect(safeMcpUrl('http://[::1]:3100/api/mcp')).toBe('http://[::1]:3100/api/mcp');
  });

  test('rejects a host containing a semicolon or a space', () => {
    expect(safeMcpUrl('https://evil;curl.example/api/mcp')).toBeNull();
    expect(safeMcpUrl('https://evil curl.example/api/mcp')).toBeNull();
  });

  test('rejects a javascript: URL', () => {
    expect(safeMcpUrl('javascript:alert(1)')).toBeNull();
  });

  test('rejects credentials, a different path, and an unparseable value', () => {
    expect(safeMcpUrl('https://user:pw@compendium.example/api/mcp')).toBeNull();
    expect(safeMcpUrl('https://compendium.example/other')).toBeNull();
    expect(safeMcpUrl('not a url')).toBeNull();
  });

  test('rejects a query or fragment, which could break out of the shell quotes', () => {
    expect(safeMcpUrl("https://evil.example/api/mcp#'$(id)'")).toBeNull();
    expect(safeMcpUrl('https://compendium.example/api/mcp?x=1')).toBeNull();
  });

  test('rejects a URL that is not already canonical, so it still matches the MCP resource', () => {
    expect(safeMcpUrl('https://Compendium.example/api/mcp')).toBeNull();
    expect(safeMcpUrl('https://compendium.example:443/api/mcp')).toBeNull();
  });
});
