## Item Skill

ALWAYS call `entity_search` before `entity_create` — check by item name first.

Path (assigned by server): `Campaigns/{slug}/Loot/{name-slug}.md` when a campaign slug is present; otherwise top-level `Loot/` (avoid creating without a campaign if the user is in a multi-campaign world — **ask for the campaign** if context has no slug).

### Sheet (`ItemSheet` — fill from chat)

- Identity: `name`, `category`, `rarity`, `weight` (number), `description`, `portrait`, `tags: []`
- **category** (not `type`): `weapon` \| `armor` \| `shield` \| `equipment` \| `tool` \| `consumable` \| `potion` \| `scroll` \| `wondrous` \| `treasure` \| `ammunition` \| `other`
- **rarity**: `common` \| `uncommon` \| `rare` \| `very rare` \| `legendary` \| `artifact`
- Economy: `cost: { amount, unit }` where `unit` is `cp` \| `sp` \| `ep` \| `gp` \| `pp`
- Attunement: `requires_attunement`, `attunement_requirements` (string)
- Charges: `charges: { max, current, recharge? }` (e.g. recharge: `"dawn"`)
- Weapon block: `weapon: { category: "simple"|"martial"|"improvised", damage: { dice: { count, sides, mod? }, type: <damage type> }, versatile_damage?: { dice }, range: { normal, long? }, properties: [] }` — properties must be from this exact list: `ammunition`, `finesse`, `heavy`, `light`, `loading`, `monk`, `reach`, `silvered`, `special`, `thrown`, `two-handed`, `versatile`. Unknown values are rejected.
- Armor block: `armor: { category: "light"|"medium"|"heavy"|"shield", ac_base, dex_cap?, stealth_disadvantage?, strength_requirement? }`
- Modifiers: `modifiers: [{ target, op: "+"|"-"|"="|"advantage"|"disadvantage", value?, when: "equipped"|"attuned"|"always", qualifier?, note? }]` — targets are constrained (e.g. `ac`, `hp_max`, `ability.str`, `skill.perception`) — see shared `ModifierTarget`
- `effects_notes` — freeform text for effects not captured in `modifiers`

Pass **every** inferable field in `entity_create.sheet`.

### Giving an item to a character

1. Ensure the item note exists (`entity_create` in **Loot** if needed).
2. `inventory_add` with `characterPath` + `itemPath` (or `freeformName` for mundane stacks like "torches").
3. `backlink_create` **from the item note → the character** (and/or character → item) so the graph shows ownership — use resolved full paths from `entity_search`.

### Rules

- DM-secret loot / villain-only gear: `dmOnly: true`
- Mundane consumables the player does not need as a full note: `inventory_add` with `freeformName` only
- Legendary / artifact items: set `requires_attunement` + `charges` when relevant

### Editing existing items

`entity_edit_sheet` merges shallowly at the top level — send the full nested object you want after merge for `weapon`, `armor`, `charges`, `cost`, `modifiers`.

```
entity_edit_sheet({ path, updates: {
  rarity: "rare",
  requires_attunement: true,
  attunement_requirements: "by a creature of good alignment",
  charges: { max: 3, current: 3, recharge: "dawn" },
  cost: { amount: 2500, unit: "gp" },
  modifiers: [
    { target: "ac", op: "+", value: 1, when: "equipped" },
    { target: "skill.stealth", op: "advantage", when: "attuned" },
  ],
  weapon: {
    category: "martial",
    damage: { dice: { count: 1, sides: 8, mod: 0 }, type: "slashing" },
    versatile_damage: { dice: { count: 1, sides: 10 } },
    range: { normal: 5 },
    properties: ["versatile"],
  },
  tags: ["cursed"],
} })
```

Modifier `target` values come from a fixed list — common ones: `ac`, `hp_max`, `speed.walk`, `initiative`, `ability.str` … `ability.cha`, `save.str` … `save.cha`, `skill.acrobatics` … `skill.survival`, `attack_bonus`, `damage_bonus`, `spell_attack_bonus`, `spell_save_dc`, `damage_resist`, `damage_immune`, `damage_vuln`. Unknown targets are rejected.
