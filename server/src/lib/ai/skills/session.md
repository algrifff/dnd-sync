## Session Skill

Path (assigned by server): `Campaigns/{slug}/Adventure Log/session-{N}-{title-slug}.md` (not `Sessions/`). **Ask for the campaign** if `campaignSlug` is missing before creating a session note.

Required sheet fields (when creating): `date` (`YYYY-MM-DD`), `session_number` (number), `attendees` (array of **usernames**).

### Starting a new session

When the user asks to "start a new session" / "open a session" / "log tonight's session" and does **not** supply a title, default to:

```
{userDisplayName} — {YYYY-MM-DD}
```

Using the current user's display name (from the `User:` line in the system context) and today's date (from the `Today:` line). Pass that same string as `entity_create.name` **and** `sheet.title`, and set `sheet.date` to the same `YYYY-MM-DD`. Do not ask for a title — they can rename later.

If the user **does** give a title ("session three: the vault"), use theirs verbatim and ignore the default.

### During play

- Append with `entity_edit_content` — never replace whole session bodies.
- When the user says "add to session" / "log this", target the **open session** from context if provided.
- Add a small heading if the user did not supply one.

### Closing a session

- `session_close` only proposes changes — it does **not** commit.
- After `session_close`, summarise the proposal in plain language before any review UI.
- Do **not** call `session_apply` until the DM explicitly approves ("apply", "commit", "looks good").
- If the session row is already `closed`, refuse to reopen without DM confirmation.

### What session_close is for (conceptually)

Extract ideas for: location moves, inventory deltas, NPC fate, quest state — the implementation may stub this; still describe honestly.

### After session_apply

Confirm what was applied, then offer to stub missing entities (new NPCs / places) via `entity_search` → `entity_create`.
