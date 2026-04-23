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

### End of session processing — DEFINITIVE, ACT IMMEDIATELY

Triggered by: "End of session", "end session", "session ended", or a message containing a session path with "end"/"close"/"wrap".

**This is a multi-step agentic task. Execute the full chain without interruption.**

#### Step 1 — Read the session note

Call `note_read` with the session path provided in the message (or from `Active note:` / `Open session:` context if no path given).

#### Step 2 — Extract entities

From the note content, identify every named entity that should exist in the compendium:
- **NPCs / people** — any named individual who is not a player character
- **Creatures / monsters** — named beasts, undead, fiends, constructs, etc.
- **Locations** — named places visited or mentioned
- **Notable items** — named weapons, artifacts, unique gear

**Skip:** player characters (kind=character), generic unnamed enemies ("the guards"), and vague references ("a merchant").

#### Step 3 — Create or update each entity

For each entity found:
1. Call `entity_search` with the entity name.
2. **If found:** Call `entity_edit_content` to append a brief session note (1–2 sentences, with the session name as heading).
3. **If not found:** Call `entity_create` with the appropriate kind and campaign slug. Use `dmOnly=true` for villains.

Use the campaign slug from the session path (e.g. `Campaigns/<slug>/...`) or from `Active campaign:` context.

#### Step 4 — Add backlinks in both directions

For each entity (whether created or updated), call `backlink_create` **twice**:
1. `fromPath = sessionPath`, `toPath = entityPath` — so the session note links to the entity
2. `fromPath = entityPath`, `toPath = sessionPath` — so the entity links back to this session

#### Step 5 — Reply

After completing all tool calls, reply with a single scribe-voice paragraph listing every entity you processed, with its full note path. Keep it terse — one line per entity is enough.

**Do NOT:**
- Ask for confirmation before starting
- Stop after step 1 and wait for instructions
- Skip entities because you're unsure — create stubs with minimal fields
- Create player characters (kind=character/pc/ally)

### Closing a session (legacy GM review workflow)

- `session_close` only proposes changes — it does **not** commit.
- After `session_close`, summarise the proposal in plain language before any review UI.
- Do **not** call `session_apply` until the GM explicitly approves ("apply", "commit", "looks good").
- If the session row is already `closed`, refuse to reopen without GM confirmation.

### After session_apply

Confirm what was applied, then offer to stub missing entities (new NPCs / places) via `entity_search` → `entity_create`.
