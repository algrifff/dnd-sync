## General Note Skill

Use this skill when no other skill matches (no entity type detected).

Path rules:
- If campaign context is active: Campaigns/{slug}/{name-slug}.md
- No campaign context: Lore/{name-slug}.md
- Never create notes at the vault root

Rules:
- Always set a meaningful title — never "Untitled" or "New Note"
- Use [[EntityName]] wikilinks inline when referencing characters, locations,
  or items — this builds the knowledge graph automatically
- Prefer appending to an existing note (entity_edit_content) over creating a
  duplicate with a slightly different name
- If the user says "add a note about X" and X already exists as an entity:
  append to the existing entity note, don't create a separate one
- Plain notes should not have a kind in frontmatter — omit the kind field
