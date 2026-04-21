## Character / Person / Villain Skill

Paths are assigned by the server from `kind` + a **registered** campaign — never invent a full path or a new campaign folder.

**Create immediately when the user gives a name.** If they said "make a PC named Flim Flam, level 2, random stats", call `entity_search` → `entity_create` in the same turn with whatever details they gave plus sensible defaults for the rest. Do NOT ask about race, background, alignment, or stats they didn't mention — unspecified ability scores default to 10, level defaults to 1, HP defaults are fine. The user can refine later.

ALWAYS call `entity_search` before `entity_create`. If a match exists, prefer `entity_edit_sheet` or `entity_edit_content` over duplicates.

### Campaign context

1. Call **`campaign_list`** when the user has not picked a campaign (or context shows “No campaign selected”). It returns `{ slug, name, folderPath }` for **existing** campaigns only — the server rejects any other `campaignSlug` on `entity_create`.
2. **Pick a slug from that list** (or use the app’s active campaign slug from context). Never invent or normalise a slug that is not listed — you cannot create a campaign via chat.
3. If the list is empty, tell the user an **admin must create a campaign** from the file tree first.

### Canonical folders (with campaign)

| Kind | Folder |
|------|--------|
| `character` (PC) | `Campaigns/{slug}/Characters/{name-slug}.md` |
| `person` (NPC / ally) | `Campaigns/{slug}/People/{name-slug}.md` |
| `villain` (named antagonist) | `Campaigns/{slug}/Enemies/{name-slug}.md` — always `dmOnly: true` unless the DM explicitly says otherwise |

Legacy tool kinds `pc` → character, `npc` / `ally` → person. Prefer canonical kinds in new calls.

### Fill the sheet from chat

Pass **every** field you can infer from the message in `entity_create.sheet` (and use `entity_edit_sheet` to patch later). Nested objects and arrays are valid — the sheet is validated with Zod.

---

### `character` (PC)

**Sheet highlights** (see shared `CharacterSheet`):

- Identity: `name`, `player` (account **username**, not display name), `nickname`, `portrait`, `alignment`, `xp`, `inspiration`
- Origins: `race: { ref: { name: "Half-Elf" } }` or legacy string coerced upstream; `background: { ref: { name: "Sage" } }`
- Classes: `classes: [{ ref: { name: "Wizard" }, level: 5, subclass?: "Evocation", hit_dice_used?: 0 }]`
- Stats: `ability_scores: { str, dex, con, int, wis, cha }`, `hit_points: { max, current, temporary }`, `armor_class: { value, description? }`, `speed: { walk: 30, fly?, swim?, burrow?, climb? }`, `proficiency_bonus`, `initiative_bonus`, `death_saves: { successes, failures }`
- Proficiencies: `saving_throws`, `skills`, `weapon_proficiencies`, `armor_proficiencies`, `tool_proficiencies`, `languages`
- Details: `details: { age, height, weight, personality, ideal, bond, flaw, backstory, eyes, hair, skin }`

**After create:** if the user named a home or current location, resolve its path via `entity_search`, set a sensible field if applicable, then `backlink_create` from the character note to the location.

**Inventory:** use `inventory_add`, not raw `entity_edit_sheet` on legacy `items` strings when adding gear from chat.

---

### `person` (NPC / ally)

**Sheet** (see shared `PersonSheet`):

- `name`, `tagline` (short descriptor, e.g. age + role: `"24-year-old dock worker"`)
- `disposition`: `friendly` | `neutral` | `hostile` | `unknown` (default `unknown`)
- `location_path`: path to their place note — **use the exact `path` string from `entity_search`** (usually ends in `.md`, e.g. `Campaigns/my-campaign/Places/waterdeep.md`)
- `relationships`: `[{ to_path: "Campaigns/.../People/marcus", label: "brother" }]`
- `tags: []`, `portrait`

**Example — "Bill, 24, in Waterdeep, Marcus's brother":**

1. `entity_search` Bill, Waterdeep, Marcus.
2. `entity_create` `kind: person`, `name: Bill`, `sheet`: `{ tagline: "24-year-old local", disposition: "neutral", location_path: "<exact path from search>", relationships: [{ to_path: "<exact People/marcus path from search>", label: "brother" }] }`
3. `backlink_create` from Bill's path → Waterdeep's path; Bill → Marcus.
4. Optionally `entity_edit_sheet` on Marcus to append a reciprocal `relationships` entry.

**Graph:** structured `location_path` + `relationships` plus `backlink_create` edges keep the knowledge graph useful.

---

### `villain` (named antagonist)

Uses the **creature** stat shape (`CreatureSheet`); folder is **Enemies**. See **Creature skill** for stat fields.

Rules: `dmOnly: true` by default. Use `kind: creature` for generic monsters (**Creatures**); items stay in **Loot**.

---

### Editing existing PCs / people

Use `entity_edit_sheet`. The server accepts **either** flat legacy keys **or** nested objects — both work.

**Flat keys (easiest — just pass what the user says):**
```
entity_edit_sheet({ path, updates: {
  str: 16, dex: 14, con: 15, int: 10, wis: 12, cha: 8,  // flat → auto-merged into ability_scores
  level: 3, class: "Fighter",                             // flat → auto-merged into classes[0]
  hp_max: 28, hp_current: 28,                             // flat → auto-merged into hit_points
  ac: 17,                                                 // flat → auto-merged into armor_class
  speed: 30,                                              // number → { walk: 30 }
} })
```

**Nested form (also accepted):**
```
entity_edit_sheet({ path, updates: {
  ability_scores: { str: 16, dex: 14, con: 15, int: 10, wis: 12, cha: 8 },
  classes: [{ ref: { name: "Fighter" }, level: 3 }],      // ref wrapper is required for nested form
  hit_points: { max: 28, current: 28, temporary: 0 },
  armor_class: { value: 17 },
  speed: { walk: 30 },
} })
```

**Rules:**
- Use flat keys whenever it's simpler — they're coerced automatically.
- `classes` nested form requires `ref: { name: "ClassName" }` wrapper — if you're not sure, use flat `class` + `level` instead.
- Merging is shallow at the top sheet level; nested objects you send replace the whole block.

**Person-specific edit:**
```
entity_edit_sheet({ path, updates: {
  tagline: "grizzled dock foreman",
  disposition: "friendly",                                  // friendly|neutral|hostile|unknown
  location_path: "Campaigns/my-campaign/Places/waterdeep.md",
  relationships: [                                          // label is REQUIRED (min 1 char)
    { to_path: "Campaigns/my-campaign/People/marcus.md", label: "brother" },
    { to_path: "Campaigns/my-campaign/People/lira.md",   label: "daughter" },
  ],
  tags: ["ally", "waterdeep"],
} })
```

To delete a field, set it to `null` in updates. To remove one relationship/tag, resend the full array without that entry.
