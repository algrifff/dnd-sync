# AI-assisted import — plan

> Drop any folder (Obsidian, Google Docs export, loose `.md`, whatever) and
> the server runs a two-pass ingest: classical parse, then an OpenAI pass
> that classifies every note, extracts structured frontmatter, pairs images
> with their owners, auto-tags, and proposes vault paths. The DM reviews —
> "Accept all" in one click, or pick through edits — and the apply step
> writes through the existing derive pipeline so graph / backlinks /
> dashboards all light up together.

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

## 8. Review screen

`/settings/import/:id`, admin-only. Table, one row per note:

```
☑ lumen.md              → Campaigns/…/Characters/Allies/Lumen Flumen.md  [ally] · Aasimar Cleric 5 · 3 tags · 2 links · 📷 lumen_portrait.jpg
☐ random-note.md        → <no confident classification — stays as plain page>
☑ session-2024-03-14.md → Campaigns/…/Sessions/2024-03-14.md              [session] · 3 attendees
⚠ atoxis.md             → Campaigns/…/Characters/Villains/Atoxis.md       [conflict: existing note; will merge]
```

Row actions: accept / reject, edit path (typeahead), override kind, expand to tweak sheet JSON, hover a link to see the anchor.

Bulk actions: **Accept all** (default happy path), accept all above X confidence, reject all "plain", re-run AI on selected rows.

The job-level header has the target-campaign picker + total token budget spent.

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
| **1a** | Migration + API scaffold (upload / get / cancel), temp-file handling |
| **1b** | Classical parse pass (reuses existing ingest helpers); review page shows the pre-AI plan |
| **1c** | OpenAI client + skill + structured-output schema + retry + cost accounting |
| **1d** | Review UI with per-row accept / edit / reject + "Accept all" |
| **1e** | Apply step: file moves, frontmatter merge, wikilink rewrites, image pairing, merge-on-conflict |
| **1f** | Live progress + token/cost display + mid-analyse cancel |
| **2**  | `.docx` ingest, batched prompting for tiny notes to drop cost, on-demand re-analysis of a subset |

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
