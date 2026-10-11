# Typed Relationships: build plan

Decision and reasoning: `docs/adr/0002-typed-relationships.md`. Read it first. This file is the work breakdown.

Terms follow `GLOSSARY.md`. Add **Relationship** to it as part of PR 1: _"How one Note stands to another, such as ally of or located in, drawn from a fixed list and recorded with the Session that established it. Avoid: edge, link (a link only says two Notes are connected)."_

## Ground rules

- One PR per step below, in order. Each stands alone and is green by itself.
- Use a short-path worktree (`git worktree add ../ds-rel -b feat/relationships-schema origin/main`). Long paths break removal on Windows. Follow the memory rules in `CLAUDE.md`: gated scripts only, run touched test files while working, full `test` + `typecheck` + `lint` once before the PR, remove the worktree when the PR is open.
- The next free migration is **v52** on `main` today (v49 Wrap-up, v50 OAuth, v51 Character suggestions). Check `server/src/lib/migrations.ts` and `bun run test` on a fresh `origin/main` first. If another PR has taken v52, use the next number. The runner applies by highest version only, so two PRs on the same number is a real hazard: whoever merges second must renumber.
- Files use CRLF. Any script that edits them must handle `\r\n`.
- Never merge. Open the PR, link it to the thread, report.

## Step 0: look at real usage (read only, no PR)

The local checkout has no user data, so nothing here could be measured. Before building, run these against the production database (Railway: `railway run` with `DATA_DIR` set, or the volume's `compendium.db` opened read-only) and paste the results into the PR 1 description:

```sql
-- how are tags used, and are namespaced tags (faction/x) common?
SELECT tag, COUNT(*) n FROM tags GROUP BY tag ORDER BY n DESC LIMIT 50;
SELECT COUNT(*) AS namespaced FROM tags WHERE tag LIKE '%/%';
-- how connected is the graph?
SELECT COUNT(*) AS links, SUM(is_manual) AS manual, SUM(is_index) AS idx FROM note_links;
-- kinds in use, to size the vocabulary
SELECT json_extract(frontmatter_json,'$.kind') AS kind, COUNT(*) FROM notes GROUP BY 1 ORDER BY 2 DESC;
```

If namespaced tags are common, move step 5 up. If almost no World uses tags, drop step 5. The vocabulary in the ADR stands either way.

## PR 1: schema and shared vocabulary (`feat/relationships-schema`)

1. `shared/src/schemas/relation.ts`, built like `kind.ts`. One table is the only source of truth:
   `RELATION_TYPES` (the nine in the ADR), each with `inverse`, `symmetric`, and a human `label` and `inverseLabel` for the UI. Export `parseRelation(string)`, `inverseOf(type)`, and `canonicalPair(from, type, to)`, which for a symmetric type orders the two paths (`a < b`) so `A ally_of B` and `B ally_of A` collapse to one row. Re-export from `shared/src/index.ts`. Never add a second switch elsewhere.
2. Migration v52, append only:
   ```sql
   CREATE TABLE note_relations (
     group_id     TEXT NOT NULL,
     from_path    TEXT NOT NULL,
     relation     TEXT NOT NULL,
     to_path      TEXT NOT NULL,
     session_path TEXT,
     created_by   TEXT,
     created_at   INTEGER NOT NULL,
     PRIMARY KEY (group_id, from_path, relation, to_path)
   ) WITHOUT ROWID;
   CREATE INDEX note_relations_to ON note_relations(group_id, to_path);
   ```
   Add a `CHECK (relation IN (...))` built from the shared list so the DB rejects a typo.
3. `server/src/lib/relations.ts`:
   - `addRelation({ groupId, from, relation, to, sessionPath, userId })`: canonicalises the pair, inserts `INSERT OR IGNORE`, and in the same transaction inserts the plain `is_manual = 1` row into `note_links` for the pair (as `api/notes/backlink/route.ts` does). Idempotent. Reports `added` or `unchanged`, like `addHistoryEntry`.
   - `listRelations({ groupId, role, path })`: returns every Relationship the note takes part in, both directions, each resolved to the reading side's type (`inverseOf` when the note is the `to` end). Applies `visibilityFor(role)` to **both** Notes of every row, so an edge to a Secret or Private Note never appears. This is the only read path; do not query the table elsewhere.
4. Carry the rows with their Notes. Wherever the code touches `note_links` for a rename, move, delete, or duplicate, do the same for `note_relations`. The places, from `git grep -n "note_links"`:
   - move/rename: `api/notes/move/route.ts`, `lib/move-folder.ts`, `api/notes/promote/route.ts`, and the `ai/tools.ts` move helpers (`UPDATE ... SET from_path/to_path`)
   - delete: `api/notes/[...path]/route.ts`, `api/campaigns/delete/route.ts`, `api/folders/delete/route.ts`
   - duplicate: `api/notes/duplicate/route.ts` (the copy gets no Relationships; say so in a comment)
   - bulk rebuild: `lib/ingest.ts` and `lib/import-apply.ts` rewrite `note_links` wholesale; leave `note_relations` alone in both, since they are authored.
   A moved path that would collide with an existing row must merge, not fail: use `UPDATE OR IGNORE` then delete the leftovers, as `move-rewrite.ts` does.
5. Tests (real in-memory SQLite, no mocks): canonical pair for symmetric types; `addRelation` idempotent and writes the manual link; `listRelations` returns the inverse from the other end; a Relationship to a Secret Note is absent for a Player and present for a Co-GM; a Private Note is absent for a Co-GM; rename and delete carry or drop rows; a duplicate does not copy them.
6. Docs: `CLAUDE.md` data-model table and migration count, `GLOSSARY.md` term, `ARCHITECTURE.md` table list.

## PR 2: Wrap-up proposes Relationships (`feat/relationships-wrapup`)

Depends on PR 1.

1. `lib/wrap-up.ts`: add an optional `relations` array to `WrapUpSubmission`, strict like the rest, max 60:
   ```ts
   { from: Endpoint, relation: RelationType, to: Endpoint, note?: oneLine(300) }
   Endpoint = { type: 'mention', name: string } | { type: 'existing', path: string }
   ```
   A `mention` endpoint names a mention in the same submission (matched by its `name`); an `existing` endpoint is a Note path. This lets a relation join a Note the Wrap-up is about to create. Reject, with `invalid_relation`, a `mention` name that matches no mention, an endpoint equal to its twin, and an `existing` path the submitter cannot see (read as not found, like mentions). Store with an app-assigned opaque id, like `Mention`.
2. `applyWrapUp`: apply Relationships **after** mentions, so created Notes have paths. A Relationship is applied only when both endpoints resolved: each `mention` endpoint was ticked, and each `existing` one is still visible. Otherwise it is skipped and reported as skipped, never an error. Add `relationsAdded` and `relationsSkipped` to `ApplyResult`.
3. Review UI: `WrapUpDialog.tsx` and `wrap-up-review.ts`. Add a "Relationships" group under the mention groups, one row per Relationship ("Volo → works for → Xanathar"), ticked by default. Unticking a mention greys out and unticks the Relationships that depend on it. Keep the pure review state in `wrap-up-review.ts` and test it there.
4. Routes: `POST /api/sessions/wrap-up` and the `apply` body accept the new field; `loadPendingWrapUp` strips any Relationship with an endpoint the reader cannot see, as it already does for mentions.
5. MCP: `submit_wrap_up` in `lib/mcp/tools.ts` gains `relations`, using the shared zod enum so the schema lists the types. Say in the tool description that `related_to` is the fallback and that only relationships stated in the log may be proposed. `wrap_up_context` needs no change.
6. Tests: route tests for submit/apply with a relation to a new Note, to an existing Note, and to a hidden Note; apply skips a Relationship whose mention was unticked; a repeat apply is `unchanged`; the review-state test for dependent unticking. Extend the MCP route test so a read-only grant still cannot submit.

## PR 3: agents can read Relationships (`feat/relationships-mcp-read`)

Depends on PR 1 (PR 2 is not required, but it is what fills the table).

- `read_note` adds a `relationships:` section (`- works for: Xanathar (path)`), from `listRelations`.
- `note_neighbors` labels each edge with its type when one exists and keeps untyped links as they are. It accepts an optional `relation` filter.
- `search_notes` is unchanged.
- Shared tags, computed on read and stored nowhere: `read_note` adds a `shares tags with:` line listing up to 10 visible Notes that share at least one tag, most shared first. `tags` is queried with `group_id`, and the visibility predicate applies to the other Note.
- Tests in `lib/mcp/tools.test.ts`; update `scripts/mcp-smoke.ts` only if a new tool is added.

## PR 4 (optional, only if step 0 says tags are in real use): suggest Relationships from tags

A backfill command in `server/scripts/` that, for each Person or Creature with a namespaced tag `<ns>/<name>` where a Lore Note titled `<name>` exists, prints a candidate `member_of` Relationship. It writes nothing. Turning those into proposals goes through a Wrap-up, never directly.

## Out of scope for this work

- A Relationships panel on the Note page and manual add/remove from the UI. Do it after PR 2 lands and people have used the review step.
- Dropping the `items`, `locations` and `creatures` tables. They are not dead: `lib/items.ts`, `lib/locations.ts` and `lib/creatures.ts` write and read them as derived indexes of frontmatter. Auditing their readers is its own task and should not ride on this one.
- Free-text relation labels, inline link syntax, and any tool that writes a Relationship without a reviewed proposal. See the ADR for why.
- Typed edges in the graph view. The manual link already puts the connection there. Labelling the edges is a UI task for later.

## Definition of done per PR

- `bun run test`, `bun run typecheck`, `bun run lint` green once, on the final tree.
- New behaviour has a test that fails without it.
- PR body: what changed, why, how it was verified, and what was not (anything not driven in a real browser or against a live server is said so plainly).
