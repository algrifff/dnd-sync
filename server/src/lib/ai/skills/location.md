## Location Skill

ALWAYS call entity_search before entity_create — check by location name first.

Location path: Campaigns/{slug}/Locations/{name-slug}.md
Required fields: name, type

Valid type values:
  city | town | village | dungeon | wilderness | landmark | plane | other

Rules:
- After creating a location, search for NPCs whose sheet.location field
  matches this location's name — call backlink_create to connect them
- When a character moves to a location: call entity_edit_sheet on the
  character with { location: "LocationName" } — use plain name not wikilink
- Sub-locations (a tavern inside a city): create as a separate Location entity
  and call backlink_create to link child → parent
- World-level locations not tied to a campaign: use Lore/Locations/ path
  (pass no campaignSlug to entity_create)
- Maps and images: reference via asset embed in the location note body,
  not via sheet fields
