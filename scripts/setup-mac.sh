#!/usr/bin/env bash
# The Compendium — Mac Setup
# Double-click or run: bash setup-mac.sh

set -e

# Load from .env if present (for local use), otherwise use hardcoded values below
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$SCRIPT_DIR/../.env" ]] && source "$SCRIPT_DIR/../.env"
[[ -f "$SCRIPT_DIR/.env" ]] && source "$SCRIPT_DIR/.env"

# ── CONFIG — vault owner: fill these in before sending to friends ──────────────
RAILWAY_URL="${RAILWAY_URL:-FILL_IN}"
RAILWAY_API_KEY="${RAILWAY_API_KEY:-FILL_IN}"
RAILWAY_DEVICE_ID="${RAILWAY_DEVICE_ID:-FILL_IN}"
FOLDER_ID="${FOLDER_ID:-the-compendium}"
VAULT_PATH="${VAULT_PATH:-$HOME/Documents/The-Compendium}"
# ─────────────────────────────────────────────────────────────────────────────

if [[ "$RAILWAY_URL" == "FILL_IN" ]]; then
    echo "ERROR: This script hasn't been configured. Ask the vault owner for an updated version."
    read -p "Press Enter to exit."
    exit 1
fi

print_step() { echo ""; echo "[$1/5] $2"; }
print_ok()   { echo "  ✓ $1"; }

echo ""
echo "==============================="
echo "  The Compendium — Sync Setup  "
echo "==============================="

# ── 1. Install Obsidian ───────────────────────────────────────────────────────
print_step 1 "Checking Obsidian..."
if [[ -d "/Applications/Obsidian.app" ]]; then
    print_ok "Obsidian already installed."
else
    echo "  Downloading Obsidian..."
    OBSIDIAN_URL=$(curl -s https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest \
        | python3 -c "import sys,json; assets=json.load(sys.stdin)['assets']; print(next(a['browser_download_url'] for a in assets if a['name'].endswith('.dmg') and 'arm64' not in a['name'] or 'universal' in a['name']))" 2>/dev/null \
        || curl -s https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest \
        | python3 -c "import sys,json; assets=json.load(sys.stdin)['assets']; print(next(a['browser_download_url'] for a in assets if a['name'].endswith('.dmg')))")
    curl -L "$OBSIDIAN_URL" -o /tmp/Obsidian.dmg
    hdiutil attach /tmp/Obsidian.dmg -quiet
    cp -R /Volumes/Obsidian/Obsidian.app /Applications/
    hdiutil detach /Volumes/Obsidian -quiet
    rm /tmp/Obsidian.dmg
    print_ok "Obsidian installed."
fi

# ── 2. Install Syncthing ──────────────────────────────────────────────────────
print_step 2 "Checking Syncthing..."
if command -v syncthing &>/dev/null; then
    print_ok "Syncthing already installed."
else
    if command -v brew &>/dev/null; then
        echo "  Installing via Homebrew..."
        brew install syncthing
        print_ok "Syncthing installed via Homebrew."
    else
        echo "  Downloading Syncthing..."
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
        print_ok "Syncthing installed."
    fi
fi

# ── 3. Create vault folder ────────────────────────────────────────────────────
print_step 3 "Creating vault folder..."
mkdir -p "$VAULT_PATH"
print_ok "Vault folder: $VAULT_PATH"

# ── 4. Start Syncthing and configure ─────────────────────────────────────────
print_step 4 "Starting Syncthing..."
ST_DATA="$HOME/Library/Application Support/Syncthing"
mkdir -p "$ST_DATA"

if ! pgrep -x syncthing > /dev/null 2>&1; then
    syncthing --no-browser --home="$ST_DATA" &
    echo "  Waiting for Syncthing to start..."
    sleep 8
fi

LOCAL_API="http://localhost:8384"
for i in {1..20}; do
    curl -sf "$LOCAL_API/rest/system/ping" > /dev/null 2>&1 && break
    sleep 3
done

LOCAL_API_KEY=$(grep -oE '<apikey>[^<]+' "$ST_DATA/config.xml" | cut -d'>' -f2)
LOCAL_DEVICE_ID=$(curl -s -H "X-API-Key: $LOCAL_API_KEY" "$LOCAL_API/rest/system/status" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['myID'])")
echo "  Your device ID: $LOCAL_DEVICE_ID"

# Add Railway device locally
curl -sf -X POST "$LOCAL_API/rest/config/devices" \
    -H "X-API-Key: $LOCAL_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"deviceID\":\"$RAILWAY_DEVICE_ID\",\"name\":\"The Compendium Server\",\"addresses\":[\"dynamic\"],\"autoAcceptFolders\":false}" \
    > /dev/null || true

# Add vault folder locally
curl -sf -X POST "$LOCAL_API/rest/config/folders" \
    -H "X-API-Key: $LOCAL_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{
        \"id\": \"$FOLDER_ID\",
        \"label\": \"The Compendium\",
        \"path\": \"$VAULT_PATH\",
        \"type\": \"sendreceive\",
        \"devices\": [{\"deviceID\": \"$RAILWAY_DEVICE_ID\"}],
        \"rescanIntervalS\": 30,
        \"fsWatcherEnabled\": true
    }" \
    > /dev/null || true

# Register with Railway
curl -sf -X POST "$RAILWAY_URL/rest/config/devices" \
    -H "X-API-Key: $RAILWAY_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"deviceID\":\"$LOCAL_DEVICE_ID\",\"name\":\"$(hostname)\",\"addresses\":[\"dynamic\"],\"autoAcceptFolders\":false}" \
    > /dev/null || echo "  Note: Could not auto-register. Vault owner may need to approve your device."

# Add this device to Railway's vault folder
FOLDER_CFG=$(curl -s -H "X-API-Key: $RAILWAY_API_KEY" "$RAILWAY_URL/rest/config/folders/$FOLDER_ID")
UPDATED=$(echo "$FOLDER_CFG" | python3 -c "
import sys, json
cfg = json.load(sys.stdin)
cfg['devices'].append({'deviceID': '$LOCAL_DEVICE_ID', 'encryptionPassword': ''})
print(json.dumps(cfg))
")
curl -sf -X PUT "$RAILWAY_URL/rest/config/folders/$FOLDER_ID" \
    -H "X-API-Key: $RAILWAY_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$UPDATED" > /dev/null || true

print_ok "Connected to sync server."

# ── 5. Auto-start Syncthing on login ─────────────────────────────────────────
print_step 5 "Setting Syncthing to run on login..."
PLIST="$HOME/Library/LaunchAgents/net.syncthing.syncthing.plist"
if [[ ! -f "$PLIST" ]]; then
    cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>net.syncthing.syncthing</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(command -v syncthing)</string>
        <string>--no-browser</string>
        <string>--home=$ST_DATA</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
EOF
    launchctl load "$PLIST"
fi
print_ok "Syncthing will start automatically on login."

echo ""
echo "==============================="
echo "  Setup complete!"
echo "==============================="
echo ""
echo "The vault is syncing in the background."
echo "It may take a few minutes to download everything on first run."
echo ""
echo "Your vault will be at:"
echo "  $VAULT_PATH"
echo ""
echo "Opening Obsidian..."
sleep 4
open -a Obsidian
