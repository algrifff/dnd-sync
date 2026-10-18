# Relationships are typed, authored facts in their own table, proposed through Wrap-up

A link says two Notes are connected. It does not say how. An agent crawling the World can see that Volo links to Xanathar, but not that Volo works for him or that they are enemies. We decided that how two Notes relate is recorded as a **Relationship**, and that it works as follows:

- A Relationship has one of a fixed list of types (below), a direction, and the Session that established it.
- It lives in its own table, `note_relations`, not in `note_links`.
- It is proposed by a Wrap-up and applied only after a Player reviews it, like every other change a Wrap-up makes.
- It is add-only. Nothing in the app rewrites or deletes a Relationship automatically.
- It is visible to a person only when both of its Notes are visible to them.

## Why a separate table

`note_links` is derived. Every save of a Note deletes that Note's body-derived rows and rebuilds them from its wikilinks (`collab/derive.ts`), and its primary key `(group_id, from_path, to_path)` allows exactly one edge per pair of Notes. A Relationship is an authored fact that appears nowhere in the body, so it would be wiped on the next save, and a pair of Notes can have more than one (ally and family, say). Typing the existing edges would mean rebuilding a table that the editor rewrites on every keystroke-driven save. A new table leaves that path alone.

Applying a Relationship also inserts the plain `is_manual` link between the two Notes, in the same transaction. The graph, backlinks and every existing reader then show the connection with no change. Removing a Relationship leaves the link, because links belong to the people who write them.

## The fixed list

| Type | Inverse | Symmetric |
|------|---------|-----------|
| `ally_of` | `ally_of` | yes |
| `enemy_of` | `enemy_of` | yes |
| `member_of` | `has_member` | no |
| `leads` | `led_by` | no |
| `works_for` | `employs` | no |
| `owns` | `owned_by` | no |
| `located_in` | `contains` | no |
| `parent_of` | `child_of` | no |
| `related_to` | `related_to` | yes |

`related_to` is the escape hatch for anything the list does not cover. A missing type is added to the shared table, never typed free-form. Free text would give each World its own vocabulary and make the graph impossible to query.

Only the forward type is stored (`member_of`, not `has_member`). The inverse is looked up from the shared table (`shared/src/schemas/relation.ts`, built like `kind.ts`), so there is one row per fact and the two directions can never disagree. A symmetric type is stored once with its two paths in sorted order, so `A ally_of B` and `B ally_of A` are the same row.

## Considered Options

- **Typing the edges in `note_links`**: rejected. The table is rebuilt from the body on every save and holds one edge per pair of Notes. See above.
- **Inline syntax such as `[[Xanathar|enemy of]]`**: rejected. `|` already means a display alias in a wikilink, so the two would collide.
- **Free-text relation labels**: rejected. They cannot be filtered or merged, and every agent would have to guess the spelling.
- **Writing the inverse as a second row**: rejected. Two rows per fact can be edited into disagreement.
- **Letting an agent write Relationships directly**: rejected for the reason in ADR 0001. A wrong edge in shared knowledge looks authoritative and goes unnoticed.

## Tags

Tags stay as they are: flat labels on a single Note, from `#hashtags` and frontmatter, stored in `tags`. They describe a Note and do not connect two of them, so they are not Relationships. Tags still help in two ways, neither of which stores anything new:

- Agents can ask for the Notes that share a tag with a given Note. This is computed on read.
- A namespaced tag such as `faction/zhentarim` on a Person, next to a Lore Note titled Zhentarim, is a good guess for a `member_of` Relationship. A later backfill may offer these guesses for review. It never applies them.

Update, 2026-10-11: the tag-based backfill was dropped. Measured on a snapshot of production, 0 of 872 tags are namespaced, and the tags that exist are mostly noise, so `faction/<name>` has no data behind it. The structured data is the frontmatter `faction:` and `location:` fields on Person and Creature Notes. `server/scripts/suggest-relations.ts` reads those and prints candidate `member_of` and `located_in` Relationships. It is still read-only and still reviewed: a candidate becomes a Relationship only when a Wrap-up proposes it and a Player applies it. The paragraph above stays as the original decision.

Update, 2026-10-18: ADR 0003 lets a person add or remove a Relationship from the Note page when they can edit both Notes. "Only through a Wrap-up" and "add-only" now apply to automated writers only. The Note page has a Connections panel listing Relationships by type. The rest of this ADR stands.

## Consequences

- Relationships appear in the graph only through their link, and carry their type only in the new MCP reads and the review dialog until a Note-page panel exists.
- Every code path that renames, moves, duplicates or deletes a Note must carry its `note_relations` rows with it, exactly as it already does for `note_links`. The plan lists them.
- The type list is part of the MCP tool schema, so a new type is a visible change to every connected agent.
