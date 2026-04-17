#!/usr/bin/env bash
# The Compendium — Mac Setup
# Run in Terminal: bash setup-mac.sh
# Or use the one-liner from the Releases page.

set -e
source /dev/stdin <<< "$(curl -fsSL https://raw.githubusercontent.com/algrifff/dnd-sync/main/scripts/_wizard.sh 2>/dev/null || cat "$(dirname "${BASH_SOURCE[0]}")/_wizard.sh")"

print_step() { echo ""; echo "[$1/5] $2"; }
print_ok()   { echo "  ✓ $1"; }
print_info() { echo "  $1"; }

# ── 1. Install Obsidian ───────────────────────────────────────────────────────
print_step 1 "Checking Obsidian..."
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
    curl -L "$OBSIDIAN_URL" -o /tmp/Obsidian.dmg
    hdiutil attach /tmp/Obsidian.dmg -quiet
    cp -R /Volumes/Obsidian/Obsidian.app /Applications/
    hdiutil detach /Volumes/Obsidian -quiet
    rm /tmp/Obsidian.dmg
    print_ok "Obsidian installed."
fi

# ── 2. Install Syncthing ──────────────────────────────────────────────────────
print_step 2 "Checking Syncthing..."
ST_BIN=""
if command -v syncthing &>/dev/null; then
    ST_BIN=$(command -v syncthing)
    print_ok "Syncthing already installed."
elif command -v brew &>/dev/null; then
    print_info "Installing via Homebrew..."
    brew install syncthing
    ST_BIN=$(command -v syncthing)
    print_ok "Syncthing installed."
else
    print_info "Downloading Syncthing binary..."
    ARCH=$(uname -m)
    [[ "$ARCH" == "arm64" ]] && ST_ARCH="arm64" || ST_ARCH="amd64"
    VERSION=$(curl -s https://api.github.com/repos/syncthing/syncthing/releases/latest \
        | python3 -c "import sys,json; print(json.load(sys.stdin)['tag_name'])")
    FNAME="syncthing-macos-${ST_ARCH}-${VERSION}"
    curl -L "https://github.com/syncthing/syncthing/releases/download/${VERSION}/${FNAME}.tar.gz" \
        -o /tmp/syncthing.tar.gz
    tar -xzf /tmp/syncthing.tar.gz -C /tmp
    sudo mv "/tmp/${FNAME}/syncthing" /usr/local/bin/syncthing
    rm -rf /tmp/syncthing.tar.gz "/tmp/${FNAME}"
    ST_BIN="/usr/local/bin/syncthing"
    print_ok "Syncthing installed."
fi

# ── 3. Create vault folder ────────────────────────────────────────────────────
print_step 3 "Creating vault folder..."
mkdir -p "$VAULT_PATH"
print_ok "Vault folder: $VAULT_PATH"

# ── 4. Start Syncthing and configure ─────────────────────────────────────────
print_step 4 "Connecting to sync server..."
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
    echo "ERROR: Syncthing failed to start."; cat /tmp/syncthing-setup.log; exit 1
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
    > /dev/null || print_info "Note: Could not register — ask your DM to approve your device."

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

print_ok "Connected to sync server."

# ── 5. Auto-start on login ────────────────────────────────────────────────────
print_step 5 "Setting Syncthing to run on login..."
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

echo ""
echo "==============================="
echo "  Setup complete!"
echo "==============================="
echo ""
echo "The vault is syncing in the background."
echo "It may take a few minutes to download everything on first run."
echo ""
echo "Your vault: $VAULT_PATH"
echo "In Obsidian: File > Open Vault > select the folder above."
echo ""
echo "Opening Obsidian..."
sleep 4
open -a Obsidian
