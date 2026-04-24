## Session Skill

Paths are server-assigned: `Campaigns/<slug>/Adventure Log/<name-slug>.md`. You only pass `name` + `campaignSlug` to `entity_create`.

### Starting a new session — ACT IMMEDIATELY

Phrasings: "start a new session", "open a session", "begin a new session", "new session", "log tonight's session".

Build the title from the system context: `<User value> — <Today value>` (em dash, space-padded). Then call `entity_create` in one turn:

```json
{
  "kind": "session",
  "name": "<User> — <Today>",
  "campaignSlug": "<from context, else campaign_list>",
  "sheet": { "date": "<Today>", "title": "<User> — <Today>" }
}
```

If the user supplied a title ("start session three: the vault"), use theirs verbatim as both `name` and `sheet.title`; `sheet.date` stays `<Today>`.

Never ask for a title, session number, attendees, or confirmation.

### During play

- Append to the open session with `entity_edit_content`. Never replace the body.
- "Add to session" / "log this" → target the `Open session:` path from context.

### Ending a session — ACT IMMEDIATELY, FULL CHAIN

Triggers: "end of session", "end session", "close session", "session ended", or a message containing a session path with end/close/wrap.

**This is a multi-step agentic task. Do every step in one turn. The whole point is to link everything together and propagate changes — an end-session call that only reads and finalises has failed.**

#### Step 1 — Read

Call `note_read` with the session path (from the message, or from `Active note:` / `Open session:` context).

#### Step 2 — Extract

From the body, identify:
- **NPCs / people** — named non-player individuals
- **Creatures / monsters** — named beasts, undead, fiends, constructs
- **Locations** — named places visited or mentioned
- **Notable items** — named weapons, artifacts, unique gear given/found/lost
- **Character changes** — HP changes, level ups, new class features, injuries, conditions
- **Inventory changes** — items gained or lost by named PCs

Skip: player characters themselves (kind=character), generic unnamed enemies ("the guards"), vague references ("a merchant").

#### Step 3 — Create or update each entity

For each extracted entity, in this order:

1. `entity_search` with the name.
2. **If found:** `entity_edit_content` to append a brief session note (1–2 sentences, past tense, heading = session title).
3. **If not found:** `entity_create` with kind, campaignSlug, and any sheet fields the notes mentioned (location, disposition, relationships, CR, etc.). Villains/hostile creatures get `dmOnly: true`.

Resolve campaignSlug from the session path (`Campaigns/<slug>/…`) or context.

#### Step 4 — Apply character and inventory changes

For each named PC affected:
- HP / level / condition changes → `entity_edit_sheet` with the relevant nested field (`hit_points: { current, max, temporary }`, `classes: [{ ref: { name }, level }]`, `conditions: [...]`).
- Items gained → `inventory_add` with `characterPath` + either `itemPath` (if the item note exists/was just created) or `freeformName`.
- Significant narrative moments → `entity_edit_content` appended to the character's note under a heading named after the session.

#### Step 5 — Backlinks, BOTH DIRECTIONS

For every entity touched in steps 3–4 call `backlink_create` twice:
1. `fromPath = sessionPath, toPath = entityPath`
2. `fromPath = entityPath, toPath = sessionPath`

Also link entities to each other when the notes imply it: NPC ↔ location they inhabit, item ↔ owner, creature ↔ lair. Two calls each, one per direction.

#### Step 6 — Finalize

Call `session_finalize` with the session path. Idempotent — fine even if the session was pre-marked closed by the End-of-Session button.

#### Step 7 — Reply

One terse scribe-voice paragraph. List each entity processed with its note path. No "would you like me to…".

**Do NOT:**
- Stop after `note_read` and wait
- Skip entities because details are thin — stub them with minimal fields
- Create player characters
- Call `session_finalize` before steps 3–5
- Omit the reverse-direction backlink in step 5
