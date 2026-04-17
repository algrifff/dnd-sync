#!/usr/bin/env bash
# The Compendium — Linux LiveSync setup (CouchDB beta)
# Run: curl -fsSL https://raw.githubusercontent.com/algrifff/dnd-sync/livesync-couchdb/scripts/setup-livesync-linux.sh | bash

set -e

_WIZARD_URL="https://raw.githubusercontent.com/algrifff/dnd-sync/livesync-couchdb/scripts/_livesync_wizard.sh"
_LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)" || _LOCAL_DIR=""
if [[ -n "$_LOCAL_DIR" && -f "$_LOCAL_DIR/_livesync_wizard.sh" ]]; then
    source "$_LOCAL_DIR/_livesync_wizard.sh"
else
    source /dev/stdin <<< "$(curl -fsSL "$_WIZARD_URL")"
fi

UI_TOTAL_STEPS=3

# ── 1. Install Obsidian ───────────────────────────────────────────────────────
print_step 1 "Installing Obsidian"
OBSIDIAN_BIN="$HOME/.local/bin/obsidian.AppImage"
if command -v obsidian &>/dev/null || [[ -f "$OBSIDIAN_BIN" ]]; then
    print_ok "Obsidian already installed."
else
    print_info "Downloading the Obsidian AppImage..."
    OBSIDIAN_URL=$(curl -s https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest \
        | python3 -c "
import sys, json
assets = json.load(sys.stdin)['assets']
url = next((a['browser_download_url'] for a in assets if a['name'].endswith('.AppImage')), None)
if not url: raise SystemExit('No AppImage found')
print(url)
")
    mkdir -p "$HOME/.local/bin"
    curl -fL "$OBSIDIAN_URL" -o "$OBSIDIAN_BIN"
    chmod +x "$OBSIDIAN_BIN"
    print_ok "Obsidian installed."
fi

# ── 2. Install LiveSync plugin into the vault ─────────────────────────────────
print_step 2 "Installing the LiveSync plugin"
mkdir -p "$VAULT_PATH"
install_livesync_plugin "$VAULT_PATH"
enable_livesync_in_vault "$VAULT_PATH"
print_ok "LiveSync installed and configured."
print_ok "Vault folder: $VAULT_PATH"

# ── 3. Open Obsidian ──────────────────────────────────────────────────────────
print_step 3 "Opening Obsidian"
print_info "On first open: Settings → Community plugins → Turn on community plugins."
print_info "Then enable 'Self-hosted LiveSync' and click 'Fetch everything from remote'."

print_done
echo "  ${GREEN}›${R} Vault: ${BOLD}$VAULT_PATH${R}"
echo "  ${GREEN}›${R} CouchDB:  ${BOLD}$COUCHDB_URL/$COUCHDB_DBNAME${R}"
echo ""
if [[ -x "$OBSIDIAN_BIN" ]]; then
    ("$OBSIDIAN_BIN" --no-sandbox &) >/dev/null 2>&1 || true
fi
