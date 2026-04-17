#!/usr/bin/env bash
# The Compendium — Mac LiveSync setup (CouchDB beta)
# Run: curl -fsSL https://raw.githubusercontent.com/algrifff/dnd-sync/livesync-couchdb/scripts/setup-livesync-mac.sh | bash

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
if [[ -d "/Applications/Obsidian.app" ]]; then
    print_ok "Obsidian already installed."
else
    print_info "Downloading Obsidian..."
    ARCH=$(uname -m)
    OBSIDIAN_URL=$(curl -s https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest \
        | python3 -c "
import sys, json
assets = json.load(sys.stdin)['assets']
dmgs = [a for a in assets if a['name'].endswith('.dmg')]
url = next((a['browser_download_url'] for a in dmgs if 'universal' in a['name']), None) \
   or next((a['browser_download_url'] for a in dmgs if '$ARCH' in a['name']), None) \
   or (dmgs[0]['browser_download_url'] if dmgs else None)
if not url: raise SystemExit('No DMG found')
print(url)
")
    curl -fL "$OBSIDIAN_URL" -o /tmp/Obsidian.dmg
    hdiutil attach /tmp/Obsidian.dmg -quiet
    cp -R /Volumes/Obsidian/Obsidian.app /Applications/
    hdiutil detach /Volumes/Obsidian -quiet
    rm /tmp/Obsidian.dmg
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
sleep 2
open -a Obsidian "$VAULT_PATH" 2>/dev/null || open -a Obsidian
