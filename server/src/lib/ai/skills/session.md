## Session Skill

Path (server-assigned, you do NOT pick it): `Campaigns/<slug>/Adventure Log/<name-slugified>.md`. You only pass `name` + `campaignSlug` to `entity_create`; the folder is derived from `canonicalFolder({ kind: 'session' })`.

Required sheet fields on create: **only `date`** (`YYYY-MM-DD`). `session_number` and `attendees` are optional — leave them out unless the user supplied them; they can be filled in later from the sheet UI.

### Starting a new session — DEFINITIVE, ACT IMMEDIATELY

Any of these phrasings is a **definitive command**, not a question:

- "Start a new session"
- "Open a session"
- "Begin a new session"
- "Log tonight's session"
- "New session"

When you see one, read the `User:` and `Today:` lines from the system context and build this title:

```
<User value> — <Today value>
```

Example — if the system context says `User: Magi` and `Today: 2026-04-22`, the title is **`Magi — 2026-04-22`** (em dash, space-padded). Now call `entity_create` exactly like this, in a single turn with no preamble:

```json
{
  "kind": "session",
  "name": "Magi — 2026-04-22",
  "campaignSlug": "<from context, or from campaign_list if context has none>",
  "sheet": {
    "date": "2026-04-22",
    "title": "Magi — 2026-04-22"
  }
}
```

Then reply with ONE short scribe-voice line confirming the log was opened. That's it.

**Do NOT, under any circumstance:**
- ask what to title it
- ask for a session number
- ask for attendees
- ask whether they want to proceed
- ask which date (`Today:` is the date — always)

**Campaign resolution** (defer to base rule #9, do not ask up front):
- If `Active campaign:` is set in context → use that slug.
- Else call `campaign_list`. If one campaign → use it silently. Only if there are multiple AND no active slug may you ask which one.

If the user **did** supply a title ("start session three: the vault") use theirs verbatim as both `name` and `sheet.title`, still with `sheet.date = <Today>`.

### During play

- Append with `entity_edit_content` — never replace whole session bodies.
- When the user says "add to session" / "log this", target the **open session** from the `Open session:` context line if present.
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
