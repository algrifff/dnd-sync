## Lore Skill

### Paths

- **`kind: lore`** always resolves to **`World Lore/{name-slug}.md`** — there is no campaign-prefixed variant for lore kind.
- For **campaign-specific** freeform pages (quests, rumours tied to one table), use **`kind: note`** with `campaignSlug` so the file lands under `Campaigns/{slug}/`.

No required sheet fields — lore is mostly prose. Add `tags` in frontmatter if the template supports them, or tag inside the body.

Suggested body / tag hints: `#quest` `#faction` `#history` `#prophecy` `#myth` `#rumour`

### Rules

- Call `backlink_create` to connect lore to characters, locations, items, factions — **lore without links is an island** in the graph.
- Quests: reference involved characters with `[[Name]]` in the body **and** add `backlink_create` where you know the target path from search.
- Factions: search for member NPCs, then link faction ↔ NPC.
- When a quest completes: `entity_edit_content` to append a resolution section — do not wipe the original text.
- History / chronicle style: prefer appending dated entries with `entity_edit_content` over spawning duplicate notes.
