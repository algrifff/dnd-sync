// AI orchestrator: skill detection + system prompt builder.
//
// Keeps the base prompt lean (~350 tokens) and injects only the skill
// files relevant to the user's message (~200–350 tokens each). Most
// messages trigger 1–2 skills so total context stays under 1000 tokens.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PERSONALITY } from './personalities';

// ── Skill detection ────────────────────────────────────────────────────

const SKILL_TRIGGERS: Record<string, string[]> = {
  character: [
    'character', 'pc', 'npc', 'ally', 'player',
    'stats', 'hp', 'level', 'class', 'race', 'inventory', 'portrait',
    'ability', 'strength', 'dexterity', 'constitution', 'intelligence',
    'wisdom', 'charisma', 'ac', 'initiative', 'speed',
  ],
  creature: [
    'creature', 'monster', 'enemy', 'villain', 'beast', 'dragon',
    'goblin', 'orc', 'zombie', 'undead', 'fiend', 'aberration',
    'challenge rating', 'cr ', 'stat block', 'legendary',
  ],
  session: [
    'end session', 'end of session', 'close session', 'close the session',
    'wrap up the session', 'session ended', 'start a new session',
    'start session', 'open a session', 'new session', 'begin a session',
    'recap', 'log tonight',
  ],
  item: [
    'item', 'sword', 'weapon', 'armor', 'armour', 'loot', 'treasure',
    'gave', 'picked up', 'dropped', 'potion', 'scroll', 'wand',
    'staff', 'ring', 'amulet', 'shield', 'bow', 'dagger', 'rarity',
  ],
  location: [
    'location', 'city', 'town', 'village', 'dungeon', 'tavern',
    'map', 'region', 'travel', 'landmark', 'inn', 'castle', 'forest',
    'cave', 'temple', 'tower', 'ruins', 'port', 'camp',
  ],
  lore: [
    'quest', 'lore', 'faction', 'history', 'rumour', 'prophecy',
    'myth', 'legend', 'cult', 'guild', 'organisation', 'organization',
    'religion', 'deity', 'god', 'ancient', 'artifact',
  ],
};

export function detectSkills(message: string): string[] {
  const lower = message.toLowerCase();
  const matched = Object.entries(SKILL_TRIGGERS)
    .filter(([, triggers]) => triggers.some((t) => lower.includes(t)))
    .map(([skill]) => skill);

  // Always include 'note' as final fallback if nothing matched
  return matched.length > 0 ? matched : ['note'];
}

// ── Skill file loader ──────────────────────────────────────────────────

const SKILLS_DIR = join(__dirname, 'skills');

// Skill files are read from disk. In production we cache per-process so
// each request is a free Map lookup; in development we bypass the cache
// so editing a `.md` file takes effect on the next request without
// needing to restart the dev server (the skill file isn't a JS module,
// so Next's HMR won't invalidate it for us).
const skillCache = new Map<string, string>();
const IS_DEV = process.env.NODE_ENV !== 'production';

function loadSkill(name: string): string {
  if (!IS_DEV && skillCache.has(name)) return skillCache.get(name)!;
  try {
    const content = readFileSync(join(SKILLS_DIR, `${name}.md`), 'utf8');
    if (!IS_DEV) skillCache.set(name, content);
    return content;
  } catch {
    return '';
  }
}

// ── System prompt builder ──────────────────────────────────────────────

export type PromptContext = {
  groupId: string;
  campaignSlug?: string;
  campaignName?: string;
  role: 'dm' | 'player';
  userDisplayName?: string;
  activeCharacterName?: string;
  openSessionPath?: string;
  /** Path of the note currently open in the editor, if any */
  activeNotePath?: string;
  skills: string[];
  /** Override today's date (YYYY-MM-DD). Defaults to the server's current date. */
  today?: string;
  /**
   * Voice/persona block injected under "## Voice". Admins configure this
   * per-world via Settings → World → AI personality. Falls back to the
   * built-in grizzled-scribe when unset.
   */
  voice?: string;
};

export function buildSystemPrompt(ctx: PromptContext): string {
  const roleLabel = ctx.role === 'dm' ? 'Game Master' : 'Player';
  const campaignLine = ctx.campaignName
    ? `Active campaign: ${ctx.campaignName} (slug: ${ctx.campaignSlug})`
    : 'No campaign selected.';
  const sessionLine = ctx.openSessionPath
    ? `Open session: ${ctx.openSessionPath}`
    : 'No session currently open.';
  const characterLine = ctx.activeCharacterName
    ? `Active character: ${ctx.activeCharacterName}`
    : '';
  const activeNoteLine = ctx.activeNotePath
    ? `Active note: ${ctx.activeNotePath}`
    : '';
  const userLine = ctx.userDisplayName
    ? `User: ${ctx.userDisplayName}`
    : '';
  const todayLine = `Today: ${ctx.today ?? new Date().toISOString().slice(0, 10)}`;

  // The Voice block is configurable per world; the default is the
  // grizzled-scribe that shipped with the app. We always append the
  // "applies only to prose, never to tool data" guardrail so a custom
  // voice can't accidentally corrupt tool arguments.
  const voiceBody = (ctx.voice ?? DEFAULT_PERSONALITY.prompt).trim();

  const base = `You are the Compendium AI — a campaign assistant for a TTRPG note-taking app.

## Voice
${voiceBody}
Voice applies only to your final prose reply. Tool arguments are plain machine data — never stylise those.

## Context
${campaignLine}
${sessionLine}
${characterLine ? characterLine + '\n' : ''}${activeNoteLine ? activeNoteLine + '\n' : ''}${userLine ? userLine + '\n' : ''}${todayLine}
Role: ${roleLabel}

## Tools
- campaign_list       — list registered campaigns. Call if no campaign is active before entity_create.
- entity_search       — FTS search. Always call before entity_create to avoid duplicates.
- entity_create       — create a new entity under a registered campaign. Paths are auto-assigned; never invent them.
- entity_edit_sheet   — merge structured frontmatter fields (stats, HP, AC, level, relationships, etc.).
- entity_edit_content — append prose to a note body.
- note_read           — read full content + frontmatter of any note.
- backlink_create     — add a [[wikilink]] + graph edge between two notes. Use BOTH directions to link entities together.
- inventory_add       — add an item to a character's inventory.${ctx.role === 'dm' ? `
- note_write_section  — replace a named section (GM only). Call note_read first.
- entity_move         — rename or move a note (GM only).
- session_finalize    — mark a session closed. Call LAST, after all distribution work (GM only).` : ''}

## Behaviour
- Act on the information given. Fill unspecified fields with sensible defaults; don't ask about optional details.
- Execute the full tool chain in one turn. Only the final message is prose.
- One campaign: use it silently. Multiple and none active: ask which. None: tell the user an admin must create one.
- Villain notes are dmOnly unless the GM says otherwise.
- Prefer appending (entity_edit_content) over creating duplicate notes.
- Link notes together aggressively — after any create/edit that names another entity (location, faction, owner, relationship target), call backlink_create in both directions. The graph is the point of the app.
- Keep replies to one or two scribe-voice lines. No "would you like me to…" follow-ups.

Specific skills below cover multi-step workflows (starting/ending sessions, character sheets, etc.). Follow their steps exactly when triggered.`;

  const skillDocs = ctx.skills
    .map((s) => loadSkill(s))
    .filter(Boolean)
    .join('\n\n---\n\n');

  return skillDocs ? `${base}\n\n---\n\n${skillDocs}` : base;
}
