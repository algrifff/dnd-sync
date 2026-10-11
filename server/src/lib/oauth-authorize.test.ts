import { describe, expect, it } from 'bun:test';
import { isKnownClaudeRedirect } from './oauth-authorize';

describe('isKnownClaudeRedirect', () => {
  it('recognises the hosted Claude callback', () => {
    expect(isKnownClaudeRedirect('https://claude.ai/api/mcp/auth_callback')).toBe(true);
  });

  it('refuses a look-alike host, a different path, a different scheme or an extra query', () => {
    for (const uri of [
      'https://claude.ai.evil.test/api/mcp/auth_callback',
      'https://evil.test/claude.ai/api/mcp/auth_callback',
      'https://claude.ai/api/mcp/auth_callback/x',
      'https://claude.ai/api/mcp/auth_callback?next=https://evil.test',
      'http://claude.ai/api/mcp/auth_callback',
      'https://claude.ai:8443/api/mcp/auth_callback',
      'https://user@claude.ai/api/mcp/auth_callback',
    ]) {
      expect(isKnownClaudeRedirect(uri)).toBe(false);
    }
  });
});
