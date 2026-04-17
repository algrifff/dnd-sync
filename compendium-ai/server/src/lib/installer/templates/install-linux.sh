#!/usr/bin/env bash
# Compendium one-click installer for Linux.

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

step() { echo ""; echo "  ${BOLD}${GOLD}› $1${R}"; }
ok()   { echo "    ${GREEN}✓${R} $1"; }
info() { echo "    ${SKY}›${R} ${DIM}$1${R}"; }

clear
echo ""
echo "  ${BOLD}${GOLD}T H E   C O M P E N D I U M${R}"
echo "  ${GREY}Installing the real-time vault plugin…${R}"

# ── Install Obsidian if missing ──────────────────────────────────────────────
find_obsidian() {
    if command -v obsidian >/dev/null 2>&1; then
        command -v obsidian; return 0
    fi
    local candidates=(
        "$HOME/.local/bin/obsidian.AppImage"
        "$HOME/Applications/Obsidian.AppImage"
        "/opt/Obsidian/obsidian"
        "/usr/bin/obsidian"
    )
    for p in "${candidates[@]}"; do
        if [[ -e "$p" ]]; then echo "$p"; return 0; fi
    done
    # Flatpak install
    if command -v flatpak >/dev/null 2>&1 && flatpak info md.obsidian.Obsidian >/dev/null 2>&1; then
        echo "flatpak:md.obsidian.Obsidian"; return 0
    fi
    # Snap install
    if command -v snap >/dev/null 2>&1 && snap list obsidian >/dev/null 2>&1; then
        echo "snap:obsidian"; return 0
    fi
    return 1
}

step "Installing Obsidian"
OBSIDIAN_BIN="$HOME/.local/bin/obsidian.AppImage"
if obsidian_path=$(find_obsidian); then
    ok "Obsidian already installed ($obsidian_path)."
else
    info "Downloading the Obsidian AppImage…"
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

echo ""
echo "  ${BOLD}${GREEN}Setup complete.${R}"
echo "  ${GREEN}›${R} Vault: ${BOLD}$VAULT_PATH${R}"
echo "  ${GREEN}›${R} Open Obsidian, Settings → Community plugins → turn on + trust this vault."
echo ""
if [[ -x "$OBSIDIAN_BIN" ]]; then
    ("$OBSIDIAN_BIN" --no-sandbox "$VAULT_PATH" &) >/dev/null 2>&1 || true
fi
