import { describe, expect, test } from 'bun:test';
import { connectTargets } from './connect-claude';

const URL = 'https://compendium.example/api/mcp';

describe('connectTargets', () => {
  test('every terminal setup registers the exact MCP URL', () => {
    const targets = connectTargets(URL);
    const adders = targets.flatMap((t) => t.commands ?? []).filter((c) => c.includes(' add '));

    expect(adders).toEqual([
      `claude mcp add --transport http compendium ${URL}`,
      `codex mcp add compendium --url ${URL}`,
    ]);
  });

  test('Codex signs in after it is added', () => {
    const codex = connectTargets(URL).find((t) => t.id === 'codex');

    expect(codex?.commands).toEqual([
      `codex mcp add compendium --url ${URL}`,
      'codex mcp login compendium',
    ]);
  });
});
