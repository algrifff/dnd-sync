#!/usr/bin/env bash
# Run this on YOUR machine (the vault owner) after init-railway.sh.
# This connects your existing local vault to Railway.
# Works on Linux and Mac.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/.env" ]]; then
    source "$SCRIPT_DIR/.env"
else
    echo "ERROR: .env file not found. Copy .env.example to .env and fill in all values."
    exit 1
fi

FOLDER_ID="${FOLDER_ID:-the-compendium}"
VAULT_PATH="${VAULT_PATH:-$HOME/Documents/The-Compendium}"

if [[ -z "$RAILWAY_URL" || -z "$RAILWAY_API_KEY" || -z "$RAILWAY_DEVICE_ID" ]]; then
    echo "ERROR: RAILWAY_URL, RAILWAY_API_KEY, and RAILWAY_DEVICE_ID must all be set in .env"
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

# Read local API key from config — check all known locations
CONFIG_PATH=""
for candidate in \
    "$HOME/Library/Application Support/Syncthing/config.xml" \
    "$HOME/.local/share/syncthing/config.xml" \
    "$HOME/.config/syncthing/config.xml" \
    "${XDG_DATA_HOME:-$HOME/.local/share}/syncthing/config.xml"; do
    if [[ -f "$candidate" ]]; then
        CONFIG_PATH="$candidate"
        break
    fi
done

if [[ -z "$CONFIG_PATH" ]]; then
    echo "ERROR: Could not find Syncthing config. Searched:"
    echo "  ~/.local/share/syncthing/config.xml"
    echo "  ~/.config/syncthing/config.xml"
    echo "Try running 'syncthing --no-browser' manually, wait 10 seconds, then re-run this script."
    exit 1
fi
echo "  Config found at: $CONFIG_PATH"
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
curl -sfL -X POST "$RAILWAY_URL/rest/config/devices" \
    -H "X-API-Key: $RAILWAY_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"deviceID\":\"$LOCAL_DEVICE_ID\",\"name\":\"Owner\",\"addresses\":[\"dynamic\"],\"autoAcceptFolders\":false}" \
    > /dev/null

# Update Railway folder to include your device
FOLDER_CONFIG=$(curl -sL -H "X-API-Key: $RAILWAY_API_KEY" "$RAILWAY_URL/rest/config/folders/$FOLDER_ID")
UPDATED_CONFIG=$(echo "$FOLDER_CONFIG" | python3 -c "
import sys, json
cfg = json.load(sys.stdin)
cfg['devices'].append({'deviceID': '$LOCAL_DEVICE_ID', 'encryptionPassword': ''})
print(json.dumps(cfg))
")
curl -sfL -X PUT "$RAILWAY_URL/rest/config/folders/$FOLDER_ID" \
    -H "X-API-Key: $RAILWAY_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$UPDATED_CONFIG" \
    > /dev/null

echo "[4/4] Done! Your vault is now syncing to Railway."
echo "  Files will upload in the background — this may take a few minutes for the first sync."
echo ""
echo "Share the setup scripts in compendium-sync/scripts/ with your friends."
