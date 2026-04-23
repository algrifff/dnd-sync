// Forward-only migration runner. Tracks the current schema version in
// schema_version and applies anything that hasn't run yet. Each migration
// is wrapped in a transaction.

import type { Database } from './db';

type Migration = {
  readonly version: number;
  readonly description: string;
  readonly sql: string;
};

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'initial schema: text_docs, binary_files, fts index',
    sql: `
      CREATE TABLE text_docs (
        path         TEXT    PRIMARY KEY,
        yjs_state    BLOB    NOT NULL,
        text_content TEXT    NOT NULL DEFAULT '',
        updated_at   INTEGER NOT NULL,
        updated_by   TEXT
      ) WITHOUT ROWID;

      CREATE TABLE binary_files (
        path       TEXT    PRIMARY KEY,
        data       BLOB    NOT NULL,
        mime_type  TEXT    NOT NULL,
        size       INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT
      ) WITHOUT ROWID;

      CREATE VIRTUAL TABLE text_docs_fts USING fts5(
        path UNINDEXED,
        content,
        tokenize = 'porter unicode61'
      );

      -- Keep FTS in sync with text_docs.text_content.
      CREATE TRIGGER text_docs_ai AFTER INSERT ON text_docs BEGIN
        INSERT INTO text_docs_fts(path, content) VALUES (new.path, new.text_content);
      END;

      CREATE TRIGGER text_docs_au AFTER UPDATE OF text_content ON text_docs BEGIN
        DELETE FROM text_docs_fts WHERE path = old.path;
        INSERT INTO text_docs_fts(path, content) VALUES (new.path, new.text_content);
      END;

      CREATE TRIGGER text_docs_ad AFTER DELETE ON text_docs BEGIN
        DELETE FROM text_docs_fts WHERE path = old.path;
      END;
    `,
  },
  {
    version: 2,
    description: 'config table for auto-generated tokens + installer key',
    sql: `
      CREATE TABLE config (
        key        TEXT    PRIMARY KEY,
        value      TEXT    NOT NULL,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;
    `,
  },
  {
    version: 3,
    description: 'friends: per-player named tokens with revocation',
    sql: `
      CREATE TABLE friends (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        token      TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      ) WITHOUT ROWID;

      CREATE INDEX friends_active ON friends(revoked_at) WHERE revoked_at IS NULL;
    `,
  },
  {
    version: 4,
    description: 'binary_files: content_hash for idempotent sync',
    sql: `
      ALTER TABLE binary_files ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    version: 5,
    description: 'friends: last_seen_at for verifiable pairing',
    sql: `
      ALTER TABLE friends ADD COLUMN last_seen_at INTEGER;
    `,
  },
  {
    version: 6,
    description: 'web app auth: users, sessions, groups, group_members, audit_log',
    sql: `
      -- Groups are tenant containers. v1 has one group ('default'); schema
      -- is multi-tenant-ready so later groups only need a UI, not a
      -- migration.
      CREATE TABLE groups (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO groups (id, name, created_at) VALUES ('default', 'Compendium', strftime('%s','now')*1000);

      CREATE TABLE users (
        id             TEXT PRIMARY KEY,
        username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
        email          TEXT COLLATE NOCASE,
        password_hash  TEXT NOT NULL,
        display_name   TEXT NOT NULL,
        accent_color   TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        last_login_at  INTEGER
      );
      CREATE UNIQUE INDEX users_username ON users(username);

      CREATE TABLE group_members (
        group_id  TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        user_id   TEXT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
        role      TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, user_id)
      ) WITHOUT ROWID;
      CREATE INDEX group_members_user ON group_members(user_id);

      -- Random 32-byte hex id is the primary identifier; we don't
      -- encrypt/sign it because a successful DB lookup IS the proof.
      CREATE TABLE sessions (
        id               TEXT PRIMARY KEY,
        user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        current_group_id TEXT NOT NULL REFERENCES groups(id),
        csrf_token       TEXT NOT NULL,
        created_at       INTEGER NOT NULL,
        expires_at       INTEGER NOT NULL,
        last_seen_at     INTEGER NOT NULL,
        user_agent       TEXT,
        ip               TEXT
      );
      CREATE INDEX sessions_user    ON sessions(user_id);
      CREATE INDEX sessions_expires ON sessions(expires_at);

      -- Append-only log of admin actions. details_json is free-form so
      -- each action can annotate with non-PII context.
      CREATE TABLE audit_log (
        id           TEXT PRIMARY KEY,
        group_id     TEXT NOT NULL REFERENCES groups(id),
        actor_id     TEXT REFERENCES users(id),
        action       TEXT NOT NULL,
        target       TEXT,
        details_json TEXT NOT NULL DEFAULT '{}',
        at           INTEGER NOT NULL
      );
      CREATE INDEX audit_log_group_at ON audit_log(group_id, at DESC);
      CREATE INDEX audit_log_action   ON audit_log(action);
    `,
  },
  {
    version: 7,
    description: 'web app vault: notes, assets, aliases, note_links, tags, notes_fts',
    sql: `
      CREATE TABLE notes (
        id               TEXT PRIMARY KEY,
        group_id         TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        path             TEXT NOT NULL,
        title            TEXT NOT NULL DEFAULT '',
        content_json     TEXT NOT NULL,
        content_text     TEXT NOT NULL DEFAULT '',
        content_md       TEXT NOT NULL DEFAULT '',
        yjs_state        BLOB,
        frontmatter_json TEXT NOT NULL DEFAULT '{}',
        byte_size        INTEGER NOT NULL DEFAULT 0,
        updated_at       INTEGER NOT NULL,
        updated_by       TEXT REFERENCES users(id),
        UNIQUE (group_id, path)
      );
      CREATE INDEX notes_group_path ON notes(group_id, path);
      CREATE INDEX notes_updated_at ON notes(group_id, updated_at DESC);

      CREATE TABLE aliases (
        group_id TEXT NOT NULL,
        alias    TEXT NOT NULL COLLATE NOCASE,
        path     TEXT NOT NULL,
        PRIMARY KEY (group_id, alias)
      ) WITHOUT ROWID;
      CREATE INDEX aliases_path ON aliases(group_id, path);

      CREATE TABLE assets (
        id            TEXT PRIMARY KEY,
        group_id      TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        hash          TEXT NOT NULL,
        mime          TEXT NOT NULL,
        size          INTEGER NOT NULL,
        original_name TEXT NOT NULL,
        uploaded_by   TEXT REFERENCES users(id),
        uploaded_at   INTEGER NOT NULL,
        UNIQUE (group_id, hash)
      );
      CREATE INDEX assets_hash ON assets(group_id, hash);

      CREATE TABLE note_links (
        group_id  TEXT NOT NULL,
        from_path TEXT NOT NULL,
        to_path   TEXT NOT NULL,
        PRIMARY KEY (group_id, from_path, to_path)
      ) WITHOUT ROWID;
      CREATE INDEX note_links_to ON note_links(group_id, to_path);

      CREATE TABLE tags (
        group_id TEXT NOT NULL,
        path     TEXT NOT NULL,
        tag      TEXT NOT NULL,
        PRIMARY KEY (group_id, path, tag)
      ) WITHOUT ROWID;
      CREATE INDEX tags_tag ON tags(group_id, tag);

      -- FTS5 over title + plaintext. Mirrored from notes via triggers.
      CREATE VIRTUAL TABLE notes_fts USING fts5(
        path UNINDEXED, title, content,
        tokenize = 'porter unicode61'
      );

      CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(path, title, content)
          VALUES (new.path, new.title, new.content_text);
      END;
      CREATE TRIGGER notes_au AFTER UPDATE OF title, content_text ON notes BEGIN
        DELETE FROM notes_fts WHERE path = old.path;
        INSERT INTO notes_fts(path, title, content)
          VALUES (new.path, new.title, new.content_text);
      END;
      CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
        DELETE FROM notes_fts WHERE path = old.path;
      END;
    `,
  },
  {
    version: 8,
    description: 'folder_markers: explicit empty folders',
    sql: `
      CREATE TABLE folder_markers (
        group_id   TEXT NOT NULL,
        path       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, path)
      ) WITHOUT ROWID;
    `,
  },
  {
    version: 9,
    description: 'notes: created_at + created_by; backfill from updated_*',
    sql: `
      ALTER TABLE notes ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE notes ADD COLUMN created_by TEXT REFERENCES users(id);
      UPDATE notes SET created_at = updated_at WHERE created_at = 0;
      UPDATE notes SET created_by = updated_by WHERE created_by IS NULL;
    `,
  },
  {
    version: 10,
    description: 'graph_groups: persistent graph-view groups per vault',
    sql: `
      CREATE TABLE graph_groups (
        group_id   TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
        yjs_state  BLOB,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 11,
    description: 'users: avatar blob + cursor mode for live cursors',
    sql: `
      ALTER TABLE users ADD COLUMN avatar_blob BLOB;
      ALTER TABLE users ADD COLUMN avatar_mime TEXT;
      ALTER TABLE users ADD COLUMN avatar_updated_at INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN cursor_mode TEXT NOT NULL DEFAULT 'color';
    `,
  },
  {
    version: 12,
    description: 'assets: store original vault path for by-path lookup',
    sql: `
      ALTER TABLE assets ADD COLUMN original_path TEXT;
      UPDATE assets SET original_path = original_name WHERE original_path IS NULL;
      CREATE INDEX assets_original_path
        ON assets(group_id, original_path);
      CREATE INDEX assets_original_name
        ON assets(group_id, original_name);
    `,
  },
  {
    version: 13,
    description:
      'characters: global note_templates + campaigns + characters index + active_character_path',
    sql: `
      -- Server-global schema registry. Keyed by kind so there's
      -- exactly one template per kind; any admin on any world can
      -- edit and every world sees the same shape.
      CREATE TABLE note_templates (
        kind        TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        schema_json TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        updated_by  TEXT REFERENCES users(id)
      ) WITHOUT ROWID;

      -- Campaigns are per-world. Auto-created on save when a note's
      -- path falls under Campaigns/<slug>/; admins can rename the
      -- display value without touching the folder.
      CREATE TABLE campaigns (
        group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        slug        TEXT NOT NULL,
        name        TEXT NOT NULL,
        folder_path TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (group_id, slug)
      ) WITHOUT ROWID;

      -- Character index. Derived from note frontmatter each save,
      -- cascade-deleted with the backing note. The note (source of
      -- truth) can recover this table at any time via re-derive.
      CREATE TABLE characters (
        group_id       TEXT NOT NULL,
        note_path      TEXT NOT NULL,
        kind           TEXT NOT NULL,
        player_user_id TEXT REFERENCES users(id),
        display_name   TEXT NOT NULL,
        portrait_path  TEXT,
        level          INTEGER,
        class          TEXT,
        race           TEXT,
        updated_at     INTEGER NOT NULL,
        PRIMARY KEY (group_id, note_path),
        FOREIGN KEY (group_id, note_path)
          REFERENCES notes(group_id, path) ON DELETE CASCADE
      ) WITHOUT ROWID;
      CREATE INDEX characters_player ON characters(group_id, player_user_id);
      CREATE INDEX characters_kind ON characters(group_id, kind);

      -- Many-to-many for crossover characters. Chained deletes
      -- follow the characters row.
      CREATE TABLE character_campaigns (
        group_id       TEXT NOT NULL,
        note_path      TEXT NOT NULL,
        campaign_slug  TEXT NOT NULL,
        PRIMARY KEY (group_id, note_path, campaign_slug),
        FOREIGN KEY (group_id, note_path)
          REFERENCES characters(group_id, note_path) ON DELETE CASCADE
      ) WITHOUT ROWID;

      -- Each user has one pinned active character (null = none).
      -- Plain path string; we don't FK-constrain because users may
      -- set an active character in a world and move between groups.
      ALTER TABLE users ADD COLUMN active_character_path TEXT;
    `,
  },
  {
    version: 14,
    description: 'session_notes: index of kind: session notes for /sessions',
    sql: `
      -- Named session_notes (not sessions) because the auth sessions
      -- table already owns that name from migration v4.
      CREATE TABLE session_notes (
        group_id       TEXT NOT NULL,
        note_path      TEXT NOT NULL,
        campaign_slug  TEXT,
        session_date   TEXT,    -- YYYY-MM-DD for chronological sort
        session_number INTEGER,
        title          TEXT,
        attendees_json TEXT,    -- JSON array of strings
        updated_at     INTEGER NOT NULL,
        PRIMARY KEY (group_id, note_path),
        FOREIGN KEY (group_id, note_path)
          REFERENCES notes(group_id, path) ON DELETE CASCADE
      ) WITHOUT ROWID;
      CREATE INDEX session_notes_campaign_date
        ON session_notes(group_id, campaign_slug, session_date DESC);
    `,
  },
  {
    version: 15,
    description: 'notes.dm_only flag for DM-hidden content',
    sql: `
      ALTER TABLE notes ADD COLUMN dm_only INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX notes_dm_only ON notes(group_id, dm_only);
    `,
  },
  {
    version: 16,
    description: 'import_jobs: AI-assisted import pipeline state',
    sql: `
      CREATE TABLE import_jobs (
        id           TEXT PRIMARY KEY,
        group_id     TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        created_by   TEXT NOT NULL REFERENCES users(id),
        status       TEXT NOT NULL,  -- uploaded | parsing | analysing | ready | applied | cancelled | failed
        raw_zip_path TEXT,           -- temp file under DATA_DIR; cleared on apply/cancel
        plan_json    TEXT,           -- full classical parse + AI plan + review state
        stats_json   TEXT,           -- counts, token usage, cost, errors
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX import_jobs_group_status
        ON import_jobs(group_id, status);
      CREATE INDEX import_jobs_user_status
        ON import_jobs(created_by, status);
    `,
  },
  {
    version: 17,
    description: 'session_notes: status + dm_review_json for session close workflow',
    sql: `
      ALTER TABLE session_notes ADD COLUMN status TEXT NOT NULL DEFAULT 'open';
      ALTER TABLE session_notes ADD COLUMN dm_review_json TEXT;
      ALTER TABLE session_notes ADD COLUMN closed_at INTEGER;
      ALTER TABLE session_notes ADD COLUMN closed_by TEXT REFERENCES users(id);
      CREATE INDEX session_notes_status ON session_notes(group_id, status);
    `,
  },
  {
    version: 18,
    description: 'group_invite_tokens: shareable world invite links',
    sql: `
      CREATE TABLE group_invite_tokens (
        token      TEXT PRIMARY KEY,
        group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      ) WITHOUT ROWID;
      CREATE INDEX group_invite_tokens_group ON group_invite_tokens(group_id);
    `,
  },
  {
    version: 19,
    description: 'asset_tags: per-asset tag set',
    sql: `
      CREATE TABLE asset_tags (
        group_id TEXT NOT NULL,
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        tag      TEXT NOT NULL,
        PRIMARY KEY (group_id, asset_id, tag)
      ) WITHOUT ROWID;
      CREATE INDEX asset_tags_tag ON asset_tags(group_id, tag);
    `,
  },
  {
    version: 20,
    description: 'groups: header_color for custom world name colour in the top bar',
    sql: `ALTER TABLE groups ADD COLUMN header_color TEXT;`,
  },
  {
    version: 23,
    description: 'note_links: is_manual flag for explicit sidebar/graph links',
    sql: `
      ALTER TABLE note_links ADD COLUMN is_manual INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 24,
    description:
      'compendium_entries: canonical cross-world library (5e + future rulesets)',
    sql: `
      -- Global library shared by every world. group_id NULL = official
      -- content (SRD etc.); non-null = per-world homebrew. The ruleset
      -- column lets the same DB host multiple TTRPG systems later.
      CREATE TABLE compendium_entries (
        id          TEXT PRIMARY KEY,
        ruleset     TEXT NOT NULL DEFAULT 'dnd5e',
        kind        TEXT NOT NULL,
        name        TEXT NOT NULL,
        slug        TEXT NOT NULL,
        data_json   TEXT NOT NULL,
        source      TEXT,
        group_id    TEXT,
        version     INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX compendium_unique
        ON compendium_entries(ruleset, kind, slug, IFNULL(group_id, ''));
      CREATE INDEX compendium_ruleset_kind
        ON compendium_entries(ruleset, kind);
      CREATE INDEX compendium_group
        ON compendium_entries(group_id);
      CREATE INDEX compendium_name
        ON compendium_entries(ruleset, kind, name COLLATE NOCASE);
    `,
  },
  {
    version: 25,
    description: 'items: derived index of kind:item notes',
    sql: `
      CREATE TABLE items (
        group_id      TEXT NOT NULL,
        note_path     TEXT NOT NULL,
        name          TEXT NOT NULL,
        category      TEXT,
        rarity        TEXT,
        attunement    INTEGER NOT NULL DEFAULT 0,
        weight        REAL,
        cost_gp       REAL,
        compendium_id TEXT,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (group_id, note_path),
        FOREIGN KEY (group_id, note_path)
          REFERENCES notes(group_id, path) ON DELETE CASCADE
      ) WITHOUT ROWID;
      CREATE INDEX items_group_cat ON items(group_id, category);
      CREATE INDEX items_name ON items(group_id, name COLLATE NOCASE);
    `,
  },
  {
    version: 26,
    description: 'locations: derived index of kind:location notes',
    sql: `
      CREATE TABLE locations (
        group_id    TEXT NOT NULL,
        note_path   TEXT NOT NULL,
        name        TEXT NOT NULL,
        type        TEXT,
        region      TEXT,
        parent_path TEXT,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (group_id, note_path),
        FOREIGN KEY (group_id, note_path)
          REFERENCES notes(group_id, path) ON DELETE CASCADE
      ) WITHOUT ROWID;
      CREATE INDEX locations_parent
        ON locations(group_id, parent_path);
      CREATE INDEX locations_name
        ON locations(group_id, name COLLATE NOCASE);
    `,
  },
  {
    version: 27,
    description:
      'creatures: derived index of kind:creature (and legacy kind:monster) notes',
    sql: `
      CREATE TABLE creatures (
        group_id      TEXT NOT NULL,
        note_path     TEXT NOT NULL,
        name          TEXT NOT NULL,
        type          TEXT,
        size          TEXT,
        cr            REAL,
        ac            INTEGER,
        hp_max        INTEGER,
        compendium_id TEXT,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (group_id, note_path),
        FOREIGN KEY (group_id, note_path)
          REFERENCES notes(group_id, path) ON DELETE CASCADE
      ) WITHOUT ROWID;
      CREATE INDEX creatures_cr ON creatures(group_id, cr);
      CREATE INDEX creatures_name ON creatures(group_id, name COLLATE NOCASE);
    `,
  },
  {
    version: 28,
    description:
      'characters: ac/hp_max/hp_current/proficiency_bonus for quick reads',
    sql: `
      ALTER TABLE characters ADD COLUMN ac INTEGER;
      ALTER TABLE characters ADD COLUMN hp_max INTEGER;
      ALTER TABLE characters ADD COLUMN hp_current INTEGER;
      ALTER TABLE characters ADD COLUMN proficiency_bonus INTEGER;
    `,
  },
  {
    version: 29,
    description:
      'ai_personalities: per-world AI voice presets + active selection on groups',
    sql: `
      -- Named AI voice presets a world admin can swap between. The
      -- hardcoded "Grizzled Scribe" default lives in code
      -- (DEFAULT_PERSONALITY) and is used when active_personality_id
      -- is NULL, so the table can be empty on day one.
      CREATE TABLE ai_personalities (
        id         TEXT PRIMARY KEY,
        group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        prompt     TEXT NOT NULL,
        created_by TEXT REFERENCES users(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX ai_personalities_group ON ai_personalities(group_id);

      -- NULL = use the built-in default. Not FK-constrained so we can
      -- null it out manually when the target row is deleted (the API
      -- layer handles that in the same transaction as the delete).
      ALTER TABLE groups ADD COLUMN active_personality_id TEXT;
    `,
  },
  {
    version: 30,
    description:
      'groups: icon_blob/mime/updated_at for per-world sidebar icons',
    sql: `
      -- Mirror of users.avatar_*: store the (client-side resized)
      -- image bytes on the row and use icon_updated_at as the ?v=
      -- cache-buster the sidebar appends to the serve URL. 0 means
      -- no icon (fall back to initials-on-colour chip).
      ALTER TABLE groups ADD COLUMN icon_blob BLOB;
      ALTER TABLE groups ADD COLUMN icon_mime TEXT;
      ALTER TABLE groups ADD COLUMN icon_updated_at INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 31,
    description: 'note_links: add from_path index for neighbourhood graph queries',
    sql: `
      -- Neighbourhood queries look up outgoing edges with
      -- WHERE group_id = ? AND from_path = ? on every frontier node.
      -- The existing note_links_to index covers to_path; this covers
      -- the other direction.
      CREATE INDEX IF NOT EXISTS note_links_from
        ON note_links(group_id, from_path);
    `,
  },
  {
    version: 32,
    description: 'notes: clear dm_only on all rows (deprecated visibility flag)',
    sql: `
      -- The dm_only visibility flag has been retired from the create
      -- and edit flows: every entity is public by default and the UI
      -- no longer offers a toggle. Clear historical 1s so legacy notes
      -- don't render with stale "DM only" badges or block viewer reads
      -- through the API gate.
      UPDATE notes SET dm_only = 0 WHERE dm_only = 1;
    `,
  },
  {
    version: 33,
    description: 'notes_fts: add group_id column for per-world MATCH scoping',
    sql: `
      -- notes.path is unique within a group but NOT globally
      -- (UNIQUE (group_id, path)). The original FTS schema only
      -- carried path, so MATCH queries scanned across every world
      -- and the join-by-path step could mis-snippet across tenants.
      --
      -- FTS5 has no ALTER ADD COLUMN; the only path is to drop +
      -- recreate the virtual table and its triggers, then refill.
      DROP TRIGGER IF EXISTS notes_ai;
      DROP TRIGGER IF EXISTS notes_au;
      DROP TRIGGER IF EXISTS notes_ad;
      DROP TABLE IF EXISTS notes_fts;

      CREATE VIRTUAL TABLE notes_fts USING fts5(
        path UNINDEXED, group_id UNINDEXED, title, content,
        tokenize = 'porter unicode61'
      );

      CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(path, group_id, title, content)
          VALUES (new.path, new.group_id, new.title, new.content_text);
      END;
      CREATE TRIGGER notes_au AFTER UPDATE OF title, content_text ON notes BEGIN
        DELETE FROM notes_fts
          WHERE path = old.path AND group_id = old.group_id;
        INSERT INTO notes_fts(path, group_id, title, content)
          VALUES (new.path, new.group_id, new.title, new.content_text);
      END;
      CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
        DELETE FROM notes_fts
          WHERE path = old.path AND group_id = old.group_id;
      END;

      -- Repopulate from the source of truth.
      INSERT INTO notes_fts(path, group_id, title, content)
        SELECT path, group_id, title, content_text FROM notes;
    `,
  },
];

export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const row = db
    .query<{ max: number | null }, []>('SELECT MAX(version) AS max FROM schema_version')
    .get();
  const current = row?.max ?? 0;

  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version,
  );

  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.sql);
      db.query('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        Date.now(),
      );
    })();
    console.log(`[db] applied migration v${migration.version}: ${migration.description}`);
  }
}

/** Latest schema version the code knows about. */
export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
