## Lore Skill

Lore paths:
- World-level (any campaign): Lore/{name-slug}.md
- Campaign-specific: Campaigns/{slug}/{name-slug}.md

No required sheet fields — lore is freeform prose.

Suggested tags (add via entity_edit_sheet if the note supports tags, or
mention in the prose body):
  #quest  #faction  #history  #prophecy  #myth  #rumour

Rules:
- Always call backlink_create to connect lore entries to relevant characters
  and locations — lore without links is an island
- Quests should reference all involved characters via [[CharacterName]] in body
- When creating a faction: also search for existing NPCs who belong to it and
  call backlink_create linking them to the faction note
- When a quest is completed or failed: call entity_edit_content to append a
  resolution note — do not overwrite the original lore
- History entries: use entity_edit_content to append dated entries rather than
  creating new notes for every event
