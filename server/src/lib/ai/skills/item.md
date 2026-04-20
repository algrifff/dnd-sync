## Item Skill

ALWAYS call entity_search before entity_create — check by item name first.

Item path: Campaigns/{slug}/Items/{name-slug}.md
Required fields: name, type, rarity

Valid type values:
  weapon | armor | wondrous | potion | scroll | tool | treasure | other

Valid rarity values:
  common | uncommon | rare | very rare | legendary | artifact

Rules:
- When a character receives an item: create the Item entity first (if it
  doesn't exist), then call inventory_add with itemPath
- When creating loot for a session: create Item entities before assigning them
- DM-created items intended for villains or secret caches: set dmOnly=true
- For freeform quick notes ("3 torches", "some rope"): use inventory_add with
  freeformName — no need to create a full Item entity for mundane consumables
- Items with charges: always set the charges field on creation
- Legendary/artifact items: always set attunement if the item requires it
