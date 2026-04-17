# LiveSync (CouchDB) — branch notes

This branch swaps Syncthing for [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) backed by CouchDB. Goal: compare sync latency against Syncthing on `main`.

## What changed vs `main`

| File | Change |
|------|--------|
| `Dockerfile` | CouchDB 3.4 (was Syncthing) |
| `couchdb/local.ini` | CouchDB config: CORS for Obsidian, single-node, large-doc allowance |
| `init-couchdb.sh` | Replaces `init-railway.sh`. Creates system DBs + vault DB after deploy |
| `.env.example` | Added `COUCHDB_URL` / `COUCHDB_USER` / `COUCHDB_PASSWORD` / `COUCHDB_DBNAME` |
| `scripts/setup-livesync-mac.sh`, `setup-livesync-linux.sh` | Friend installers — drop the LiveSync plugin into the vault + write its `data.json` |
| `scripts/_livesync_wizard.sh` | Shared prompt logic for the friend installers |

The old Syncthing files (`setup-owner.sh`, `init-railway.sh`, `scripts/setup-mac.sh`, etc.) still exist on the branch but do nothing without the Syncthing Railway service.

## Deploy the CouchDB service to Railway

**Don't replace the live Syncthing service yet** — spin up a *second* Railway service from this branch so you can A/B.

1. Railway → **New Service → Deploy from GitHub repo** → point at `algrifff/dnd-sync`
2. **Settings → Source → Branch** → `livesync-couchdb`
3. **Variables**:
   ```
   COUCHDB_USER = admin
   COUCHDB_PASSWORD = <strong random string>
   ```
4. **Volumes** → add a volume mounted at `/opt/couchdb/data` (persistence)
5. **Networking** → generate a public domain, set port to **5984**
6. Deploy. Wait for the service to go green.

## Initialise the database

```bash
cp .env.example .env            # (if you don't already have one)
# fill in COUCHDB_URL / COUCHDB_USER / COUCHDB_PASSWORD in .env
./init-couchdb.sh
```

The script creates the `_users`, `_replicator`, `_global_changes`, and vault databases, verifies CORS, and prints the four values you'll paste into LiveSync.

## Install LiveSync on the two test machines

On each machine (you + one friend), run the one-liner for that OS:

```bash
# Mac
curl -fsSL https://raw.githubusercontent.com/algrifff/dnd-sync/livesync-couchdb/scripts/setup-livesync-mac.sh | bash

# Linux
curl -fsSL https://raw.githubusercontent.com/algrifff/dnd-sync/livesync-couchdb/scripts/setup-livesync-linux.sh | bash
```

The script will:
1. Install Obsidian
2. Create `~/Documents/The-Compendium`
3. Drop the LiveSync plugin into `.obsidian/plugins/obsidian-livesync/`
4. Pre-fill `data.json` with the CouchDB URL, user, password, and DB name
5. Open Obsidian

In Obsidian, first time:
- **Settings → Community plugins → Turn on community plugins** (one-time Obsidian gate)
- Enable **Self-hosted LiveSync** in the Community plugins list
- Open LiveSync settings → **Fetch everything from remote** (on the *second* device — the first device uploads, the second catches up)
- Turn on **LiveSync mode** (the toggle at the top of the plugin's settings)

## Speed test protocol

1. Both machines: Obsidian open, LiveSync mode on (watch for the "🔄 LiveSync" indicator in the status bar)
2. On machine A, edit a note and add a line. Start a stopwatch when you save.
3. Stop when the line appears in machine B.
4. Repeat 3–5 times for different content sizes. Typical LiveSync latency: **sub-second to 2s**. Syncthing is typically 5–30s.

## Tear down when done

If you keep this branch: delete the Syncthing Railway service.

If you discard: delete the CouchDB Railway service and `git checkout main`. Cost of either branch at rest: one Railway hobby service (~$5/mo).
