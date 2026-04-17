#!/usr/bin/env bash
# The Compendium — Mac Setup
# Run: curl -fsSL https://raw.githubusercontent.com/algrifff/dnd-sync/main/scripts/setup-mac.sh | bash

set -e

# Load shared wizard (banner + prompts + helpers). Curl fallback handles piped invocation.
_WIZARD_URL="https://raw.githubusercontent.com/algrifff/dnd-sync/main/scripts/_wizard.sh"
_LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)" || _LOCAL_DIR=""
if [[ -n "$_LOCAL_DIR" && -f "$_LOCAL_DIR/_wizard.sh" ]]; then
    source "$_LOCAL_DIR/_wizard.sh"
else
    source /dev/stdin <<< "$(curl -fsSL "$_WIZARD_URL")"
fi

UI_TOTAL_STEPS=5

# ── 1. Install Obsidian ───────────────────────────────────────────────────────
print_step 1 "Installing Obsidian"
if [[ -d "/Applications/Obsidian.app" ]]; then
    print_ok "Obsidian already installed."
else
    print_info "Downloading latest Obsidian DMG..."
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

# ── 2. Install Syncthing (arch-aware, direct download to avoid Intel-brew on M-series) ─
print_step 2 "Installing Syncthing"
ARCH=$(uname -m)
case "$ARCH" in
    arm64)  ST_ARCH="arm64" ;;
    x86_64) ST_ARCH="amd64" ;;
    *)      print_err "Unsupported CPU architecture: $ARCH"; exit 1 ;;
esac

# Validate any existing binary actually runs on this CPU (detects Intel-on-ARM breakage).
ST_BIN=""
if command -v syncthing &>/dev/null; then
    _existing="$(command -v syncthing)"
    if "$_existing" --version &>/dev/null; then
        ST_BIN="$_existing"
        print_ok "Syncthing already installed ($ST_BIN)."
    else
        print_warn "Found broken Syncthing at $_existing (wrong architecture?). Reinstalling."
    fi
fi

if [[ -z "$ST_BIN" ]]; then
    print_info "Downloading Syncthing (macos-${ST_ARCH})..."
    VERSION=$(curl -s https://api.github.com/repos/syncthing/syncthing/releases/latest \
        | python3 -c "import sys,json; print(json.load(sys.stdin)['tag_name'])")
    FNAME="syncthing-macos-${ST_ARCH}-${VERSION}"
    # macOS assets are distributed as .zip
    URL="https://github.com/syncthing/syncthing/releases/download/${VERSION}/${FNAME}.zip"
    if ! curl -fL "$URL" -o /tmp/syncthing.zip; then
        print_err "Could not download Syncthing from $URL"
        exit 1
    fi
    rm -rf "/tmp/${FNAME}"
    unzip -q /tmp/syncthing.zip -d /tmp
    sudo mkdir -p /usr/local/bin
    sudo mv "/tmp/${FNAME}/syncthing" /usr/local/bin/syncthing
    sudo chmod +x /usr/local/bin/syncthing
    rm -rf /tmp/syncthing.zip "/tmp/${FNAME}"
    ST_BIN="/usr/local/bin/syncthing"

    if ! "$ST_BIN" --version &>/dev/null; then
        print_err "Syncthing won't run on this Mac. If you're on Apple Silicon, install Rosetta: softwareupdate --install-rosetta"
        exit 1
    fi
    print_ok "Syncthing installed."
fi

# ── 3. Create vault folder ────────────────────────────────────────────────────
print_step 3 "Preparing vault folder"
mkdir -p "$VAULT_PATH"
print_ok "Vault folder ready: $VAULT_PATH"

# ── 4. Start Syncthing and wire everything up ─────────────────────────────────
print_step 4 "Connecting to the sync server"
ST_DATA="$HOME/Library/Application Support/Syncthing"
mkdir -p "$ST_DATA"
LOCAL_API="http://localhost:8384"

if pgrep -x syncthing > /dev/null 2>&1; then
    print_info "Stopping existing Syncthing instance..."
    pkill -x syncthing || true
    sleep 3
fi

STGUIAPIKEY="$LOCAL_ST_API_KEY" "$ST_BIN" \
    --no-browser --home="$ST_DATA" --gui-address="127.0.0.1:8384" \
    > /tmp/syncthing-setup.log 2>&1 &

print_info "Waiting for Syncthing to start..."
for i in {1..30}; do
    curl -sf -H "X-API-Key: $LOCAL_ST_API_KEY" "$LOCAL_API/rest/system/ping" > /dev/null 2>&1 && break
    sleep 2
done
if ! curl -sf -H "X-API-Key: $LOCAL_ST_API_KEY" "$LOCAL_API/rest/system/ping" > /dev/null 2>&1; then
    print_err "Syncthing failed to start. Log:"
    cat /tmp/syncthing-setup.log
    exit 1
fi

LOCAL_DEVICE_ID=$(curl -s -H "X-API-Key: $LOCAL_ST_API_KEY" "$LOCAL_API/rest/system/status" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['myID'])")

curl -sf -X POST "$LOCAL_API/rest/config/devices" \
    -H "X-API-Key: $LOCAL_ST_API_KEY" -H "Content-Type: application/json" \
    -d "{\"deviceID\":\"$RAILWAY_DEVICE_ID\",\"name\":\"The Compendium Server\",\"addresses\":[\"dynamic\"],\"autoAcceptFolders\":false}" \
    > /dev/null || true

curl -sf -X POST "$LOCAL_API/rest/config/folders" \
    -H "X-API-Key: $LOCAL_ST_API_KEY" -H "Content-Type: application/json" \
    -d "{\"id\":\"$FOLDER_ID\",\"label\":\"The Compendium\",\"path\":\"$VAULT_PATH\",\"type\":\"sendreceive\",\"devices\":[{\"deviceID\":\"$RAILWAY_DEVICE_ID\"}],\"rescanIntervalS\":30,\"fsWatcherEnabled\":true}" \
    > /dev/null || true

curl -sfL -X POST "$RAILWAY_URL/rest/config/devices" \
    -H "X-API-Key: $RAILWAY_API_KEY" -H "Content-Type: application/json" \
    -d "{\"deviceID\":\"$LOCAL_DEVICE_ID\",\"name\":\"$(hostname)\",\"addresses\":[\"dynamic\"],\"autoAcceptFolders\":false}" \
    > /dev/null || print_warn "Could not auto-register — ask your DM to approve your device in the Syncthing UI."

FOLDER_CFG=$(curl -sL -H "X-API-Key: $RAILWAY_API_KEY" "$RAILWAY_URL/rest/config/folders/$FOLDER_ID")
UPDATED=$(echo "$FOLDER_CFG" | python3 -c "
import sys, json
cfg = json.load(sys.stdin)
if '$LOCAL_DEVICE_ID' not in [d['deviceID'] for d in cfg['devices']]:
    cfg['devices'].append({'deviceID': '$LOCAL_DEVICE_ID', 'encryptionPassword': ''})
print(json.dumps(cfg))
")
curl -sfL -X PUT "$RAILWAY_URL/rest/config/folders/$FOLDER_ID" \
    -H "X-API-Key: $RAILWAY_API_KEY" -H "Content-Type: application/json" \
    -d "$UPDATED" > /dev/null || true

print_ok "Connected and sharing the vault folder."

# ── 5. Auto-start on login ────────────────────────────────────────────────────
print_step 5 "Enabling auto-start on login"
mkdir -p "$HOME/Library/LaunchAgents"
PLIST="$HOME/Library/LaunchAgents/net.syncthing.syncthing.plist"

if command -v brew &>/dev/null && brew list syncthing &>/dev/null 2>&1; then
    brew services start syncthing 2>/dev/null || true
    print_ok "Syncthing managed by Homebrew services."
elif [[ ! -f "$PLIST" ]]; then
    cat > "$PLIST" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>net.syncthing.syncthing</string>
    <key>ProgramArguments</key>
    <array>
        <string>${ST_BIN}</string>
        <string>--no-browser</string>
        <string>--home=${ST_DATA}</string>
        <string>--gui-address=127.0.0.1:8384</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
</dict>
</plist>
PLIST_EOF
    launchctl load "$PLIST"
    print_ok "Syncthing will start automatically on login."
else
    print_ok "Syncthing login item already configured."
fi

print_done
echo "  ${GREEN}›${R} Your vault: ${BOLD}$VAULT_PATH${R}"
echo "  ${GREEN}›${R} In Obsidian: ${BOLD}File → Open Vault${R} → select that folder."
echo "  ${GREEN}›${R} Status dashboard: ${BOLD}http://localhost:8384${R}"
echo ""
echo "  ${DIM}${GREY}First sync can take a few minutes. Opening Obsidian...${R}"
sleep 3
open -a Obsidian
