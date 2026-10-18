# Knowledge graph, next phase: build plan

Decisions: `docs/adr/0003-connections-panel-and-manual-relationships.md`, building on ADR 0001 (Wrap-up) and ADR 0002 (typed Relationships). Terms follow `GLOSSARY.md`.

## Ground rules

- One PR per step. PRs 1 → 2 → 3 stack in that order; PRs 4 and 5 are independent and base on `main`.
- Short-path worktree per PR (`git worktree add ../ds-<slug> -b <branch> origin/main`, or off the PR below it when stacked). Follow the memory rules in `CLAUDE.md`: gated scripts only, run touched test files while working, run the full `test` + `typecheck` + `lint` once before the PR, and remove the worktree when the PR is open.
- Files are LF in the repo (Windows checkouts show CRLF through autocrlf; do not commit CRLF). Palette colours are `var(--*)` only (`.claude/rules/frontend.md`).
- Visibility: every list applies `visibilityFor(role)` to every Note it names. A hidden Note is absent, never a 403.
- No migration is needed for PRs 1–5. If you find one is needed, check the latest version in `server/src/lib/migrations.ts` on a fresh `origin/main`.
- Never merge. Open the PR and report its URL.

## PR 1: Connections panel, read only (`feat/connections-panel`)

- New `server/src/app/notes/ConnectionsPanel.tsx` replaces `BacklinksPanel` and `OutgoingLinksPanel` in `NoteSidebar.tsx`. Tags, Outline and Graph stay below it.
- **Relationships** section: `listRelations({ groupId, role, path })` from `lib/relations.ts` (already visibility-gated, already resolved to this Note's side). Rows are grouped by `label` ("Works for", "Located in"), each linking to the other Note. Under each row, in small muted text: "since <Session title>" linking to `sessionPath` when present, else "added by <display name>". `RelationView` needs `createdBy` for that; add it, resolved to a display name.
- **Links** section: merge the existing backlinks and outgoing links into one list. Each row shows → (this Note links to it), ← (it links here) or ↔ (both). Leave out any path already shown under Relationships. Keep the existing × remove behaviour for link rows (same `/api/notes/backlink` DELETE calls as today) and keep the existing add buttons until PR 3 replaces them.
- Hide a section with no rows. When all are empty, show one line: "No connections yet."
- The pure parts go in `server/src/app/notes/connections.ts` with tests: merging the two link lists into arrowed rows, de-duping against Relationships, grouping Relationships by label.
- Delete `BacklinksPanel.tsx` / `OutgoingLinksPanel.tsx` once nothing imports them.

## PR 2: Unlinked mentions (`feat/unlinked-mentions`, stacked on PR 1)

- `server/src/lib/unlinked-mentions.ts#findUnlinkedMentions({ groupId, role, path, limit = 20 })`:
  - Terms: the Note's title plus its `aliases` rows. Drop terms under 4 characters.
  - Find candidates with FTS via `worldFtsMatch()` from `lib/search.ts` then confirm a whole-word, case-insensitive match against `content_text` in JS. `worldFtsMatch` ANDs prefix tokens, so its candidate set is broad: never cap candidates before the whole-word check, or newer near-misses ("towering" for "Tower") crowd out real mentions. Prefer an exact phrase match on the body column, or page until `limit` whole-word hits are found.
  - Exclude: the Note itself, Notes already linked in either direction (`note_links`), and Notes hidden by `visibilityFor(role)`.
  - Order by `updated_at` desc and cap at `limit`. Return `{ path, title, snippet }`, where the snippet is about 80 characters around the first match.
- Render as the third section of `ConnectionsPanel`. Each row: the other Note's title, the snippet in muted text, and a "Link" button.
- "Link" adds the plain manual link and never edits text. In PR 2 it uses `POST /api/notes/backlink` and is hidden for Players, since that route refuses them. PR 3 moves it to `POST /api/notes/relations` with `relation: 'link'` and shows it whenever the caller can edit both Notes.
- Tests (real in-memory SQLite): a whole-word match is found; a substring inside another word is not; an alias matches; a title under 4 letters is ignored; an already-linked Note is excluded; a `dm_only` mentioning Note is absent for a viewer and present for an editor; the cap holds.

## PR 3: Add and remove connections (`feat/connection-editing`, stacked on PR 2)

- Move `canEditDoc` (and its helpers `isNonNoteDoc`, `isPcOwnedBy` as needed) from `collab/server.ts` into `server/src/lib/note-permissions.ts`. `collab/server.ts` and `app/api/sessions/player-sessions.test.ts` import it from there. No behaviour change; the existing collab tests must still pass. The note page (`app/(app)/(content)/notes/[...path]/page.tsx`) and the new route both use this one helper for every Connections-panel permission, so there is one edit rule.
- `lib/relations.ts`: add `removeRelation({ groupId, from, relation, to })`, which canonicalises like `addRelation` and deletes the one row. It leaves `note_links` alone and reports `removed` or `missing`.
- Route `server/src/app/api/notes/relations/route.ts`, following the API conventions in `CLAUDE.md`:
  - `POST { path, relation: RelationName | 'link', otherPath }` adds a connection.
  - `DELETE { path, relation: RelationName, otherPath }` removes a Relationship.
  - `relation` is from **this Note's side** and may be an inverse name (`contains`, `employs`, `has_member`…). Map an inverse to its forward type and swap the ends using the shared table in `shared/src/schemas/relation.ts`. If that table has no inverse→forward lookup, add a `forwardOf(name)` helper there rather than a switch in the route.
  - `'link'` inserts the plain `is_manual` `note_links` row only.
  - Permissions: first, a Note hidden from the caller, or missing, returns 404 `not_found`. Only then check `canEditDoc` on **both** Notes, otherwise 403 `forbidden`. This order means a 403 never confirms that a hidden Note exists. Both Notes must be in the caller's world. `sessionPath` is null and `userId` is the caller.
  - `logAudit` on every add and remove, with action names `relation.add` / `relation.remove` and the details `{ from, relation, to }`.
- UI: one "Add connection" button at the top of `ConnectionsPanel`. It opens a small popover with a Note search (reuse the search the current `AddBacklink` / `AddOutgoingLink` use) and a type `<select>`. The first option is "just linked"; then every type, plus the inverse of each non-symmetric type (`ally_of`, `enemy_of` and `related_to` are their own inverse and appear once), labelled from this Note's side (`RELATIONS[t].label` / `.inverseLabel`). Hide the button when the caller cannot edit this Note.
- Relationship rows get a × (shown only when the caller can edit both Notes; pass a per-row `canRemove` from the server) that calls DELETE with no confirmation, optimistically removes the row, then refreshes.
- Remove `AddBacklink.tsx` / `AddOutgoingLink.tsx` once nothing imports them.
- Docs: in `CLAUDE.md`, add Key files rows for `lib/note-permissions.ts` and `api/notes/relations/route.ts`, and update the `note_relations` row: Relationships are authored by a reviewed Wrap-up or by hand on the Note page (ADR 0003). PR 2 adds a row for `lib/unlinked-mentions.ts`.
- Tests: route tests for add of a forward type, add of an inverse (stored as the canonical forward row), add of `link`, symmetric add from either end being `unchanged`, remove keeps the `note_links` row, 403 when the caller can't edit one end (a viewer on a Note they didn't create), 404 for a hidden Note, and an audit row written.

## PR 4: "Already exists" warning (`feat/similar-name-warning`, base `main`)

- `server/src/lib/similar-names.ts#findSimilarNotes({ groupId, role, name, limit = 3, excludePath? })`:
  - Normalise: NFKD, strip accents, lowercase, drop a parenthetical, drop punctuation, drop stop words (`the a an of`), collapse spaces.
  - A Note matches when, after normalising: (1) the names are equal; or (2) Damerau-Levenshtein distance is ≤ 1 when the shorter is 5–9 characters, or ≤ 2 when it is ≥ 10; or (3) some token of length ≥ 5 in one is at distance **exactly** 1 from a token in the other (an identical shared token does not count). Do **not** match on containment (Kingsport vs Kingsport Docks).
  - Check titles and `aliases`, across every kind except `session`. Apply `visibilityFor(role)`. Rank by rule (1) > (2) > (3), then by distance. Return `{ path, title, kind, reason }`.
  - Where the rules come from: a read-only prototype run on the 2026-10-17 production snapshot (613 non-Session Notes) found 54 equal-after-normalising pairs (mostly per-campaign index Notes such as "Characters"), 4 close spellings, 71 one-letter word matches and 26 containment pairs. The likely real duplicates were Kixish/Kixxish, Find Shalistra/Find Solistra, Bassos/Basos and Diane/Diane (Mythwell). The containment pairs were almost all a place inside a place (Kingsport Docks/Kingsport), which is why containment is excluded.
- Route `GET /api/notes/similar?name=` (session required, no CSRF, read only) returning `{ matches }`.
- Note creation UI: find where Notes are created by hand (`git grep -n "api/notes/create"` under `server/src/app`). While the user types a name (debounced 300 ms), show at most 3 matches: "**Kixxish** (Person) already exists" with "Open it" (navigates) and "Create anyway" (continues). It never blocks.
- Wrap-up review (`WrapUpRows.tsx`, `wrap-up-review.ts`, `lib/wrap-up.ts`): when the server builds the pending proposal for review, attach `similar` matches to each mention that would create a new Note. The review row shows "Similar: **Kixish**" with a "Use Kixish instead" control. Choosing it makes the apply treat that mention as targeting the existing Note: its History entry goes there and any Relationship endpoint that named the mention resolves to the existing path. Find how `applyWrapUp` takes a reviewed mention's target today and extend that, rather than adding a parallel path. Keep the pure review state in `wrap-up-review.ts` and test it there. Apply must re-check that the chosen existing Note is still visible to the applier (404 semantics as today).
- Tests: the matching rules (equal after normalising, one-letter typo, token typo, no containment match, hidden Note absent); the route; the review-state toggle; apply with "use existing" puts History on the existing Note and resolves a Relationship to it.

## PR 5: Wrap-up tool instructions (`feat/wrapup-tool-guidance`, base `main`)

- `server/src/lib/mcp/tools.ts`: tighten the descriptions of `wrap_up_context` and `submit_wrap_up` (text only, no behaviour change). Before proposing a new Note, Claude must check the candidate Notes and `search_notes` for an existing one, including a near spelling, and use it. Propose a Relationship only when the log states it, with `related_to` as the fallback. Prefer `existing` endpoints over new `mention`s.
- If any test snapshots the descriptions, update it. Run `lib/mcp/tools.test.ts`.

## Out of scope

- Merging Notes and a duplicate cleanup page (parked, see ADR 0003).
- Frontmatter-based suggestions in the panel.
- The local companion that drafts a Wrap-up through a player's own `claude` / `codex` when End Session is clicked. It is deferred until the connector flow (PR #103) has been used for a few Sessions.

## Definition of done per PR

- `bun run test`, `bun run typecheck` and `bun run lint` pass once, on the final tree.
- New behaviour has a test that fails without it.
- UI changes are checked in a running dev server (`bun run dev`) where possible. Anything not driven in a browser is stated plainly in the PR.
- The PR body says what changed, why, how it was verified, and what was not verified.
