# Main-Notes import

One-shot bulk import of `~/dnd/Main-Notes` into a Compendium world,
plus an export/apply pair to ship the result to production.

## Workflow

```
build-local.ts  →  (verify in browser)  →  export-bundle.ts  →  apply-bundle.ts (on prod)
```

### 1. Build locally

```sh
cd server
DATA_DIR=./.data bun run ../scripts/main-notes-import/build-local.ts \
  --source "/mnt/c/Users/alexg/Documents/dnd/Main-Notes" \
  --user-id "<production uuid for algrifff>" \
  --username algrifff \
  --world-name Delara \
  --reset
```

What it does:

- Snapshots `./.data/compendium.db` first (timestamped backup).
- Stubs a local `algrifff` user with the **production UUID** baked in
  so the export needs no remap.
- Creates the Delara world, walks Main-Notes, classifies into canonical
  folders (Characters / People / Enemies / Loot / Places / Adventure
  Log / Creatures / Quests), uploads assets globally, runs `writeNote`
  twice for cross-campaign wikilink resolution, sets friendly campaign
  names, and prints unresolved orphans.
- Character notes go through `parseCharacter` which extracts HP / AC /
  abilities / class / race / portrait from the body's markdown tables
  and builds the canonical `frontmatter.sheet`.

### 2. Verify

Restart the dev server, log in (use a local admin account — the stub
algrifff has a placeholder password hash), browse the new world, spot
check campaigns, characters, World Lore subfolders, backlinks.

### 3. Export

```sh
cd server
DATA_DIR=./.data bun run ../scripts/main-notes-import/export-bundle.ts \
  --group-id <new-uuid-printed-by-build-local> \
  --user-id "<production uuid for algrifff>" \
  --out bundle.json
```

Produces a single `bundle.json` (~5–10 MB) with every group-scoped row
plus the asset BLOBs base64-encoded.

### 4. Apply on prod

Copy `bundle.json` to the Railway environment, then:

```sh
DATA_DIR=/data bun run scripts/main-notes-import/apply-bundle.ts \
  --bundle /tmp/bundle.json
```

The script:

- Refuses if the target DB already has a group with the same id.
- Writes asset BLOBs to disk first (content-addressed by hash).
- Runs every INSERT in a single transaction; rolls back on error.
- Skips inserting the algrifff user row if it already exists on prod
  (which it will).

### 5. Optional cleanup

If you want to redo the import locally, purge the existing group
first (FK cascade-deletes most of it; a few related tables need
explicit purges — see the inline `bun -e` snippets in the chat
history if needed) before re-running `build-local.ts --reset`.
