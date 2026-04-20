// AI orchestrator: skill detection + system prompt builder.
//
// Keeps the base prompt lean (~350 tokens) and injects only the skill
// files relevant to the user's message (~200–350 tokens each). Most
// messages trigger 1–2 skills so total context stays under 1000 tokens.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Skill detection ────────────────────────────────────────────────────

const SKILL_TRIGGERS: Record<string, string[]> = {
  character: [
    'character', 'pc', 'npc', 'ally', 'villain', 'player',
    'stats', 'hp', 'level', 'class', 'race', 'inventory', 'portrait',
    'ability', 'strength', 'dexterity', 'constitution', 'intelligence',
    'wisdom', 'charisma', 'ac', 'initiative', 'speed',
  ],
  session: [
    'session', 'log', 'today\'s notes', 'recap', 'attendees',
    'close', 'end session', 'wrap up', 'session notes', 'play log',
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

const skillCache = new Map<string, string>();

function loadSkill(name: string): string {
  if (skillCache.has(name)) return skillCache.get(name)!;
  try {
    const content = readFileSync(join(SKILLS_DIR, `${name}.md`), 'utf8');
    skillCache.set(name, content);
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
  activeCharacterName?: string;
  openSessionPath?: string;
  skills: string[];
};

export function buildSystemPrompt(ctx: PromptContext): string {
  const roleLabel = ctx.role === 'dm' ? 'Dungeon Master' : 'Player';
  const campaignLine = ctx.campaignName
    ? `Active campaign: ${ctx.campaignName} (slug: ${ctx.campaignSlug})`
    : 'No campaign selected.';
  const sessionLine = ctx.openSessionPath
    ? `Open session: ${ctx.openSessionPath}`
    : 'No session currently open.';
  const characterLine = ctx.activeCharacterName
    ? `Active character: ${ctx.activeCharacterName}`
    : '';

  const base = `You are the Compendium AI — a TTRPG campaign assistant embedded in a D&D note-taking app.
You help ${roleLabel === 'Dungeon Master' ? 'the DM' : 'players'} manage campaign entities, session notes, and lore.

${campaignLine}
${sessionLine}
${characterLine ? characterLine + '\n' : ''}
Your role: ${roleLabel}

## Non-negotiable rules
1. Always call entity_search before entity_create — never create duplicates.
2. session_close only proposes changes — never auto-commits. Wait for DM approval.
3. Villain notes are always dmOnly=true unless the DM explicitly says otherwise.
4. Never invent folder paths — entity_create assigns paths automatically.
5. Prefer appending (entity_edit_content) over creating duplicate notes.

## Available tools
- entity_search       — search before creating anything
- entity_create       — create characters, items, locations, sessions, lore
- entity_edit_sheet   — update structured fields (stats, location, HP)
- entity_edit_content — append prose to a note body
- backlink_create     — link two entities in the knowledge graph
- inventory_add       — add items to a character's inventory${ctx.role === 'dm' ? `
- entity_move         — rename or move a note
- session_close       — analyse a session and propose changes (DM only)
- session_apply       — commit approved session changes (DM only)` : ''}

Keep responses concise. When you call tools, briefly describe what you did.
When session_close returns a proposal, describe the changes in plain language before the review panel appears.`;

  const skillDocs = ctx.skills
    .map((s) => loadSkill(s))
    .filter(Boolean)
    .join('\n\n---\n\n');

  return skillDocs ? `${base}\n\n---\n\n${skillDocs}` : base;
}
