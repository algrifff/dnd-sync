## Creature / Monster / Villain (stat block) Skill

Paths are assigned by the server from `kind` + `campaignSlug` — never invent a full path.

ALWAYS call `entity_search` before `entity_create`.

### Campaign context

Call **`campaign_list`** when needed, then pass a **registered** `campaignSlug` (or the app’s active campaign). Unknown slugs are rejected — you cannot create a new campaign via chat.

### Canonical folders

| Kind | Folder |
|------|--------|
| `creature` / `monster` | `Campaigns/{slug}/Creatures/{name-slug}.md` |
| `villain` | `Campaigns/{slug}/Enemies/{name-slug}.md` |

**Villains:** always `dmOnly: true` unless the DM explicitly says otherwise.

The frontmatter kind for `villain` / `monster` tool inputs is normalised to **`creature`** for templates/validation — folder still comes from the original kind (`villain` → Enemies, `creature` → Creatures).

---

### Sheet (`CreatureSheet` — fill from chat)

- Identity: `name`, `size`: `tiny` \| `small` \| `medium` \| `large` \| `huge` \| `gargantuan`, `type` (monster type): `aberration` \| `beast` \| `celestial` \| `construct` \| `dragon` \| `elemental` \| `fey` \| `fiend` \| `giant` \| `humanoid` \| `monstrosity` \| `ooze` \| `plant` \| `undead` \| `swarm`, `subtype`, `alignment`, `portrait`, `tags: []`
- Compendium: `source_ref: { name, compendium_id? }` if copied from a reference stat block
- Abilities: `ability_scores: { str, dex, con, int, wis, cha }`
- Combat: `hit_points: { max, current, temporary?, formula? }`, `armor_class: { value, description? }`, `speed: { walk: 30, fly?, swim?, burrow?, climb?, hover? }` (scalar speed integers coerce to `{ walk: n }`)
- CR / prof: `challenge_rating`, `proficiency_bonus`
- Saves / skills: `saving_throws: { str: { modifier: 2 }, ... }`, `skills: { perception: { modifier: 4 }, ... }`
- Senses / languages: `senses: { darkvision?, blindsight?, passive_perception?, ... }`, `languages: []`
- Defences: `conditions`, `condition_immunities`, `damage_resistances`, `damage_immunities`, `damage_vulnerabilities` — arrays of condition / damage type strings
- Features: `traits: [{ name, description }]`, `actions: [{ name, description, attack_bonus?, damage_dice?: { count, sides, mod? }, damage_type?, kind? }]`, `legendary_actions: [{ name, description, ... }]`
- Notes: `player_notes` — short observed party knowledge; long prose goes in the note body via `entity_edit_content`

Pass **every** inferable field in `entity_create.sheet`.

---

### After create — graph

If the user tied the creature to a **lair** or **region**, resolve paths with `entity_search`, then `backlink_create` from the creature note to that location (and optionally mention in `player_notes`).

---

### Editing existing creatures

Use `entity_edit_sheet`. Flat legacy keys work — the server coerces them to the nested Zod shape automatically.

**Flat (easiest):**
```
entity_edit_sheet({ path, updates: {
  str: 18, dex: 12, con: 16, int: 3, wis: 10, cha: 6,   // → ability_scores
  hp_max: 45, hp_current: 32,                            // → hit_points
  ac: 14,                                                // → armor_class.value
  speed: 40,                                             // → { walk: 40 }
} })
```

**Nested (also accepted):**
```
entity_edit_sheet({ path, updates: {
  ability_scores: { str: 18, dex: 12, con: 16, int: 3, wis: 10, cha: 6 },
  hit_points: { max: 45, current: 32, temporary: 0 },
  armor_class: { value: 14, description: "natural armor" },
  speed: { walk: 40, fly: 80 },
  challenge_rating: 5,
  conditions: ["prone", "poisoned"],
} })
```

**Creature-specific nested fields — send nested (no flat form):**
- `saving_throws: { str: { modifier: 2 }, con: { modifier: 5 } }` — ability keys are `str|dex|con|int|wis|cha`
- `skills: { perception: { modifier: 4 }, stealth: { modifier: 6 } }` — use snake_case skill keys
- `traits: [{ name, description }]`
- `actions: [{ name, description, attack_bonus?, damage_dice?: { count, sides, mod? }, damage_type? }]`
- `legendary_actions: [{ name, description, ... }]`
- `conditions` / `condition_immunities` — arrays of condition strings (`blinded|charmed|…|unconscious`)
- `damage_resistances` / `damage_immunities` / `damage_vulnerabilities` — arrays of damage type strings (`piercing|slashing|bludgeoning|acid|cold|fire|force|lightning|necrotic|poison|psychic|radiant|thunder`)
- `senses: { darkvision?, blindsight?, tremorsense?, truesight?, passive_perception? }`

Merging is shallow at the top level of `sheet` — nested objects are replaced wholesale, so send the **full** object you want after merge.
