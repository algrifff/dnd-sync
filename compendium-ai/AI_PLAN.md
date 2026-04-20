# Compendium AI — Implementation Plan

> This document is the single source of truth for the AI layer build-out.
> Work against it phase by phase. Mark tasks complete inline as you go.
> All code must follow `.claude/rules/` — summarised at the bottom.

---

## What we are building

A domain-specific AI agent embedded in the Compendium note-taking app.
The agent understands TTRPG concepts natively, operates on the structured
knowledge graph of a campaign, and surfaces a chat pane where the DM or
players can create/edit entities, log sessions, and manage lore — all via
natural language tool calls. The AI does not free-style: every mutation
goes through the existing API surface and requires DM approval for
destructive session operations.

**Model:** OpenAI `gpt-4o-mini` via Vercel AI SDK (`@ai-sdk/openai`).
**Tool format:** Vercel AI SDK tool definitions (Zod-validated).
**Streaming:** SSE from `/api/chat/route.ts`.

---

## System architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Browser                                 │
│                                                                 │
│  ┌──────────────┐   ┌───────────────────────────────────────┐  │
│  │  FileTree    │   │           ChatPane (slide-in)         │  │
│  │  (sidebar)   │   │                                       │  │
│  │              │   │  [user message input]                 │  │
│  │  Campaigns/  │   │  [streaming assistant reply]          │  │
│  │    PCs/      │   │  [tool call cards — read-only]        │  │
│  │    NPCs/     │   │  [SessionReviewPanel — DM only]       │  │
│  │    Sessions/ │   └──────────────┬────────────────────────┘  │
│  └──────────────┘                  │ POST /api/chat             │
└───────────────────────────────────────────────────────────────-─┘
                                     │
                    ┌────────────────▼──────────────────┐
                    │         /api/chat/route.ts         │
                    │                                   │
                    │  1. Parse: groupId, campaignSlug, │
                    │     role, messages                │
                    │  2. Detect skills from last msg   │
                    │  3. Build system prompt           │
                    │  4. streamText() → OpenAI         │
                    │  5. Tool calls execute inline     │
                    └──────┬──────────────┬─────────────┘
                           │              │
              ┌────────────▼──┐    ┌──────▼──────────────┐
              │ lib/ai/       │    │ Existing API routes  │
              │ orchestrator  │    │                      │
              │ .ts           │    │ /api/notes/create    │
              │               │    │ /api/notes PATCH     │
              │ detectSkills()│    │ /api/notes/move      │
              │ buildPrompt() │    │ /api/search          │
              │ loadSkill()   │    │ /api/notes/sheet     │
              └──────┬────────┘    │ /api/sessions/close  │
                     │             │ /api/sessions/apply  │
              ┌──────▼────────┐    └──────────────────────┘
              │ lib/ai/       │
              │ skills/       │
              │  character.md │
              │  session.md   │
              │  item.md      │
              │  location.md  │
              │  lore.md      │
              │  note.md      │
              └───────────────┘
```

---

## Data model

### Existing tables (do not modify without a migration)

```
notes            — universal entity store (every character/session/item/location is a note)
  id, group_id, path, title,
  content_json   (ProseMirror doc),
  content_text   (plaintext, FTS-indexed),
  content_md     (Markdown export),
  yjs_state      (CRDT blob),
  frontmatter_json  { kind, template, campaigns[], sheet{} },
  dm_only        (0|1)

note_links       — wikilink backlink index (from_path → to_path)
characters       — indexed view of character frontmatter
campaigns        — indexed from Campaigns/<slug>/ folder structure
session_notes    — indexed from kind:session frontmatter
folder_markers   — explicit empty-folder records
assets           — content-addressed binary files
```

### New columns (Phase 3 migration)

```sql
-- session_notes additions for the close workflow
ALTER TABLE session_notes
  ADD COLUMN status       TEXT NOT NULL DEFAULT 'open';
  -- 'open' | 'review' | 'closed'

ALTER TABLE session_notes
  ADD COLUMN dm_review_json TEXT;
  -- JSON: proposed changes pending DM approval

ALTER TABLE session_notes
  ADD COLUMN closed_at  INTEGER;

ALTER TABLE session_notes
  ADD COLUMN closed_by  TEXT REFERENCES users(id);
```

### Canonical folder paths (system-protected)

These paths are enforced by `isSystemFolder()` in `lib/tree.ts` and
rendered read-only in `FileTree.tsx`. No delete, rename, or drag allowed.

```
Campaigns/                          ← top-level system folder
Campaigns/<slug>/                   ← campaign root (system)
Campaigns/<slug>/PCs/               ← player characters
Campaigns/<slug>/NPCs/              ← non-player characters
Campaigns/<slug>/Allies/            ← allied NPCs
Campaigns/<slug>/Villains/          ← antagonists
Campaigns/<slug>/Items/             ← items / loot
Campaigns/<slug>/Sessions/          ← session logs
Campaigns/<slug>/Locations/         ← locations / maps
Lore/                               ← world lore, factions, history
Assets/                             ← images, PDFs, videos
```

---

## AI data flow

### 1. Entity creation flow

```
User: "Add a new NPC called Mira, she's a halfling innkeeper in Thornhaven"
         │
         ▼
/api/chat  →  detectSkills("npc", "innkeeper")  →  ["character", "location"]
         │
         ▼
buildSystemPrompt({
  base: world/campaign context + tool list,
  skills: [character.md, location.md]   ← injected
})
         │
         ▼
gpt-4o-mini receives:
  - system: base + character skill + location skill
  - user message
  - tool definitions: entity_search, entity_create, backlink_create
         │
         ▼
AI tool call sequence:
  1. entity_search({ query: "Mira" })
     → [] (no duplicate found)
  2. entity_search({ query: "Thornhaven" })
     → [{ path: "Campaigns/dragonfall/Locations/thornhaven.md" }]
  3. entity_create({
       kind: "npc",
       name: "Mira",
       campaignSlug: "dragonfall",
       sheet: { name: "Mira", tagline: "halfling innkeeper", location: "Thornhaven" }
     })
     → { path: "Campaigns/dragonfall/NPCs/mira.md" }
  4. backlink_create({
       fromPath: "Campaigns/dragonfall/NPCs/mira.md",
       toPath:   "Campaigns/dragonfall/Locations/thornhaven.md"
     })
         │
         ▼
AI text reply: "Done — Mira is in the NPCs folder, linked to Thornhaven."
```

### 2. Session close flow (human-in-the-loop)

```
DM: "Close out session 5"
         │
         ▼
AI calls session_close({ sessionPath: "Campaigns/dragonfall/Sessions/session-5.md" })
         │
         ▼
/api/sessions/close  POST
  - Reads full session note content
  - Extracts via structured AI call:
      characters mentioned → location changes
      items gained/lost
      NPC status changes (alive/dead/fled)
      quest updates
  - Builds dm_review_json:
      {
        "character_updates": [
          { "path": "Campaigns/.../PCs/aldric.md",
            "field": "sheet.location", "from": "Thornhaven", "to": "Ashford" }
        ],
        "inventory_changes": [
          { "character": "aldric", "add": ["Sword of Mourning"] }
        ],
        "npc_updates": [
          { "path": ".../NPCs/garrick.md", "field": "sheet.status", "to": "fled" }
        ],
        "new_backlinks": [
          { "from": "session-5.md", "to": "sword-of-mourning.md" }
        ]
      }
  - Sets session_notes.status = 'review'
  - Returns proposed delta to chat
         │
         ▼
ChatPane renders <SessionReviewPanel>
  - Shows each proposed change with accept/reject toggle per item
  - DM edits if needed
  - Clicks "Apply"
         │
         ▼
/api/sessions/apply  POST  { sessionPath, approvedChanges }
  - Wraps in DB transaction:
      UPDATE frontmatter on each character/NPC
      INSERT backlinks
      UPDATE session_notes.status = 'closed'
      UPDATE session_notes.closed_at / closed_by
  - router.refresh() → tree and notes update
```

### 3. Orchestrator skill injection flow

```
User message arrives
         │
         ▼
detectSkills(message: string) → string[]

  SKILL_TRIGGERS = {
    character: ["character","pc","npc","ally","villain","player",
                "stats","hp","level","inventory","portrait"],
    session:   ["session","log","notes","today","recap",
                "attendees","close","end session"],
    item:      ["item","sword","weapon","armor","loot",
                "treasure","gave","picked up","dropped"],
    location:  ["location","city","town","dungeon","map",
                "region","travel","landmark"],
    lore:      ["quest","lore","faction","history","rumour",
                "prophecy","myth","legend"],
    note:      []   // fallback — always available
  }

  Returns: matched skill keys (1–3 typical)
         │
         ▼
buildSystemPrompt({
  groupId, campaignSlug, role, skills
})

  BASE PROMPT (~350 tokens):
    - World name, active campaign, session status
    - User role: "dm" or "player"
    - Tool list summary (names + one-line descriptions)
    - Three non-negotiable rules:
        1. Always entity_search before entity_create
        2. Always confirm session_close before committing
        3. Never set dm_only=false on Villain notes

  + INJECTED SKILLS (each ~200–350 tokens):
    character.md | session.md | item.md | location.md | lore.md

  Total context budget: 600–1100 tokens (vs 3000 monolithic)
         │
         ▼
streamText({ model, system, messages, tools, maxSteps: 8 })
```

---

## File structure to create

```
server/src/
├── app/
│   ├── api/
│   │   ├── chat/
│   │   │   └── route.ts            ← Phase 4: streaming chat endpoint
│   │   └── sessions/
│   │       ├── close/
│   │       │   └── route.ts        ← Phase 3: propose session delta
│   │       └── apply/
│   │           └── route.ts        ← Phase 3: commit approved delta
│   └── notes/
│       ├── ChatPane.tsx            ← Phase 5: slide-in chat UI
│       └── SessionReviewPanel.tsx  ← Phase 5: DM review UI
└── lib/
    ├── ai/
    │   ├── orchestrator.ts         ← Phase 4: detectSkills + buildPrompt
    │   ├── paths.ts                ← Phase 1: canonicalPath()
    │   ├── tools.ts                ← Phase 2: all tool definitions
    │   └── skills/
    │       ├── character.md        ← Phase 2
    │       ├── session.md          ← Phase 2
    │       ├── item.md             ← Phase 2
    │       ├── location.md         ← Phase 2
    │       ├── lore.md             ← Phase 2
    │       └── note.md             ← Phase 2
    └── migrations.ts               ← Phase 3: session_notes additions
```

---

## Tool definitions (complete spec)

Each tool is defined in `lib/ai/tools.ts` using Vercel AI SDK's `tool()` helper
with a Zod schema. The AI SDK validates inputs before execution.

```typescript
// Tool: entity_search
// Always call this before entity_create to prevent duplicates.
{
  name: "entity_search",
  description: "Search for existing entities by name or keywords before creating anything.",
  parameters: z.object({
    query:      z.string().describe("Name or keywords to search"),
    kind:       z.enum(["pc","npc","ally","villain","item","location","session","lore","any"])
                 .optional().default("any"),
    campaignSlug: z.string().optional()
  }),
  execute: async ({ query, kind, campaignSlug }) => {
    // → GET /api/search?q=query&campaignSlug=...
    // Returns: [{ path, title, kind, snippet }]
  }
}

// Tool: entity_create
// Creates a new structured note at the canonical path for its kind.
// Path is ALWAYS derived from canonicalPath() — never passed in by the AI.
{
  name: "entity_create",
  description: "Create a new entity (character, item, location, etc.). Path is auto-assigned.",
  parameters: z.object({
    kind:         z.enum(["pc","npc","ally","villain","item","location","session","lore","note"]),
    name:         z.string(),
    campaignSlug: z.string().optional(),
    sheet:        z.record(z.unknown()).optional().describe("Frontmatter sheet fields"),
    dmOnly:       z.boolean().optional().default(false)
  }),
  execute: async ({ kind, name, campaignSlug, sheet, dmOnly }) => {
    const folder = canonicalPath({ kind, campaignSlug });
    // → POST /api/notes/create { folder, name, kind, sheet, dmOnly }
    // Returns: { path, title }
  }
}

// Tool: entity_edit_sheet
// Update structured frontmatter fields on an existing entity.
{
  name: "entity_edit_sheet",
  description: "Update structured fields (stats, location, inventory) on an existing entity.",
  parameters: z.object({
    path:    z.string().describe("Full note path"),
    updates: z.record(z.unknown()).describe("Field key→value pairs to set")
  }),
  execute: async ({ path, updates }) => {
    // → PATCH /api/notes/sheet { path, updates }
  }
}

// Tool: entity_edit_content
// Append text to the prose body of a note (does not overwrite).
{
  name: "entity_edit_content",
  description: "Append prose content to a note's body. Use for session logs, journal entries.",
  parameters: z.object({
    path:    z.string(),
    content: z.string().describe("Markdown content to append"),
    heading: z.string().optional().describe("Optional section heading to prepend")
  }),
  execute: async ({ path, content, heading }) => {
    // → PATCH /api/notes/[path] with content delta
  }
}

// Tool: entity_move
// Rename or move a note. Only for user-created content, not system folders.
{
  name: "entity_move",
  description: "Move or rename a note to a new path.",
  parameters: z.object({
    from: z.string(),
    to:   z.string()
  }),
  execute: async ({ from, to }) => {
    // → POST /api/notes/move { from, to }
  }
}

// Tool: backlink_create
// Ensure a [[wikilink]] exists from one note to another.
{
  name: "backlink_create",
  description: "Create a wikilink from one note to another, recording the relationship.",
  parameters: z.object({
    fromPath: z.string(),
    toPath:   z.string(),
    label:    z.string().optional()
  }),
  execute: async ({ fromPath, toPath, label }) => {
    // Appends [[toPath|label]] to fromPath content if not already present
    // → PATCH /api/notes/[fromPath]
  }
}

// Tool: inventory_add
// Add an item to a character's inventory sheet field.
{
  name: "inventory_add",
  description: "Add an item to a character's inventory. Prefer itemPath over freeformName.",
  parameters: z.object({
    characterPath: z.string(),
    itemPath:      z.string().optional().describe("Path to an Item entity note"),
    freeformName:  z.string().optional().describe("Fallback: plain text item name"),
    quantity:      z.number().int().positive().optional().default(1)
  }),
  execute: async ({ characterPath, itemPath, freeformName, quantity }) => {
    // Appends to sheet.items[] via entity_edit_sheet
  }
}

// Tool: session_close
// Analyse a session and produce a proposed delta for DM review.
// NEVER auto-applies. Always waits for session_apply.
{
  name: "session_close",
  description: "Analyse the session and produce a proposed set of changes for DM review. Does NOT commit anything.",
  parameters: z.object({
    sessionPath: z.string()
  }),
  execute: async ({ sessionPath }) => {
    // → POST /api/sessions/close { sessionPath }
    // Returns: dm_review_json (proposed changes)
    // Sets session status = 'review'
  }
}

// Tool: session_apply
// Commit DM-approved changes from a session review.
{
  name: "session_apply",
  description: "Commit the DM-approved session changes. Only call after DM has reviewed.",
  parameters: z.object({
    sessionPath:     z.string(),
    approvedChanges: z.array(z.object({
      id:       z.string(),
      approved: z.boolean()
    }))
  }),
  execute: async ({ sessionPath, approvedChanges }) => {
    // → POST /api/sessions/apply { sessionPath, approvedChanges }
  }
}
```

### Role-based tool access

```typescript
// DM gets all tools
// Players get a restricted set — no session close, no dm_only edits
export function getToolsForRole(role: 'dm' | 'player') {
  const all = [
    entity_search, entity_create, entity_edit_sheet,
    entity_edit_content, entity_move, backlink_create,
    inventory_add, session_close, session_apply
  ];
  if (role === 'dm') return all;
  return [entity_search, entity_create, entity_edit_content,
          entity_edit_sheet, inventory_add, backlink_create];
}
```

---

## Skill files (content spec)

Each file is loaded as a string and injected into the system prompt.
Keep each under 400 tokens. Declarative rules only — no prose explanation.

### `skills/character.md`
```
## Character Skill

Rules:
- ALWAYS call entity_search before entity_create (check for duplicates by name)
- PC path:      Campaigns/{slug}/PCs/{name}.md
- NPC path:     Campaigns/{slug}/NPCs/{name}.md
- Ally path:    Campaigns/{slug}/Allies/{name}.md
- Villain path: Campaigns/{slug}/Villains/{name}.md
- Required PC fields:  name, level, class, race
- Required NPC fields: name, tagline
- Never set dmOnly=false on Villain notes
- When inventory changes: call inventory_add, not entity_edit_sheet directly
- After creating any character, call backlink_create linking them to their
  current location if a location entity exists
```

### `skills/session.md`
```
## Session Skill

Rules:
- Session path: Campaigns/{slug}/Sessions/session-{N}-{title-slug}.md
- Required fields: date (YYYY-MM-DD), session_number, attendees[]
- Use entity_edit_content to append player notes (never overwrite)
- session_close ONLY produces a proposal — always tell the user to review it
- Do NOT call session_apply without explicit DM instruction "apply" or "commit"
- After session_close, describe proposed changes in plain language before
  showing the review panel
- If a session is already status=closed, refuse to reopen without DM confirmation
```

### `skills/item.md`
```
## Item Skill

Rules:
- Item path: Campaigns/{slug}/Items/{name}.md
- Required fields: name, type, rarity
- Valid type values: weapon, armor, wondrous, potion, scroll, tool, treasure, other
- Valid rarity: common, uncommon, rare, very rare, legendary, artifact
- When a character receives an item: call inventory_add with itemPath
- When creating loot for a session: create the Item entity first, then assign
- DM-created items for villains/secret: set dmOnly=true
```

### `skills/location.md`
```
## Location Skill

Rules:
- Location path: Campaigns/{slug}/Locations/{name}.md
- Required fields: name, type
- Valid type: city, town, village, dungeon, wilderness, landmark, plane, other
- After creating a location, check if any existing NPCs reference it by name
  and call backlink_create to connect them
- When a character moves to a location: call entity_edit_sheet on the character
  with { location: "[[Location Name]]" }
```

### `skills/lore.md`
```
## Lore Skill

Rules:
- Lore lives in Lore/ (world-level) or Campaigns/{slug}/ (campaign-level)
- No required fields — freeform prose note is fine
- Tag lore notes with #quest, #faction, #history as appropriate
- Call backlink_create to connect lore entries to relevant characters/locations
- Quests should reference the characters involved via wikilinks
```

### `skills/note.md`
```
## General Note Skill

Rules:
- Freeform notes go in the most contextually relevant folder
- If no campaign context: use Lore/
- Always set a meaningful title
- Use wikilinks [[EntityName]] to reference other entities inline
- Prefer appending to existing notes over creating duplicates
```

---

## Phase implementation order

### Phase 1 — Canonical paths ✅ (tree.ts + FileTree.tsx done)

- [x] `isSystemFolder()` in `lib/tree.ts`
- [x] `TreeDir.system` flag propagated through tree build
- [x] System folders: no drag, no RowMenu, lock icon on hover, small-caps label
- [x] Removed redundant `Characters/` intermediate folder
- [x] Added `Items/` to default skeleton
- [ ] **TODO:** `lib/ai/paths.ts` — `canonicalPath({ kind, campaignSlug, name })` function

### Phase 2 — Tool definitions + skill files

- [ ] `lib/ai/tools.ts` — all 9 tool definitions with Zod schemas
- [ ] `lib/ai/skills/character.md`
- [ ] `lib/ai/skills/session.md`
- [ ] `lib/ai/skills/item.md`
- [ ] `lib/ai/skills/location.md`
- [ ] `lib/ai/skills/lore.md`
- [ ] `lib/ai/skills/note.md`

### Phase 3 — Session close workflow

- [ ] Migration v17: add `status`, `dm_review_json`, `closed_at`, `closed_by` to `session_notes`
- [ ] `POST /api/sessions/close/route.ts` — analyse session, return proposed delta, set status='review'
- [ ] `POST /api/sessions/apply/route.ts` — commit approved changes in a transaction
- [ ] `lib/sessions.ts` additions: `closeSession()`, `applySessionChanges()`

### Phase 4 — Orchestrator + chat route

- [ ] `lib/ai/orchestrator.ts` — `detectSkills()`, `buildSystemPrompt()`, `loadSkill()`
- [ ] Install: `bun add ai @ai-sdk/openai` in server package
- [ ] `app/api/chat/route.ts` — streaming endpoint using `streamText()`
- [ ] Add `OPENAI_API_KEY` to `.env.example` and env loading

### Phase 5 — Chat UI

- [ ] `app/notes/ChatPane.tsx` — slide-in panel, role-aware, streaming
- [ ] `app/notes/SessionReviewPanel.tsx` — per-change approve/reject, Apply button
- [ ] Wire ChatPane toggle into `NoteSidebar.tsx` or global layout
- [ ] Tool call cards rendered inline in chat (entity created, backlink added, etc.)

---

## `lib/ai/paths.ts` spec (Phase 1 remaining task)

```typescript
// The canonical path resolver. Every AI tool call that creates a note
// MUST derive the path from this function — never accept a path from the AI.

export type EntityKind =
  | 'pc' | 'npc' | 'ally' | 'villain'
  | 'item' | 'location' | 'session' | 'lore' | 'note';

export function canonicalFolder(opts: {
  kind: EntityKind;
  campaignSlug?: string;
}): string {
  const slug = opts.campaignSlug;
  const base = slug ? `Campaigns/${slug}` : null;

  switch (opts.kind) {
    case 'pc':       return base ? `${base}/PCs`       : 'Characters/PCs';
    case 'npc':      return base ? `${base}/NPCs`      : 'Characters/NPCs';
    case 'ally':     return base ? `${base}/Allies`    : 'Characters/Allies';
    case 'villain':  return base ? `${base}/Villains`  : 'Characters/Villains';
    case 'item':     return base ? `${base}/Items`     : 'Items';
    case 'location': return base ? `${base}/Locations` : 'Lore/Locations';
    case 'session':  return base ? `${base}/Sessions`  : 'Sessions';
    case 'lore':     return 'Lore';
    case 'note':     return base ?? 'Lore';
  }
}

export function canonicalPath(opts: {
  kind: EntityKind;
  campaignSlug?: string;
  name: string;
}): string {
  const folder = canonicalFolder({ kind: opts.kind, campaignSlug: opts.campaignSlug });
  const slug = opts.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${folder}/${slug}.md`;
}
```

---

## `/api/chat/route.ts` spec (Phase 4)

```typescript
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { z } from 'zod';
import { requireSession } from '@/lib/session';
import { getToolsForRole } from '@/lib/ai/tools';
import { detectSkills, buildSystemPrompt } from '@/lib/ai/orchestrator';

const BodySchema = z.object({
  messages:     z.array(z.object({ role: z.string(), content: z.string() })),
  groupId:      z.string(),
  campaignSlug: z.string().optional(),
});

export async function POST(req: Request): Promise<Response> {
  const session = await requireSession();   // throws 401 if not authed
  const body = BodySchema.parse(await req.json());

  const lastMsg = body.messages.findLast((m) => m.role === 'user')?.content ?? '';
  const skills  = detectSkills(lastMsg);
  const role    = session.role === 'admin' || session.role === 'editor' ? 'dm' : 'player';

  const result = streamText({
    model: openai('gpt-4o-mini'),
    system: buildSystemPrompt({
      groupId:      body.groupId,
      campaignSlug: body.campaignSlug,
      role,
      skills,
    }),
    messages: body.messages,
    tools:    getToolsForRole(role),
    stopWhen: stepCountIs(8),   // AI SDK v6: replaces maxSteps
  });

  return result.toUIMessageStreamResponse();  // AI SDK v6: replaces toDataStreamResponse
}
```

---

## Design rules (from `.claude/design/CLAUDE.md`)

The app follows a Notion-inspired warm editorial system. Apply these when
building the ChatPane and SessionReviewPanel:

| Token | Value | Usage |
|-------|-------|-------|
| Canvas | `#FBF5E8` | Chat pane background |
| Text primary | `#2A241E` | Messages, headings |
| Text secondary | `#5A4F42` | Tool call labels, metadata |
| Accent gold | `#D4A85A` | Hover states, active rows |
| Danger | `#8B4A52` | Delete, reject actions |
| Border | `#D4C7AE` | Dividers, panel edges |
| Shadow | `0 8px 24px rgba(42,36,30,0.12)` | Floating panels |

- Border-first surfaces, minimal shadow
- Rounded corners: `rounded-[6px]` for rows, `rounded-[8px]` for panels
- Tool call cards: soft tinted background, not saturated fills
- Session review items: show proposed change in warm-gray card,
  green checkmark / red X toggle per item

---

## Coding rules (from `.claude/rules/`)

### Backend (`**/api/**`)
- Error shape: `{ code, message, details }` — always
- Validate all inputs at the boundary with Zod
- Authn ≠ Authz: `requireSession()` + verify group membership separately
- No stack traces in responses
- Rate-limit the `/api/chat` endpoint (inherit existing `ratelimit.ts`)

### Database (`migrations.ts`)
- One logical change per migration, forward-only
- Each migration wrapped in a transaction (existing pattern)
- Never modify existing migrations — always add a new version
- Use parameterized queries exclusively

### Frontend (`**/*.tsx`)
- Named exports for all components
- Explicit return types: `(): React.JSX.Element`
- No inline styles except dynamic values (`paddingLeft`, `color`)
- `React.memo()` on `SessionReviewPanel` (re-renders from streaming)
- Mobile-first: ChatPane should be a drawer on small screens

### Security
- `OPENAI_API_KEY` in env only — never in source
- Validate `groupId` against session's `current_group_id` in `/api/chat`
- Strip tool outputs before sending to client if they contain dm_only content
  and the caller is a player

### Testing
- AAA pattern for all tool execute() functions
- Integration tests for session_close and session_apply (they touch multiple tables)
- Mock the OpenAI client, not the tool execute functions

---

## Environment variables to add

```bash
# .env.example additions
OPENAI_API_KEY=sk-...          # required for AI chat
OPENAI_MODEL=gpt-4o-mini       # override for testing with cheaper model
AI_MAX_STEPS=8                 # max tool call chain length per request
```

---

## Open questions (decide before Phase 3)

1. **Session analysis model** — should `session_close` call OpenAI internally
   to extract the delta, or use a deterministic regex/NLP pass? OpenAI is more
   accurate but adds latency + cost. Recommend: OpenAI with `gpt-4o-mini` and
   a structured output schema.

2. **Player note privacy** — if a player appends to a session note and marks
   it `dm_only`, should the AI be able to read it? Current assumption: no —
   the AI respects the `dm_only` flag based on the caller's role.

3. **Undo** — should the chat log record which notes were modified so the AI
   can offer "undo last action"? Not in scope for Phase 5 but worth noting.

4. **Data migration** — existing vaults with `Characters/PCs/` intermediate
   paths (old default folder structure) need a one-off migration to move notes
   to `PCs/` etc. Build this as an optional admin action, not an auto-migration.
