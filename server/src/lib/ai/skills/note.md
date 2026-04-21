## General Note Skill

Use when no other entity skill fits (no structured kind detected).

### Path rules

- **Campaign selected:** `Campaigns/{slug}/{name-slug}.md` (via `kind: note` + `campaignSlug`).
- **No campaign:** `World Lore/{name-slug}.md` — same root as lore pages, but `note` is for miscellaneous campaign-adjacent or player scratch content when no slug is active.
- **Never** create loose files at the vault root.

### Rules

- Meaningful title — never `Untitled` / `New Note`.
- Use `[[EntityName]]` in the body when referencing other notes — combine with `backlink_create` when you know exact paths from `entity_search`.
- Prefer `entity_edit_content` on an existing hit over a near-duplicate filename.
- Plain freeform notes: omit `kind` in frontmatter when the app expects an untyped note; use `kind: note` only when the create API expects it (tooling uses `entity_create` with `kind: note`).
