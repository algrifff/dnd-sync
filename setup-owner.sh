#!/usr/bin/env bash
# Run this on YOUR machine (the vault owner) after init-railway.sh.
# This connects your existing local vault to Railway.
# Works on Linux and Mac.

set -e

# ── FILL THESE IN after running init-railway.sh ──────────────────────────────
RAILWAY_URL="FILL_IN_AFTER_RAILWAY_DEPLOY"
RAILWAY_API_KEY="FILL_IN_AFTER_RAILWAY_DEPLOY"
RAILWAY_DEVICE_ID="FILL_IN_AFTER_RAILWAY_DEPLOY"
FOLDER_ID="the-compendium"
# Path to your existing vault — adjust if different
VAULT_PATH="$HOME/Documents/dnd/The-Compendium"
# ─────────────────────────────────────────────────────────────────────────────

if [[ "$RAILWAY_URL" == FILL* ]]; then
    echo "ERROR: Fill in RAILWAY_URL, RAILWAY_API_KEY, and RAILWAY_DEVICE_ID at the top of this script first."
    exit 1
fi

echo "=== The Compendium — Owner Setup ==="
echo ""

# ── Install Syncthing ─────────────────────────────────────────────────────────
install_syncthing_mac() {
    if command -v brew &>/dev/null; then
        echo "[1/4] Installing Syncthing via Homebrew..."
        brew install syncthing
        brew services start syncthing
    else
        install_syncthing_binary "darwin"
    fi
}

install_syncthing_binary() {
    local OS="$1"
    local ARCH
    ARCH=$(uname -m)
    [[ "$ARCH" == "arm64" || "$ARCH" == "aarch64" ]] && ARCH="arm64" || ARCH="amd64"

    echo "[1/4] Downloading Syncthing..."
    local VERSION
    VERSION=$(curl -s https://api.github.com/repos/syncthing/syncthing/releases/latest \
        | grep '"tag_name"' | cut -d'"' -f4)
    local FILENAME="syncthing-${OS}-${ARCH}-${VERSION}"
    local URL="https://github.com/syncthing/syncthing/releases/download/${VERSION}/${FILENAME}.tar.gz"

    curl -L "$URL" -o /tmp/syncthing.tar.gz
    tar -xzf /tmp/syncthing.tar.gz -C /tmp
    sudo mv "/tmp/${FILENAME}/syncthing" /usr/local/bin/syncthing
    rm -rf /tmp/syncthing.tar.gz "/tmp/${FILENAME}"
    echo "  Installed to /usr/local/bin/syncthing"
}

if command -v syncthing &>/dev/null; then
    echo "[1/4] Syncthing already installed."
elif [[ "$(uname)" == "Darwin" ]]; then
    install_syncthing_mac
else
    install_syncthing_binary "linux"
fi

# ── Start Syncthing ───────────────────────────────────────────────────────────
echo "[2/4] Starting Syncthing..."
if ! pgrep -x syncthing > /dev/null; then
    syncthing --no-browser &
    sleep 6
fi

# Wait for API
LOCAL_API="http://localhost:8384"
echo "  Waiting for Syncthing API..."
for i in {1..30}; do
    curl -sf "$LOCAL_API/rest/system/ping" > /dev/null 2>&1 && break
    sleep 2
done

# Read local API key from config
if [[ "$(uname)" == "Darwin" ]]; then
    CONFIG_PATH="$HOME/Library/Application Support/Syncthing/config.xml"
else
    CONFIG_PATH="$HOME/.local/share/syncthing/config.xml"
fi
LOCAL_API_KEY=$(grep -oP '(?<=<apikey>)[^<]+' "$CONFIG_PATH")

# Get local device ID
LOCAL_DEVICE_ID=$(curl -s -H "X-API-Key: $LOCAL_API_KEY" "$LOCAL_API/rest/system/status" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['myID'])")
echo "  Your device ID: $LOCAL_DEVICE_ID"

# ── Wire up Syncthing ─────────────────────────────────────────────────────────
echo "[3/4] Connecting to Railway..."

# Add Railway as a device locally
curl -sf -X POST "$LOCAL_API/rest/config/devices" \
    -H "X-API-Key: $LOCAL_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"deviceID\":\"$RAILWAY_DEVICE_ID\",\"name\":\"The Compendium Server\",\"addresses\":[\"dynamic\"],\"autoAcceptFolders\":false}" \
    > /dev/null

# Add vault folder locally, shared with Railway
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
    > /dev/null

# Register your device with Railway and share folder
curl -sf -X POST "$RAILWAY_URL/rest/config/devices" \
    -H "X-API-Key: $RAILWAY_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"deviceID\":\"$LOCAL_DEVICE_ID\",\"name\":\"Owner\",\"addresses\":[\"dynamic\"],\"autoAcceptFolders\":false}" \
    > /dev/null

# Update Railway folder to include your device
FOLDER_CONFIG=$(curl -s -H "X-API-Key: $RAILWAY_API_KEY" "$RAILWAY_URL/rest/config/folders/$FOLDER_ID")
UPDATED_CONFIG=$(echo "$FOLDER_CONFIG" | python3 -c "
import sys, json
cfg = json.load(sys.stdin)
cfg['devices'].append({'deviceID': '$LOCAL_DEVICE_ID', 'encryptionPassword': ''})
print(json.dumps(cfg))
")
curl -sf -X PUT "$RAILWAY_URL/rest/config/folders/$FOLDER_ID" \
    -H "X-API-Key: $RAILWAY_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$UPDATED_CONFIG" \
    > /dev/null

echo "[4/4] Done! Your vault is now syncing to Railway."
echo "  Files will upload in the background — this may take a few minutes for the first sync."
echo ""
echo "Share the setup scripts in compendium-sync/scripts/ with your friends."
