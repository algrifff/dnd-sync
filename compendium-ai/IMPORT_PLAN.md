# AI-assisted import — plan

> Drop any folder (Obsidian, Google Docs export, loose `.md`, whatever) into
> a chat panel on the home page. The server runs a two-pass ingest:
> classical parse, then a GPT-5-mini pass that classifies every note,
> extracts structured frontmatter, pairs images with their owners, auto-
> tags, and proposes vault paths. The DM sees the plan as a chat reply,
> one-clicks **Accept all** (or opens the full per-row review), and the
> apply step writes through the existing derive pipeline so graph /
> backlinks / dashboards all light up together.

---

## 1. Flow

```
upload ─► classical parse ─► AI analyse ─► review UI ─► apply
 (fast)     (fast, sync)      (async, slow) (human)      (sync, fast)
```

Each import is its own job row so the DM can walk away, come back, run
several in parallel, or cancel one mid-way. Analysis runs in a small
in-process worker (capped concurrency, no Redis needed).

---

## 2. Schema

```sql
CREATE TABLE import_jobs (
  id           TEXT PRIMARY KEY,           -- uuid
  group_id     TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_by   TEXT NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL,              -- uploaded | analysing | ready | applied | cancelled | failed
  raw_zip_path TEXT,                       -- temp file on disk; cleaned on apply/cancel
  plan_json    TEXT,                       -- AI output + review state
  stats_json   TEXT,                       -- counts, tokens used, cost
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
```

---

## 3. API surface

| Route | Purpose |
|---|---|
| `POST /api/import` | upload ZIP, creates job, returns id |
| `POST /api/import/:id/analyse` | kick off AI (async); 202, poll status |
| `GET /api/import/:id` | status + plan (for the review screen) |
| `PATCH /api/import/:id` | edit a single item in the plan (path / kind / accept flag) |
| `POST /api/import/:id/apply` | commit accepted items; clears the temp ZIP |
| `DELETE /api/import/:id` | cancel |

---

## 4. AI provider

**OpenAI**, default model `gpt-5-mini`. GPT-5.x models use the newer
**Responses API** (`POST /v1/responses`) with a different request/response
shape and parameter set than Chat Completions, so the client wrapper has
to dispatch on model family rather than hard-coding one shape.

### Env

```
OPENAI_API_KEY=sk-…               required
OPENAI_MODEL=gpt-5-mini           optional override; see family dispatch below
OPENAI_REASONING_EFFORT=minimal   minimal | low | medium | high (GPT-5 only)
IMPORT_MAX_AI_CALLS=500           hard cap per job
IMPORT_MAX_MONTHLY_COST_USD=20    soft monthly cap across jobs; job fails
                                   if the running total would exceed it
```

### Family dispatch

The client wrapper (`lib/ai/openai.ts`) exposes one method —
`generateStructured({ model, system, user, schema, ... })` — and
dispatches internally by model prefix:

| Prefix                                  | Endpoint                  | Shape |
|-----------------------------------------|---------------------------|-------|
| `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `o3`, `o4` | `/v1/responses`   | Responses API |
| `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`      | `/v1/chat/completions`    | Chat Completions |

Rules baked into the Responses path:

- **No `temperature`** — reasoning models reject it. We don't set one.
- **`reasoning: { effort: <env> }`** passed per call; default `minimal`
  because classification is pattern-matching, not chain-of-thought.
  (Effort creeps up cost + latency fast; we guard it behind the env.)
- **Structured output** via
  `text: { format: { type: "json_schema", name: "…", strict: true, schema: … } }`
  — the Responses-API equivalent of Chat Completions'
  `response_format: { type: "json_schema", … }`.
- Request body uses `input: [{ role, content: [{ type: "input_text", text }] }]`
  instead of Chat's `messages: [{ role, content }]`.
- Output comes back in `output[]` items; we pick the first item of type
  `message` and read its `content[0].text` which is the JSON string our
  schema guarantees.

For the Chat-Completions path (if the DM swaps to a 4.x model) the
wrapper uses the traditional `response_format: { type: "json_schema", … }`
with `strict: true`. Same `generateStructured` call site.

### Token + cost accounting

Usage comes back with three counters on the Responses API:

- `input_tokens`
- `output_tokens` — user-visible tokens the model produced
- `output_tokens_details.reasoning_tokens` — billed like output but
  not returned to us; we must count them toward cost to not undershoot

We record all three in `stats_json` and compute cost as:

```
cost = input_tokens      × input_price_per_mtok
     + output_tokens     × output_price_per_mtok     // includes reasoning_tokens
```

Per-model pricing sits in a small table in `lib/ai/pricing.ts` keyed by
model name, updated when OpenAI's pricing page moves. Unknown models
fall back to the GPT-5-mini rate with a warning in the job log — we'd
rather over-estimate than silently under-count.

### Retry + fallback

- One retry on schema-validation failure (very rare with `strict: true`
  but not zero).
- On consistent failure a note is marked `unclassified` and ships as
  `kind: plain` in its original folder — nothing is lost.
- If the Responses API returns a 400 because `reasoning.effort` isn't
  supported for a given model, we drop the reasoning field and retry.

---

## 5. The skill

Single responsibility: **classify and extract one note at a time**, aware of the rest of the drop.

### Input

```jsonc
{
  "note": {
    "filename": "lumen.md",
    "folder_path": "notes/stuff/",       // where it was in the user's drop
    "content": "<markdown body>",
    "existing_frontmatter": { … }        // if the note already has any
  },
  "context": {
    "known_note_paths": [ … ],           // all other notes in the drop
    "known_image_basenames": [ … ],      // images in the drop
    "canonical_folder_conventions": { … },
    "templates": [                        // live template list so the AI knows what fields exist
      { "kind": "pc", "fields": ["name","level","class",...] },
      { "kind": "location", "fields": [...] },
      …
    ],
    "existing_vault_tags": [ … ],        // so the model prefers reuse
    "target_campaign_slug": "campaign-1" // picked at job level; null if none
  }
}
```

### Output

```jsonc
{
  "kind": "character|location|item|session|lore|plain",
  "role": "pc|npc|ally|villain",         // only if kind=character
  "confidence": 0.0–1.0,
  "display_name": "Lumen Flumen",
  "canonical_path": "Campaigns/Campaign 1/Characters/Allies/Lumen Flumen.md",
  "sheet": { "race": "Aasimar", "class": "Cleric", "level": 5, … },
  "tags": ["moon-touched", "former-party"],
  "wikilinks": [
    { "anchor_text": "Balin", "target": "…/Allies/Balin.md" }
  ],
  "associated_images": ["lumen_portrait.jpg"],
  "portrait_image": "lumen_portrait.jpg",
  "rationale": "Short explanation for the human."
}
```

### Prompt rules (pinned system prompt)

- Use canonical folder conventions from §7.
- Only propose a wikilink if the target is in `known_note_paths`. Never fabricate.
- Tags: prefer values already in `existing_vault_tags`; only invent a new tag when no existing tag fits — and keep new tags to 1–2 per note max.
- Aim for 2–5 tags per note total (combined reuse + new).
- Sheet fields must match the template for the chosen kind.
- If confidence < 0.4, return `kind: plain` with no reorg — the DM can triage manually.

---

## 6. Cost guardrails

- Hard cap per job: **500 AI calls or 500k tokens** (input + output +
  reasoning), whichever first. Env-configurable.
- Soft monthly cap summed from `stats_json` across all jobs in the group.
- One retry on schema-validation failure; then the note goes to
  `unclassified`.
- Job status + plan include running call / token / cost counts so the
  DM sees what each import is spending mid-run and can cancel.

Rough cost on `gpt-5-mini` at `reasoning.effort: minimal` and list
price: **≈$0.05–0.30 per 100-note vault** (cost scales roughly with
total markdown size, not raw note count). Still negligible for a hobby
deployment — but if the DM cranks `OPENAI_REASONING_EFFORT` up to
`medium`, the per-call bill can 2–5× because reasoning tokens add up
fast. The running-cost display makes that visible.

---

## 7. Canonical folder conventions

```
Campaigns/
  Campaign X/
    Characters/
      PCs/
      NPCs/
      Allies/
      Villains/
    Sessions/                     # YYYY-MM-DD-<slug>.md
    Locations/
    Items/
Lore/
  Factions/
  Races/
  History/
Assets/
  Portraits/                      # AI infers from filename + mentions
  Maps/
  Tokens/
```

If the drop has nested folders that look like campaigns, the AI respects them. Otherwise the DM picks a **target campaign** at the job level (single picker in the review UI — everything in the drop gets nested under that one).

---

## 8. Ingress: home-page chat

Rather than a hidden settings form, the primary entrypoint is a
chat-style panel that **replaces the welcome block on the home page
(`/`)**. Dropping a ZIP (or dragging a folder the browser's
File-System-Access API treats as one) straight into the chat kicks off
an import job. Responses from the server — progress, the proposed plan,
the apply confirmation — appear as assistant messages in the thread.

```
┌─ World: The Compendium ────────────────────────────────┐
│                                                        │
│ 👤 you                                                 │
│     [dropped: my-old-vault.zip, 47 files]              │
│                                                        │
│ 🧭 compendium                                          │
│     Parsing 47 files… done. Sending 42 notes to the    │
│     AI (5 were images, already queued as assets).      │
│                                                        │
│     ▓▓▓▓▓▓▓▓░░ 34 / 42 · 112k tokens · $0.04           │
│                                                        │
│ 🧭 compendium                                          │
│     Here's what I'd do:                                │
│       • 12 characters (8 NPC, 3 ally, 1 villain)       │
│       • 5 sessions                                     │
│       • 8 locations · 2 items · 14 lore                │
│       • 3 conflicts with existing notes (will merge)   │
│       • 1 note I couldn't classify confidently         │
│       [ Accept all ] [ Open full review ] [ Cancel ]   │
│                                                        │
├─ drop a zip or folder / describe what you want ────────┤
│ [ ...input... ]                                  [ ↑ ] │
└────────────────────────────────────────────────────────┘
```

### Message model

```ts
type ChatMessage =
  | { id; role: 'user'; kind: 'text'; body: string }
  | { id; role: 'user'; kind: 'upload'; filename: string; bytes: number }
  | { id; role: 'assistant'; kind: 'text'; body: string }
  | { id; role: 'assistant'; kind: 'progress'; jobId; done: number; total: number; tokens: number; costUsd: number }
  | { id; role: 'assistant'; kind: 'plan'; jobId; summary: PlanSummary; conflicts: number; isolated: number }
  | { id; role: 'assistant'; kind: 'applied'; jobId; moved: number; merged: number; failed: number };
```

Thread is **ephemeral** per browser session for v1 — nothing persisted
in the DB. If the user refreshes mid-job the thread is empty again but
the job itself is still running and discoverable at `/settings/import/:id`.
(A later phase can persist chat threads; not worth the table now.)

### Flow

1. User drops a ZIP. Client `POST /api/import`, gets a job id, appends
   a `progress` message wired to that job.
2. Client calls `POST /api/import/:id/analyse`, then polls
   `GET /api/import/:id` every 1 s; each poll refreshes the
   `progress` message (done / total / tokens / cost).
3. On status `ready`, the `progress` message collapses and an assistant
   `plan` message appears with the summary + three buttons:
   - **Accept all** — `POST /api/import/:id/apply` with the plan as-is.
   - **Open full review** — deep-links to `/settings/import/:id` (the
     detailed per-row table from below, same data, more room to edit).
   - **Cancel** — `DELETE /api/import/:id`.
4. Apply response becomes an `applied` assistant message with counts
   and a link to the resulting notes.

### Text input

The bottom input accepts file drops **and** free-form text. v1 only
actions the file side; free text posts a neutral assistant reply
("I can import folders and zips today — type commands coming soon")
so the shape is in place for a later AI-assistant loop (e.g.
"add the 'villain' tag to every NPC in Campaign 3").

### Re-entering a job

If you navigate away and come back, the home-page chat shows any
jobs owned by the current user still in `analysing` or `ready` as a
resumable banner at the top: *"Import in progress — 42% · resume"*.
Click-through re-hydrates the `progress` / `plan` message for that job.

---

## 8b. Full review screen (secondary)

`/settings/import/:id`, admin-only. The per-row table behind the
chat's "Open full review" button — useful when the plan is large or
the DM wants to edit individual rows. Same data, finer controls.

```
☑ lumen.md              → Campaigns/…/Characters/Allies/Lumen Flumen.md  [ally] · Aasimar Cleric 5 · 3 tags · 2 links · 📷 lumen_portrait.jpg
☐ random-note.md        → <no confident classification — stays as plain page>
☑ session-2024-03-14.md → Campaigns/…/Sessions/2024-03-14.md              [session] · 3 attendees
⚠ atoxis.md             → Campaigns/…/Characters/Villains/Atoxis.md       [conflict: existing note; will merge]
```

Row actions: accept / reject, edit path (typeahead), override kind,
expand to tweak sheet JSON, hover a link to see the anchor.

Bulk actions: **Accept all**, accept all above X confidence, reject
all "plain", re-run AI on selected rows.

The job-level header has the target-campaign picker + total token
budget spent. Clicking **Apply** there does the same thing as the
chat's Accept-all button but with whatever row-level edits the DM
made.

---

## 9. Apply step

For each accepted plan entry:

1. **Collision handling** (§10 below).
2. **File placement**: move to the canonical path.
3. **Image relocation**: anything in `associated_images` moves to `Assets/Portraits/` (or `Maps/` / `Tokens/` based on filename heuristic + AI hint). Vault paths recorded so `resolveImageUrl` finds them.
4. **Frontmatter merge**: existing frontmatter wins per-key; AI-extracted fills blanks; tags union.
5. **Wikilink rewrite**: insert proposed links into the body at their anchor spans — only if the literal anchor text still matches the body exactly. First occurrence only. Never silent-overwrite.
6. **Portrait binding**: set `frontmatter.portrait` to the `Assets/Portraits/...` path when the AI flagged one.
7. **DB write**: go through the same insert + derive pipeline the classical vault ingest uses, so characters / campaigns / sessions / character_campaigns / session_notes / note_links / tags / assets all populate.

Per-note transactions with a "partial apply" log so a single bad note doesn't kill an otherwise good import. The job's `stats_json` records counts + any per-note failures.

---

## 10. Collision handling

When an incoming note would land on a path that already exists:

- Flag the row ⚠️ in the review UI with a **"merge incoming into existing"** default.
- **Merge rules**:
  - **Frontmatter**: keep existing keys as-authored; incoming fills any blank / absent keys; `tags` arrays become the union.
  - **Sheet fields** (structured notes): existing values win; incoming fills blanks only.
  - **Body**: append the incoming body beneath the existing one, separated by a horizontal rule and a marker line:
    ```
    ---
    _Imported <YYYY-MM-DD> from <original filename>_
    ---
    <incoming body>
    ```
  - **Wikilinks / images** discovered in the incoming body are de-duped against existing references before being added.
- The DM can override per-row to:
  - **Rename** the incoming note with a `(imported)` suffix (keep both).
  - **Skip** the incoming entirely.

---

## 11. Tagging (naked imports)

For every imported note the pipeline aims to satisfy **at least one of**:

- ≥ 1 outbound wikilink, OR
- ≥ 1 tag in common with an existing note, OR
- Structured kind (character / location / item / session) — the kind itself threads it into dashboards + graph.

Notes that fail all three are flagged ⚠️ **isolated** in the review UI so the DM can manually link before applying.

---

## 12. Supported file types

v1:
- `.md`, `.markdown`
- `.txt` (treated as markdown)
- `.png` / `.jpg` / `.jpeg` / `.webp` / `.gif` / `.svg` / `.pdf` (assets)

v2 (deferred):
- `.docx` — convert via Pandoc if present on the runtime image, else skip with a warning.
- Google Docs export zips — already work if the user picked the Markdown export.

---

## 13. Phasing

| # | What lands |
|--|--|
| **1a** | Migration + API scaffold (upload / get / cancel) + temp-file handling |
| **1b** | Classical parse pass (reuses existing ingest helpers); `/settings/import/:id` shows pre-AI plan |
| **1c** | OpenAI client wrapper (Responses API + Chat Completions dispatch) + skill + schema validation + retry + cost accounting |
| **1d** | Home-page chat component: drop → upload → progress → plan → accept-all |
| **1e** | Apply step: file moves, frontmatter merge, wikilink rewrites, image pairing, merge-on-conflict |
| **1f** | `/settings/import/:id` full-review UI (per-row edit / reject / re-run), wired to the chat's "Open full review" button |
| **1g** | Resumable jobs banner on the home page; polling refactor (use server-sent events later if polling gets chatty) |
| **2**  | `.docx` ingest, batched prompting for tiny notes to drop cost, on-demand re-analysis of a subset, persisted chat threads, free-text commands |

---

## 14. Decisions locked in

1. **AI provider**: **OpenAI**, default model `gpt-5-mini` via the
   **Responses API** with `reasoning.effort: minimal` by default. The
   client wrapper dispatches on model family (§4) so swapping to
   GPT-4o-family reverts to Chat Completions transparently. Env:
   `OPENAI_API_KEY`, optional `OPENAI_MODEL`,
   `OPENAI_REASONING_EFFORT`.
2. **Review is mandatory**, but `Accept all` is one click.
3. **Target campaign** chosen at job level unless the drop's folder layout already names a campaign.
4. **Destination world** is always the currently-active world — switch worlds first to import elsewhere.
5. **Hard cost cap**: 500 AI calls per job + optional monthly soft cap across jobs, both env-configurable.
6. **Tagging**: reuse existing vault tags first; coin new ones only when nothing fits; 2–5 tags per note total.
7. **Path collisions**: flag in review, default to **merge incoming into existing** (frontmatter blank-fill, tags union, body appended under a marker). DM can override to rename-with-suffix or skip.
