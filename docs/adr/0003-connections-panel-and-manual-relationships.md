# People can add and remove Relationships by hand, and the Note page shows every connection in one panel

ADR 0002 made a Wrap-up the only way to create a Relationship, so that no unreviewed edge lands in shared knowledge. That leaves no way to record a fact the table already knows, or to correct a wrong one, without running a Wrap-up. We decided:

- A person can add or remove a Relationship from the Note page. A person adding or removing it counts as the review that ADR 0002 asks for.
- The rule for who may do it is the same rule the editor uses: they must be able to edit **both** Notes (`canEditDoc`). For a GM that means any pair. For a Player it means Notes they created, their own Character, and Session logs. The rule can be loosened later.
- Removing a Relationship keeps the plain link, as ADR 0002 says, and writes an `audit_log` entry so a GM can see who removed what.
- The Note page replaces its "Links to" and "Backlinks" panels with one **Connections** panel. Its sections are Relationships, Links (one list with a direction arrow; a Note already listed under Relationships is not repeated) and Unlinked mentions. Empty sections are hidden.
- An **Unlinked mention** is a Note whose text names this Note's title or an alias as a whole word, ignoring case, without linking to it. Titles under four letters are skipped. "Link" adds the plain `is_manual` link and never edits anyone's text, since the text is a live CRDT document other people may be typing in.
- Creating a Note, by hand or in a Wrap-up review, warns when a Note with a similar name already exists and offers to use that one. It only warns. Nothing is merged.

## Considered Options

- **Wrap-up only, as before**: rejected. A fact everyone at the table already knows should not need a Session to record it.
- **GM-only manual edits**: rejected. Players run Sessions (ADR 0001), and the edit rule they already have is the right fence.
- **Rewriting the mention into a wikilink**: rejected for now. It edits prose someone else wrote, live, under concurrent edits.
- **Suggesting Relationships from `faction:` / `location:` frontmatter in the panel**: deferred. On the production snapshot only 8 of 34 faction values match a Note, and many location values are placeholders. A dismissed suggestion would also return on every load unless dismissals were stored.
- **Merging Notes with similar names**: parked. A name alone does not show that two Notes describe the same thing. Kixish and Kixxish may be one Person, but Kingsport and Kingsport Docks are a town and a place in it. A merge is destructive, so it waits for a way to compare what the Notes say, not just their names.

## Consequences

- ADR 0002's "add-only, only through a Wrap-up" now applies to automated writers only. No agent writes a Relationship without a person's review.
- `canEditDoc` moves out of `collab/server.ts` into a lib module so the HTTP routes and the collab server share one rule.
- The graph already colours Relationships by type (the Orrery work), so this ADR adds nothing there.
