#!/usr/bin/env bash
# Shared wizard for the LiveSync/CouchDB friend installer.
# Sourced by setup-livesync-mac.sh and setup-livesync-linux.sh.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null)" || SCRIPT_DIR=""

# Load UI helpers (local OR curl-fetched).
_UI_URL="https://raw.githubusercontent.com/algrifff/dnd-sync/livesync-couchdb/scripts/_ui.sh"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/_ui.sh" ]]; then
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/_ui.sh"
else
    _UI_SRC="$(curl -fsSL "$_UI_URL" 2>/dev/null || true)"
    if [[ -n "$_UI_SRC" ]]; then
        eval "$_UI_SRC"
    else
        show_banner()   { :; }
        print_step()    { echo ""; echo "[$1/${UI_TOTAL_STEPS:-5}] $2"; }
        print_ok()      { echo "   ✓ $1"; }
        print_info()    { echo "   › $1"; }
        print_warn()    { echo "   ! $1"; }
        print_err()     { echo "   ✗ $1"; }
        print_done()    { echo ""; echo "=== Setup complete! ==="; }
        R=""; BOLD=""; DIM=""; GOLD=""; GREEN=""; GREY=""
    fi
fi

# Load .env if running from a local checkout (owner convenience).
[[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/../.env" ]] && source "$SCRIPT_DIR/../.env"

VAULT_PATH="${VAULT_PATH:-$HOME/Documents/The-Compendium}"
UI_TOTAL_STEPS=5

show_banner

echo "  ${BOLD}${GOLD}🐉  The Compendium — Live Sync (CouchDB beta)${R}"
echo ""
echo "  You need ${BOLD}four things${R} from your DM before you begin:"
echo "     ${GOLD}①${R} CouchDB URL    ${DIM}${GREY}— https://xxx.up.railway.app${R}"
echo "     ${GOLD}②${R} Username"
echo "     ${GOLD}③${R} Password"
echo "     ${GOLD}④${R} Database name  ${DIM}${GREY}— usually 'vault'${R}"
echo ""

if [[ -z "$COUCHDB_URL" ]]; then
    printf "  ${BOLD}${GOLD}①${R} ${BOLD}CouchDB URL:${R} "
    read -r COUCHDB_URL </dev/tty
    COUCHDB_URL="${COUCHDB_URL%/}"
fi
if [[ -z "$COUCHDB_USER" ]]; then
    printf "  ${BOLD}${GOLD}②${R} ${BOLD}Username:${R} "
    read -r COUCHDB_USER </dev/tty
fi
if [[ -z "$COUCHDB_PASSWORD" ]]; then
    printf "  ${BOLD}${GOLD}③${R} ${BOLD}Password:${R} "
    read -rs COUCHDB_PASSWORD </dev/tty
    echo ""
fi
if [[ -z "$COUCHDB_DBNAME" ]]; then
    printf "  ${BOLD}${GOLD}④${R} ${BOLD}Database name ${DIM}(default: vault)${R}${BOLD}:${R} "
    read -r COUCHDB_DBNAME </dev/tty
    COUCHDB_DBNAME="${COUCHDB_DBNAME:-vault}"
fi

echo ""
print_info "Verifying CouchDB connection..."
if ! curl -sfu "$COUCHDB_USER:$COUCHDB_PASSWORD" "$COUCHDB_URL/_session" >/dev/null; then
    print_err "Could not authenticate to CouchDB."
    echo "     ${DIM}${GREY}Check the URL / username / password, then run again.${R}"
    exit 1
fi
if ! curl -sfu "$COUCHDB_USER:$COUCHDB_PASSWORD" "$COUCHDB_URL/$COUCHDB_DBNAME" >/dev/null; then
    print_err "Database '$COUCHDB_DBNAME' not found — ask your DM to run init-couchdb.sh."
    exit 1
fi
print_ok "Connected to $COUCHDB_URL/$COUCHDB_DBNAME"
echo ""

# ── Plugin install helper ─────────────────────────────────────────────────────
install_livesync_plugin() {
    local vault="$1"
    local plugin_dir="$vault/.obsidian/plugins/obsidian-livesync"
    mkdir -p "$plugin_dir"

    local api
    api=$(curl -sf https://api.github.com/repos/vrtmrz/obsidian-livesync/releases/latest)
    local asset_url
    for asset in main.js manifest.json styles.css; do
        asset_url=$(echo "$api" | python3 -c "
import sys, json
a = json.load(sys.stdin)['assets']
url = next((x['browser_download_url'] for x in a if x['name']=='$asset'), None)
if url: print(url)
")
        if [[ -z "$asset_url" ]]; then
            print_err "Could not find $asset in latest LiveSync release."
            exit 1
        fi
        curl -fsL "$asset_url" -o "$plugin_dir/$asset"
    done
}

enable_livesync_in_vault() {
    local vault="$1"
    local obs="$vault/.obsidian"
    mkdir -p "$obs"

    # Mark this folder as an Obsidian vault + enable community plugins.
    python3 - "$obs" "$vault" "$COUCHDB_URL" "$COUCHDB_USER" "$COUCHDB_PASSWORD" "$COUCHDB_DBNAME" <<'PY'
import json, os, sys
obs, vault, url, user, pw, db = sys.argv[1:7]

def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)

# community-plugins.json: list of enabled plugin IDs
cp = os.path.join(obs, 'community-plugins.json')
enabled = []
if os.path.isfile(cp):
    try:    enabled = json.load(open(cp))
    except: enabled = []
if 'obsidian-livesync' not in enabled:
    enabled.append('obsidian-livesync')
write(cp, enabled)

# app.json: let user set their own — only touch if missing
app = os.path.join(obs, 'app.json')
if not os.path.isfile(app):
    write(app, {})

# data.json for LiveSync — minimal config; plugin fills its own defaults
data = os.path.join(obs, 'plugins', 'obsidian-livesync', 'data.json')
cfg = {}
if os.path.isfile(data):
    try:    cfg = json.load(open(data))
    except: cfg = {}
cfg.update({
    'couchDB_URI': url,
    'couchDB_USER': user,
    'couchDB_PASSWORD': pw,
    'couchDB_DBNAME': db,
    'liveSync': True,
    'syncOnStart': True,
    'syncOnSave': True,
    'syncOnFileOpen': True,
    'savingDelay': 200,
    'lessInformationInLog': False,
})
write(data, cfg)
print(f"Wrote LiveSync config for {vault}")
PY
}
