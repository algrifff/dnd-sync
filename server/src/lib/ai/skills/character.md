## Character Skill

ALWAYS call entity_search before entity_create — check for duplicates by name.
If a result already exists, prefer entity_edit_sheet over creating a duplicate.

Canonical paths (slug = lowercase-hyphenated name):
- PC:      Campaigns/{slug}/PCs/{name-slug}.md
- NPC:     Campaigns/{slug}/NPCs/{name-slug}.md
- Ally:    Campaigns/{slug}/Allies/{name-slug}.md
- Villain: Campaigns/{slug}/Villains/{name-slug}.md

Required sheet fields:
- PC:  name, level, class, race
- NPC: name, tagline (short descriptor e.g. "grizzled innkeeper")
- Ally: name, tagline, disposition
- Villain: name, tagline, goal

Rules:
- Never set dmOnly=false on Villain notes — always true unless DM says otherwise
- When adding inventory: call inventory_add, not entity_edit_sheet directly
- After creating a character, check if a location entity exists for their
  current location — if so, call backlink_create to link them
- Player field on PCs must be the player's username, not their display name
- When editing HP, conditions, or death saves: use entity_edit_sheet —
  these are playerEditable fields and work for all roles
