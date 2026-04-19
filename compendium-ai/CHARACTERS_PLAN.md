# Characters, templates, campaigns — plan

> Draft plan for the D&D-specific structure layered over the generic vault.
> Four open questions at the bottom need a decision before implementation.

---

## 1. The shape of the world

```
group (= vault = world)
 ├── users           (players + admins)
 ├── campaigns       (auto-discovered from folder structure)
 ├── templates       (one per kind: pc, npc, ally, villain)
 ├── notes           (all pages — characters are notes with structured frontmatter)
 └── characters      (derived index, queried for lists/dashboards)
```

- **World** = vault (existing `groups` row).
- **Campaign** = first-class entity, auto-discovered from `Campaigns/<n>/…` paths. Editable display name, but the slug is driven by the folder.
- **Character** = a note whose frontmatter declares `kind: character`. The note body stays the backstory / free-form prose. The frontmatter holds structured fields whose shape comes from a **template**.
- **Template** = admin-owned schema definition. Declares what fields exist on a character sheet. Players never see or edit it.

### Why "character is a note + index table"

The note is the source of truth — that way file moves (NPC → Villain), collab sync, backlinks, and the graph all keep working without any new machinery. The `characters` table is **derived** on note save, cached for fast queries ("all PCs owned by alex across all campaigns"). If the table ever drifts we just rebuild from frontmatter.

---

## 2. Data model

### New tables (migration v13)

```sql
-- Schema definitions. One per (group, kind). Admin-only write.
character_templates (
  id TEXT PRIMARY KEY,              -- uuid
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,               -- 'pc' | 'npc' | 'ally' | 'villain'
  name TEXT NOT NULL,               -- "D&D 5e PC"
  schema_json TEXT NOT NULL,        -- sections + fields (see §3)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES users(id),
  UNIQUE (group_id, kind)
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
  kind TEXT NOT NULL,
  template_id TEXT REFERENCES character_templates(id) ON DELETE SET NULL,
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
  PCs/                              ← cross-campaign player characters
  Campaigns/
    Campaign 3/
      Characters/
        NPCs/
        Allies/
        Villains/
      Sessions/
      Locations/
  Recurring/
    Characters/                     ← villains etc. reused across campaigns
```

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

### Seed on group creation

First boot: each group gets a minimal 5e PC template, plus empty NPC / Ally / Villain templates. Admin customises from there.

---

## 4. Permissions

| Action | Admin | Editor | Viewer | Player (self's PC) |
|--|--|--|--|--|
| View any character | ✓ | ✓ | ✓ | ✓ |
| Edit any character | ✓ | ✓ | | |
| Edit own PC's sheet | ✓ | ✓ | | ✓ |
| Edit another player's PC | ✓ | | | |
| Edit `playerEditable` fields on any sheet | ✓ | ✓ | | ✓ |
| CRUD templates | ✓ | | | |
| See `/settings/templates` | ✓ | | | |
| Create campaign | ✓ | ✓ | | |

"Own PC" = frontmatter `player:` matches your username. This is enforced **server-side** in the collab save hook, not just in the UI — a player editing raw yaml can't bypass it because save rejects.

HP current is a common exception: you want players to update their own HP during a session. Solution: template fields can carry `playerEditable: true`, which opens that specific field to edits by any player (regardless of PC ownership). HP-current, conditions, death saves are the usual suspects.

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

### Top nav: active-character chip

- Portrait + name of your active character.
- Click → open the sheet.
- Dropdown → switch active; quick-link to `/characters`.

### File tree

- Character-kind notes get an icon (sword for PC, skull for villain, heart for ally, face for NPC).
- Templates are not notes — they don't appear in the tree at all.

### Graph

- PCs rendered as star nodes.
- Villains / allies get their kind-colour baked in, editable via the existing group colour overrides.

---

## 6. Phased delivery

One commit per bullet:

| # | Title | What lands |
|--|--|--|
| **1a** | Schema + defaults | Migration v13, seed default 5e PC template on group create, seed other empty kinds |
| **1b** | Derive pipeline | Hook into the existing save-derive path: parse frontmatter, maintain `characters` + `character_campaigns` + `campaigns` tables |
| **1c** | Admin template editor | `/settings/templates` page, CRUD UI, live preview |
| **1d** | Character sheet on note page | Detect `kind: character`, render sheet above prose, form binds to frontmatter via Y.Doc, permissions enforced |
| **1e** | `/characters` dashboard + active-chip | Per-user listing, active pin, quick switcher |
| **1f** | Creation flow + folder niceties | "+ New character" buttons, folder inference, file-tree kind icons |

1b through 1f each depend on 1a + 1b. 1c–1f can be done in sequence but reviewed independently.

NPC / Ally / Villain sheets beyond Phase 1, the assets gallery, session-run mode, and the DM-only layer all come after.

---

## 7. Open questions — need a decision

1. **One template per kind, or multiple?**
   Simpler: one per kind, admin-editable. More flexible: admins create N templates per kind (e.g., "5e PC", "Homebrew PC", "One-shot PC") and each character picks one. Recommendation: **start with one per kind**; grow if needed.

2. **PCs folder location.**
   `/PCs/` at the vault root (cross-campaign, easy to find) or `/Campaigns/<n>/PCs/` (clearly scoped)?
   Recommendation: **root-level `/PCs/`** with `campaigns:` frontmatter doing the binding — matches the crossover-character case better.

3. **Player-writable fields on others' sheets.**
   Players will want to mark each other's HP during combat. OK to add a `playerEditable: true` flag per field (defaults false)? HP-current, conditions, death saves are the usual suspects.

4. **Per-group templates vs global.**
   Per-group (each world has its own) or global (one shared "5e PC" template across all worlds on the server)?
   Recommendation: **per-group**, so each world can diverge. Admins can share by copying schema JSON if they want.
