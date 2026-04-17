#!/usr/bin/env bash
# Compendium one-click installer for macOS.
# Pre-baked with your DM's server URL and player token. No prompts.

set -e

SERVER_URL="__SERVER_URL__"
PLAYER_TOKEN="__PLAYER_TOKEN__"
VAULT_PATH="${COMPENDIUM_VAULT:-$HOME/Documents/The-Compendium}"

ESC=$'\033'
GOLD="$ESC[38;5;220m"
GREEN="$ESC[38;5;46m"
SKY="$ESC[38;5;51m"
RED="$ESC[38;5;196m"
GREY="$ESC[38;5;244m"
DIM="$ESC[2m"
BOLD="$ESC[1m"
R="$ESC[0m"

step()   { echo ""; echo "  ${BOLD}${GOLD}› $1${R}"; }
ok()     { echo "    ${GREEN}✓${R} $1"; }
info()   { echo "    ${SKY}›${R} ${DIM}$1${R}"; }
fail()   { echo "    ${RED}${BOLD}✗${R} $1"; exit 1; }

clear
echo ""
echo "  ${BOLD}${GOLD}T H E   C O M P E N D I U M${R}"
echo "  ${GREY}Installing the real-time vault plugin…${R}"

# ── Install Obsidian if missing ──────────────────────────────────────────────
step "Installing Obsidian"
if [[ -d "/Applications/Obsidian.app" ]]; then
    ok "Obsidian already installed."
else
    info "Downloading Obsidian…"
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
    ok "Obsidian installed."
fi

# ── Prepare vault + plugin folder ────────────────────────────────────────────
step "Preparing vault"
mkdir -p "$VAULT_PATH/.obsidian/plugins/compendium"
ok "Vault: $VAULT_PATH"

# ── Drop the plugin in ───────────────────────────────────────────────────────
step "Installing the Compendium plugin"
base64 -d > "$VAULT_PATH/.obsidian/plugins/compendium/main.js" <<'__MAIN_JS__'
__MAIN_JS_BASE64__
__MAIN_JS__

base64 -d > "$VAULT_PATH/.obsidian/plugins/compendium/manifest.json" <<'__MANIFEST__'
__MANIFEST_BASE64__
__MANIFEST__

cat > "$VAULT_PATH/.obsidian/plugins/compendium/data.json" <<DATA
{
  "serverUrl": "$SERVER_URL",
  "authToken": "$PLAYER_TOKEN"
}
DATA

cat > "$VAULT_PATH/.obsidian/community-plugins.json" <<PLUGINS
["compendium"]
PLUGINS

ok "Plugin configured with your DM's server."

# ── Verify the server is reachable ───────────────────────────────────────────
step "Pinging the server"
if curl -sfL "$SERVER_URL/api/health" > /dev/null; then
    ok "Server responding."
else
    echo "    ${RED}!${R} Could not reach $SERVER_URL — sync will retry once you're connected."
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "  ${BOLD}${GREEN}Setup complete.${R}"
echo ""
echo "  ${GREEN}›${R} Vault: ${BOLD}$VAULT_PATH${R}"
echo "  ${GREEN}›${R} In Obsidian: ${BOLD}Settings → Community plugins${R} → Turn on, trust this vault."
echo "  ${GREEN}›${R} Compendium will auto-enable and start syncing."
echo ""
sleep 2
open -a Obsidian "$VAULT_PATH" 2>/dev/null || open -a Obsidian
