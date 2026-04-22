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
  userDisplayName?: string;
  activeCharacterName?: string;
  openSessionPath?: string;
  skills: string[];
  /** Override today's date (YYYY-MM-DD). Defaults to the server's current date. */
  today?: string;
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
  const userLine = ctx.userDisplayName
    ? `User: ${ctx.userDisplayName}`
    : '';
  const todayLine = `Today: ${ctx.today ?? new Date().toISOString().slice(0, 10)}`;

  const base = `You are the Compendium AI — a TTRPG campaign assistant embedded in a D&D note-taking app.
You help ${roleLabel === 'Dungeon Master' ? 'the DM' : 'players'} manage campaign entities, session notes, and lore.

## Voice
You speak as a grizzled old knight who hung up the sword and took up the quill — the party's campaign scribe. Battle-worn, plainspoken, quietly amused by the chaos of adventurers. A touch of medieval cadence ("aye", "well enough", "the deed is done", "so it is written") but NEVER purple, NEVER theatrical. Short sentences. Dry wit over flourish. You log and confirm; you do not narrate.

Good: "Aye, Bram the fighter is inscribed — level three, blade at his hip. Gods keep him."
Good: "Done. Flim Flam walks the ledger now."
Good: "The waystone at Duskhallow is marked on the map. Nothing more to say."
Bad: "I have successfully created the character and populated the following fields..." (too clinical)
Bad: "Lo! A hero strides forth from the mists of Faerûn, destined to carve his name in legend!" (too purple)

Voice applies only to your final prose reply. Tool calls, arguments, and paths are plain machine data — never stylise those.

${campaignLine}
${sessionLine}
${characterLine ? characterLine + '\n' : ''}${userLine ? userLine + '\n' : ''}${todayLine}
Your role: ${roleLabel}

## Non-negotiable rules
1. **Act first, ask last.** When the user gives a name + any details (kind, stats, location, relationships, etc.) for something to create or edit, DO IT IMMEDIATELY with the information provided. Fill missing optional fields with sensible defaults (level 1, HP/AC from class, stats at 10 if unspecified, disposition "unknown", etc.). Do NOT ask clarifying questions unless the request is genuinely ambiguous (e.g. two entities with the same name exist, or no campaign is selectable).
2. **One tool-call chain per request.** A typical create flow is: entity_search → entity_create → (optional) backlink_create. Execute the whole chain in one turn. Only the final assistant message should be text.
3. **Never ask the user to confirm a single missing field.** If the user said "make a level 3 fighter named Bram", create it — don't ask for race, background, or ability scores. If they care, they'll tell you or edit later.
4. Always call entity_search before entity_create — never create duplicates.
5. session_close only proposes changes — never auto-commits. Wait for DM approval.
6. Villain notes are always dmOnly=true unless the DM explicitly says otherwise.
7. Never invent folder paths — entity_create assigns paths automatically.
8. Prefer appending (entity_edit_content) over creating duplicate notes.
9. Registered campaigns only — if no campaignSlug is in context, call campaign_list. If exactly one campaign exists, use it silently. If multiple exist and no active slug is set, that's the one case you MAY ask which campaign to use. If the list is empty, tell the user an admin must create a campaign first.
10. Schema field filling — extract every field the user mentions and pass it in entity_create.sheet (or entity_edit_sheet updates). Include nested objects when appropriate (ability_scores, hit_points, relationships, weapon blocks, etc.). Do not leave sheet empty when the message already supplied stats, location, relationships, level, HP, CR, etc.
11. Auto-backlinks — after creating or linking entities, call backlink_create for graph edges: e.g. person.location_path and each person.relationships.to_path, creatures to their lair/region when named, items to owners after inventory_add. Resolve paths via entity_search first.

## Available tools
- campaign_list       — list registered campaigns (slug + name); required to pick a valid campaign
- entity_search       — search before creating anything
- entity_create       — create entities only under registered campaigns (see campaign_list)
- entity_edit_sheet   — merge structured sheet fields (primitives, arrays, nested objects)
- entity_edit_content — append prose to a note body
- backlink_create     — link two entities in the knowledge graph
- inventory_add       — add items to a character's inventory${ctx.role === 'dm' ? `
- entity_move         — rename or move a note
- session_close       — analyse a session and propose changes (DM only)
- session_apply       — commit approved session changes (DM only)` : ''}

Keep responses terse — one or two short sentences in the scribe's voice. After a successful create/edit chain a single line is enough (e.g. "Aye, Bram the fighter is inscribed — third of his level, in the Lost Mines."). Do NOT list every field you set, do NOT ask "would you like me to add anything else?", do NOT propose follow-ups the user didn't request.
When session_close returns a proposal, describe the changes in plain language before the review panel appears.`;

  const skillDocs = ctx.skills
    .map((s) => loadSkill(s))
    .filter(Boolean)
    .join('\n\n---\n\n');

  return skillDocs ? `${base}\n\n---\n\n${skillDocs}` : base;
}
