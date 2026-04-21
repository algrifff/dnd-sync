## Location Skill

ALWAYS call `entity_search` before `entity_create` — check by location name first.

Path (assigned by server): `Campaigns/{slug}/Places/{name-slug}.md` when a campaign slug is present; otherwise `Places/` at vault root. **Ask for the campaign** if the user expects a campaign tree but no slug is in context.

### Sheet (`LocationSheet` — fill from chat)

- `name`, **type**: `plane` \| `continent` \| `region` \| `city` \| `town` \| `village` \| `dungeon` \| `wilderness` \| `landmark` \| `building` \| `room` \| `other`
- Geography: `region` (string label), `terrain: []` (strings), `population`, `government`, `portrait`, `tags: []`
- Hierarchy: `parent_path` — full path to parent location note (e.g. tavern inside a city). No separate `Lore/Locations/` root — world-level places still use `Places/` when there is no campaign.
- People ties: `notable_residents: [{ to_path: "Campaigns/.../People/bill", role?: "innkeeper" }]` — use paths returned from `entity_search`

Pass **every** inferable field in `entity_create.sheet`.

### After create — graph & consistency

1. For each **notable_resident** you care about: `backlink_create` from this location → that person's path.
2. Optionally `entity_edit_sheet` each person with `location_path` set to this location's path so the sheet matches the graph.
3. **Sub-locations:** create the child place with `parent_path` pointing at the parent note, then `backlink_create` child → parent.

### When the party moves

Update a character / person with `entity_edit_sheet` — location-related fields on sheets — and/or append travel prose with `entity_edit_content`.

### Editing existing locations

Merging is shallow at the top level of `sheet` — arrays (`terrain`, `tags`, `notable_residents`) are replaced wholesale, so pass the **full** intended list.

```
entity_edit_sheet({ path, updates: {
  type: "city",
  region: "Sword Coast",
  population: "≈130,000",
  government: "Open Lord: Laeral Silverhand",
  terrain: ["coastal", "urban"],
  tags: ["port", "hub"],
  parent_path: "Campaigns/lost-mines/Places/faerun.md",
  notable_residents: [
    { to_path: "Campaigns/lost-mines/People/volothamp.md", role: "chronicler" },
    { to_path: "Campaigns/lost-mines/People/durnan.md",    role: "innkeeper" },
  ],
} })
```

To delete a field, set it to `null` in updates. To remove a single resident, resend `notable_residents` without that entry.

### Maps / images

Reference assets in the **note body** (TipTap), not as magic sheet fields.
