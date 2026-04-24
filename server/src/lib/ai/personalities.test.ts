import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { setupTestDb, teardownTestDb } from '../test-utils';
import {
  DEFAULT_PERSONALITY,
  MAX_PERSONALITY_NAME_LEN,
  MAX_PERSONALITY_PROMPT_LEN,
  createPersonality,
  deletePersonality,
  getActivePersonality,
  getPersonality,
  listPersonalities,
  setActivePersonality,
  updatePersonality,
} from './personalities';
import { buildSystemPrompt } from './orchestrator';

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

// Fresh world + user for each test so the group_id / actor_id FKs are
// always valid without cross-test pollution.
let groupId: string;
let userId: string;

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM ai_personalities');
  db.exec('DELETE FROM group_members');
  db.exec(`DELETE FROM groups WHERE id != 'default'`);
  db.exec('DELETE FROM users');

  groupId = `g_${randomUUID()}`;
  userId = `u_${randomUUID()}`;
  db.query('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(
    groupId,
    'Test World',
    Date.now(),
  );
  db.query(
    `INSERT INTO users (id, username, password_hash, display_name, accent_color, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(userId, `user_${userId.slice(-6)}`, 'x', 'Tester', '#000000', Date.now());
});

// ── defaults ───────────────────────────────────────────────────────────

describe('getActivePersonality', () => {
  it('returns the built-in scribe when no row is active', () => {
    const active = getActivePersonality(groupId);
    expect(active.id).toBe(DEFAULT_PERSONALITY.id);
    expect(active.isBuiltin).toBe(true);
    expect(active.prompt).toContain('Pope Huel');
  });

  it('returns the stored row when one is active', () => {
    const p = createPersonality({
      groupId,
      name: 'Bard',
      prompt: 'Speak as a cheerful tavern bard.',
      createdBy: userId,
    });
    expect(setActivePersonality(groupId, p.id)).toBe(true);

    const active = getActivePersonality(groupId);
    expect(active.id).toBe(p.id);
    expect(active.name).toBe('Bard');
    expect(active.isBuiltin).toBe(false);
  });

  it('silently falls back to default if the active row vanishes', () => {
    const p = createPersonality({
      groupId,
      name: 'Ghost',
      prompt: 'vanishing voice',
      createdBy: userId,
    });
    setActivePersonality(groupId, p.id);
    // Bypass deletePersonality so the active pointer is stale.
    getDb().query('DELETE FROM ai_personalities WHERE id = ?').run(p.id);

    const active = getActivePersonality(groupId);
    expect(active.id).toBe(DEFAULT_PERSONALITY.id);

    // And the stale pointer should be cleared on that read.
    const row = getDb()
      .query<{ active_personality_id: string | null }, [string]>(
        'SELECT active_personality_id FROM groups WHERE id = ?',
      )
      .get(groupId);
    expect(row?.active_personality_id).toBeNull();
  });
});

// ── CRUD ───────────────────────────────────────────────────────────────

describe('createPersonality', () => {
  it('validates name + prompt length', () => {
    expect(() =>
      createPersonality({ groupId, name: '', prompt: 'x', createdBy: userId }),
    ).toThrow(/name is required/);

    expect(() =>
      createPersonality({ groupId, name: 'x', prompt: '   ', createdBy: userId }),
    ).toThrow(/prompt is required/);

    expect(() =>
      createPersonality({
        groupId,
        name: 'a'.repeat(MAX_PERSONALITY_NAME_LEN + 1),
        prompt: 'ok',
        createdBy: userId,
      }),
    ).toThrow(/name too long/);

    expect(() =>
      createPersonality({
        groupId,
        name: 'ok',
        prompt: 'a'.repeat(MAX_PERSONALITY_PROMPT_LEN + 1),
        createdBy: userId,
      }),
    ).toThrow(/prompt too long/);
  });

  it('persists a valid personality and lists it', () => {
    const p = createPersonality({
      groupId,
      name: ' Bard ',
      prompt: ' Speak warmly. ',
      createdBy: userId,
    });
    expect(p.name).toBe('Bard');
    expect(p.prompt).toBe('Speak warmly.');
    expect(listPersonalities(groupId)).toHaveLength(1);

    const fetched = getPersonality(groupId, p.id);
    expect(fetched?.id).toBe(p.id);
  });
});

describe('updatePersonality', () => {
  it('returns null for a missing row without side effects', () => {
    const result = updatePersonality({
      groupId,
      id: 'does-not-exist',
      name: 'x',
    });
    expect(result).toBeNull();
  });

  it('partial updates only change the provided fields', () => {
    const p = createPersonality({
      groupId,
      name: 'Bard',
      prompt: 'original',
      createdBy: userId,
    });
    const renamed = updatePersonality({ groupId, id: p.id, name: 'Skald' });
    expect(renamed?.name).toBe('Skald');
    expect(renamed?.prompt).toBe('original');

    const reworded = updatePersonality({
      groupId,
      id: p.id,
      prompt: 'new voice',
    });
    expect(reworded?.name).toBe('Skald');
    expect(reworded?.prompt).toBe('new voice');
  });
});

describe('deletePersonality', () => {
  it('removes the row and clears the active pointer if it matched', () => {
    const p = createPersonality({
      groupId,
      name: 'Bard',
      prompt: 'warm',
      createdBy: userId,
    });
    setActivePersonality(groupId, p.id);
    expect(deletePersonality(groupId, p.id)).toBe(true);
    expect(listPersonalities(groupId)).toHaveLength(0);

    // Active pointer must fall back to default on read.
    expect(getActivePersonality(groupId).id).toBe(DEFAULT_PERSONALITY.id);
  });

  it('returns false when the row does not belong to this world', () => {
    expect(deletePersonality(groupId, 'no-such-id')).toBe(false);
  });
});

describe('setActivePersonality', () => {
  it('accepts the built-in sentinel as a reset', () => {
    const p = createPersonality({
      groupId,
      name: 'Bard',
      prompt: 'warm',
      createdBy: userId,
    });
    setActivePersonality(groupId, p.id);
    expect(setActivePersonality(groupId, DEFAULT_PERSONALITY.id)).toBe(true);
    expect(getActivePersonality(groupId).isBuiltin).toBe(true);
  });

  it('refuses an id from a different world', () => {
    const otherGroup = `g_${randomUUID()}`;
    getDb()
      .query('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)')
      .run(otherGroup, 'Other', Date.now());
    const p = createPersonality({
      groupId: otherGroup,
      name: 'Other',
      prompt: 'alien voice',
      createdBy: userId,
    });
    expect(setActivePersonality(groupId, p.id)).toBe(false);
    expect(getActivePersonality(groupId).isBuiltin).toBe(true);
  });
});

// ── orchestrator integration ───────────────────────────────────────────

describe('buildSystemPrompt voice injection', () => {
  it('uses the default scribe voice when no voice is supplied', () => {
    const prompt = buildSystemPrompt({
      groupId,
      role: 'dm',
      skills: [],
    });
    expect(prompt).toContain('Pope Huel');
    expect(prompt).toContain('Voice applies only to your final prose reply');
  });

  it('swaps in the provided voice verbatim', () => {
    const voice = 'Speak as a cheerful tavern bard with gusto.';
    const prompt = buildSystemPrompt({
      groupId,
      role: 'dm',
      skills: [],
      voice,
    });
    expect(prompt).toContain(voice);
    expect(prompt).not.toContain('Pope Huel');
    // The guardrail is always appended, no matter the voice.
    expect(prompt).toContain('Voice applies only to your final prose reply');
  });
});
