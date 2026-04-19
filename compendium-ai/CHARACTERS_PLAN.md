# Characters, templates, campaigns — plan

> Plan for the D&D-specific structure layered over the generic vault.
> Decisions locked in §7; implementation proceeds in phases from §6.

---

## 1. The shape of the world

```
server                              (global scope)
 └── note_templates                 (one per kind, shared across all worlds)

group (= vault = world)
 ├── users           (players + admins)
 ├── campaigns       (auto-discovered from folder structure)
 ├── notes           (all pages — structured notes carry typed frontmatter)
 ├── characters      (derived index of character-kind notes)
 └── sessions        (derived index of session-kind notes — Phase 2)
```

- **World** = vault (existing `groups` row).
- **Campaign** = first-class entity, auto-discovered from `Campaigns/<n>/…` paths. Editable display name, but the slug is driven by the folder.
- **Structured note** = a note whose frontmatter declares `kind:` (`character` with a `role:` sub-kind, or `session`). The body stays free-form prose; the frontmatter carries the typed fields. Covers PCs, NPCs, Allies, Villains, Sessions, and future kinds (Locations, Items, Quests).
- **Template** = admin-owned schema definition. Declares what fields exist for a given kind. Shared **across all worlds on the server** — many campaigns will want the same 5e PC sheet or the same session-log shape, and admins shouldn't have to re-seed per world. Players never see or edit templates.

### Why "character is a note + index table"

The note is the source of truth — that way file moves (NPC → Villain), collab sync, backlinks, and the graph all keep working without any new machinery. The `characters` table is **derived** on note save, cached for fast queries ("all PCs owned by alex across all campaigns"). If the table ever drifts we just rebuild from frontmatter.

---

## 2. Data model

### New tables (migration v13)

```sql
-- Schema definitions. Global — shared across every world. Admin-only
-- write (any admin in any group can CRUD; small self-hosted
-- deployment with one DM is the usual shape).
note_templates (
  kind TEXT PRIMARY KEY,            -- 'pc' | 'npc' | 'ally' | 'villain' | 'session'
  name TEXT NOT NULL,               -- "D&D 5e PC"
  schema_json TEXT NOT NULL,        -- sections + fields (see §3)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES users(id)
);

-- Campaigns. Auto-created when a note is saved under Campaigns/<name>/.
campaigns (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,               -- derived from folder name
  name TEXT NOT NULL,               -- editable display name
  folder_path TEXT NOT NULL,        -- 'Campaigns/Campaign 3'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, slug)
);

-- Character index. Derived from note frontmatter on every save.
characters (
  group_id TEXT NOT NULL,
  note_path TEXT NOT NULL,
  kind TEXT NOT NULL,                        -- 'pc' | 'npc' | 'ally' | 'villain'
  player_user_id TEXT REFERENCES users(id),  -- null for NPC/ally/villain
  display_name TEXT NOT NULL,
  portrait_path TEXT,                        -- vault path to portrait asset
  -- Denormalised subset of commonly-queried sheet fields:
  level INTEGER,
  class TEXT,
  race TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, note_path),
  FOREIGN KEY (group_id, note_path)
    REFERENCES notes(group_id, path) ON DELETE CASCADE
);

-- Many-to-many: crossover characters appear in >1 campaign.
character_campaigns (
  group_id TEXT NOT NULL,
  note_path TEXT NOT NULL,
  campaign_slug TEXT NOT NULL,
  PRIMARY KEY (group_id, note_path, campaign_slug),
  FOREIGN KEY (group_id, note_path)
    REFERENCES characters(group_id, note_path) ON DELETE CASCADE
);

-- Per-user pin.
ALTER TABLE users ADD COLUMN active_character_path TEXT;
```

**Sessions (migration v14, Phase 2):** a mirror of the characters
index, keyed by note path, with `session_date`, `campaign_slug`,
`attendees` (json), and `summary`. Same derive-on-save pattern. The
session template lives in `note_templates` from day one so admins
can shape it before the UI lands.

### Frontmatter contract (what a character note looks like on disk)

```yaml
---
kind: character
role: pc                     # pc | npc | ally | villain. Defaults from folder.
template: dnd5e-pc           # template id; set from role on creation
player: alex                 # username, PC only
campaigns: [campaign-3]      # authoritative. Folder is a hint, not truth.
portrait: Campaign 3/Assets/Portraits/lumen_portrait.jpg
sheet:                       # flat map. Keys match template field ids.
  name: Lumen Flumen
  level: 5
  class: Cleric
  race: Aasimar
  background: Acolyte
  str: 14
  dex: 12
  con: 15
  int: 10
  wis: 18
  cha: 13
  hp_max: 38
  hp_current: 38
  ac: 18
  speed: 30
---
The moon in human form, raised alongside a sun-kissed paladin...
```

`sheet` is flat-keyed. Sections are a template concept (grouping for UI), not storage.

### Derivation on save (hooked into the existing derive pipeline)

When a note is saved:

1. Parse frontmatter; if `kind: character`, compute `role`:
   - Explicit `role:` wins.
   - Else infer from path: `**/PCs/**` → `pc`, `**/NPCs/**` → `npc`, `**/Allies/**` → `ally`, `**/Villains/**` → `villain`.
   - Fallback `npc`.
2. Upsert `characters` row with derived `level` / `class` / `race` / `display_name` / `portrait_path`.
3. Replace `character_campaigns` rows from frontmatter `campaigns:` list.
4. If the note's path is under `Campaigns/<slug>/`, ensure a `campaigns` row exists.

### Folder convention (suggested, not enforced)

```
<vault>/
  Campaigns/
    Campaign 3/
      Characters/
        PCs/                        ← player characters for this campaign
        NPCs/
        Allies/
        Villains/
      Sessions/
      Locations/
  Recurring/
    Characters/                     ← villains etc. reused across campaigns
```

PCs live under their campaign folder. If a player wants the same PC in two campaigns (rare), either duplicate the note or add `campaigns: [c2, c3]` frontmatter and pick one canonical folder.

Admins can organise differently; `campaigns:` frontmatter is what actually binds. The folder convention is what the "+ New character" button and the kind-inference fallbacks assume.

---

## 3. Template anatomy (what admins edit)

`character_templates.schema_json` shape:

```json
{
  "version": 1,
  "sections": [
    {
      "id": "basics",
      "label": "Basics",
      "fields": [
        { "id": "name",   "label": "Name",  "type": "text", "required": true },
        { "id": "level",  "label": "Level", "type": "integer", "min": 1, "max": 20, "default": 1 },
        { "id": "class",  "label": "Class", "type": "text" },
        { "id": "race",   "label": "Race",  "type": "text" }
      ]
    },
    {
      "id": "abilities",
      "label": "Ability scores",
      "fields": [
        { "id": "str", "label": "STR", "type": "integer", "min": 1, "max": 30, "default": 10 },
        { "id": "dex", "label": "DEX", "type": "integer", "min": 1, "max": 30, "default": 10 },
        { "id": "con", "label": "CON", "type": "integer", "min": 1, "max": 30, "default": 10 },
        { "id": "int", "label": "INT", "type": "integer", "min": 1, "max": 30, "default": 10 },
        { "id": "wis", "label": "WIS", "type": "integer", "min": 1, "max": 30, "default": 10 },
        { "id": "cha", "label": "CHA", "type": "integer", "min": 1, "max": 30, "default": 10 }
      ]
    },
    {
      "id": "combat",
      "label": "Combat",
      "fields": [
        { "id": "hp_max",     "label": "HP max",     "type": "integer", "min": 1 },
        { "id": "hp_current", "label": "HP current", "type": "integer", "min": 0, "playerEditable": true },
        { "id": "ac",         "label": "AC",         "type": "integer", "min": 0, "default": 10 },
        { "id": "speed",      "label": "Speed",      "type": "integer", "default": 30 }
      ]
    }
  ]
}
```

### Supported field types (v1)

- `text` — single line
- `longtext` — multiline (short prose, not the main body)
- `integer` — with optional `min` / `max`
- `number` — float
- `enum` — `options: ["yes", "no"]`
- `boolean`
- `list<text>` — simple tag-like list (inventory entries, languages)

Each field may carry: `id`, `label`, `type`, `required`, `default`, `min`, `max`, `options`, `hint`, `playerEditable`.

**Deferred to v2:** computed fields (proficiency bonus, ability modifiers), list-of-objects (spells, attacks with structure), conditional visibility.

### Template evolution

When an admin edits a template:

- **Add field**: characters show it blank until filled (uses `default` if set).
- **Remove field**: value preserved in frontmatter, hidden from UI. Surfaces in an "orphaned fields" block at the bottom of the sheet so nothing is ever silently destroyed.
- **Rename `id`**: treated as remove + add. User intervention needed for the rename. (We can add an explicit "rename" op later.)
- **Change type**: value preserved; sheet shows "incompatible value" with a "reset to default" button.

### Seed on server first boot

Templates are server-global, so seeding runs once at startup, not per group. On first boot (when the `note_templates` table is empty) we insert:

- **PC** — the minimal 5e sheet above (basics, abilities, combat)
- **NPC** — name, role tagline, portrait, notes (+ optional stat block subset)
- **Ally** — NPC + disposition, trust
- **Villain** — NPC + ambitions, resources
- **Session** — date, attendees, locations visited, summary, outcomes

Any admin can tailor any of these from `/settings/templates`. Edits affect every world on the server.

---

## 4. Permissions

The existing three roles stay — `admin` (DM), `editor` (co-DM), `viewer` (player) — but viewers pick up a creator-ownership overlay that lets them edit what they make.

| Action | Admin | Editor | Viewer (player) |
|--|--|--|--|
| View any note / character | ✓ | ✓ | ✓ |
| Edit any note / character | ✓ | ✓ | |
| Edit notes they created (`created_by` match) | ✓ | ✓ | ✓ |
| Edit their own PC (HP, items, inventory, backstory) | ✓ | ✓ | ✓ |
| Edit another player's PC | ✓ | ✓ | |
| Edit `playerEditable` fields on any character (e.g. HP) | ✓ | ✓ | ✓ |
| CRUD templates | ✓ | | |
| See `/settings/templates` | ✓ | | |
| Create / rename campaign | ✓ | ✓ | |

"Own PC" = frontmatter `player:` matches your username. All of the above is enforced **server-side** in the collab save hook, not just in the UI — a player editing raw yaml can't bypass it because save rejects.

HP current, conditions, death saves etc. are common shared-write fields during a session. Template fields carry `playerEditable: true` to open them to edits by any authenticated user regardless of PC ownership.

---

## 5. UX flows

### Admin: template editor (`/settings/templates`)

- Left rail lists kinds (PC / NPC / Ally / Villain).
- Each shows the current template; click to edit.
- Edit UI: sections as draggable cards, fields as rows. Add / remove / reorder. Change type. Save.
- Live preview on the right — renders the current schema as the character sheet would look (no real data, just defaults).
- Only `admin`-role users can reach this page; middleware gate + route guard.

### Player: character dashboard (`/characters`)

- Your PCs across all campaigns, grouped by campaign.
- Each card: portrait, name, level/class, campaign badges, "Open sheet" / "Set active".
- "+ New character" button (if any campaign is picked, drops into its PCs folder; else to `/PCs`).

### Any viewer: character sheet on note page

- Note page detects `kind: character` from frontmatter.
- Above the prose, renders a **sheet card** built from the template schema:
  - Portrait (top), name + level/class tagline below it
  - Section tabs: Basics, Abilities, Combat…
  - Edit in place (form controls)
  - Edit permissions respected per-field (greyed out if not yours)
- Below the sheet: normal markdown prose editor for backstory.
- Bottom of sheet: "orphaned fields" block if the template changed under you.

### Left sidebar: active-character block (top, above the file tree)

- Dedicated section at the top of the left sidebar (above the file tree, below the sidebar header).
- Shows portrait + name/class of your active character.
- Dropdown lists all your PCs across campaigns; picking one sets it as active and persists to `users.active_character_path`.
- Clicking the block opens the active character's sheet.
- "None" option clears the active character.
- State is per-user and persists across sessions.

### File tree

- Character-kind notes get an icon (sword for PC, skull for villain, heart for ally, face for NPC).
- Templates are not notes — they don't appear in the tree at all.

### Graph

- PCs rendered as star nodes.
- Villains / allies get their kind-colour baked in, editable via the existing group colour overrides.

---

## 6. Phased delivery

One commit per bullet.

### Phase 1 — Player characters

| # | Title | What lands |
|--|--|--|
| **1a** | Schema + defaults | Migration v13, global `note_templates` table, seed PC / NPC / Ally / Villain / Session templates on first boot |
| **1b** | Derive pipeline + permission overlay | Hook into the existing save-derive path: parse frontmatter, maintain `characters` + `character_campaigns` + `campaigns` tables; apply the creator-ownership + PC-ownership + `playerEditable` checks in the collab save hook |
| **1c** | Admin template editor | `/settings/templates` page, CRUD UI, live preview. Visible only to `admin` role. |
| **1d** | Character sheet on note page | Detect `kind: character`, render sheet above prose, form binds to frontmatter via Y.Doc, per-field permissions enforced |
| **1e** | Sidebar active-character block + `/characters` dashboard | Dedicated block at the top of the left sidebar with dropdown switcher; `/characters` page listing your PCs grouped by campaign |
| **1f** | Creation flow + folder niceties | "+ New character" buttons inside `Characters/*` folders, folder inference, file-tree kind icons |

1b through 1f each depend on 1a + 1b. 1c–1f can be done in sequence but reviewed independently.

### Phase 2 — Sessions

Session notes get their own index (`sessions` table, migration v14), their own kind-icon treatment, and a `/sessions` per-campaign dashboard (chronological list, "+ New session" seeded from today's date). Template already exists from Phase 1a seed so admins can shape the schema before the UI lands.

### Phase 3 — Assets gallery

`/assets` grid with filters (portraits, tokens, maps), click-through to embedding notes.

### Phase 4 — DM layer + session-run mode

DM-only visibility flag on notes, initiative tracker, HP board, quick-access NPC cards during a live session.

---

## 7. Decisions (locked in)

1. **One template per kind.** Admin edits it; grows to multi-template-per-kind only if a real need surfaces.

2. **PCs live under their campaign** at `Campaigns/<name>/Characters/PCs/<player>.md`. Active character is surfaced in a dedicated block at the top of the left sidebar (above the file tree), with a dropdown to switch, persisted to `users.active_character_path`. This replaces the top-nav chip idea.

3. **Player (`viewer` role) can edit:**
   - Any note they created (`created_by` match)
   - Their own PC fully — HP, items, inventory, backstory prose
   - `playerEditable` fields on any character (shared combat state like HP-current, conditions)

   Enforced server-side in the collab save hook. No raw-yaml bypass.

4. **Templates are server-global, not per-world.** Different campaigns on the same server will usually want the same 5e PC sheet / the same session-log shape; admins shouldn't have to re-seed per world. Any `admin`-role user on any world can CRUD them. If a single deployment ever hosts truly divergent game systems we can introduce per-group overrides later without breaking the global default.

5. **Sessions are in the same system.** `session` is a seeded kind from day one so admins can shape its template alongside the character kinds; the UI and dedicated `sessions` index table land in Phase 2.
