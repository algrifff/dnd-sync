#!/usr/bin/env bash
# Run this on YOUR machine (the vault owner) after init-railway.sh.
# Works on Linux, WSL, and Mac.

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
LOCAL_API="http://localhost:8384"
# Use a fixed local API key so we never need to read the config file
LOCAL_API_KEY="${LOCAL_ST_API_KEY:-compendium-local-key}"

if [[ -z "$RAILWAY_URL" || -z "$RAILWAY_API_KEY" || -z "$RAILWAY_DEVICE_ID" ]]; then
    echo "ERROR: RAILWAY_URL, RAILWAY_API_KEY, and RAILWAY_DEVICE_ID must all be set in .env"
    exit 1
fi

echo "=== The Compendium — Owner Setup ==="
echo ""

# ── Install Syncthing ─────────────────────────────────────────────────────────
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
    curl -L "https://github.com/syncthing/syncthing/releases/download/${VERSION}/${FILENAME}.tar.gz" \
        -o /tmp/syncthing.tar.gz
    tar -xzf /tmp/syncthing.tar.gz -C /tmp
    sudo mv "/tmp/${FILENAME}/syncthing" /usr/local/bin/syncthing
    rm -rf /tmp/syncthing.tar.gz "/tmp/${FILENAME}"
}

if command -v syncthing &>/dev/null; then
    echo "[1/4] Syncthing already installed."
elif [[ "$(uname)" == "Darwin" ]] && command -v brew &>/dev/null; then
    brew install syncthing
else
    install_syncthing_binary "$(uname | tr '[:upper:]' '[:lower:]')"
fi

# ── Start Syncthing with a known API key ──────────────────────────────────────
echo "[2/4] Starting Syncthing..."

# Kill any existing instance so we can start with our known API key
if pgrep -x syncthing > /dev/null 2>&1; then
    echo "  Stopping existing Syncthing instance..."
    pkill -x syncthing || true
    sleep 3
fi

STGUIAPIKEY="$LOCAL_API_KEY" syncthing --no-browser --gui-address="127.0.0.1:8384" > /tmp/syncthing-owner.log 2>&1 &
echo "  Waiting for Syncthing API..."
for i in {1..30}; do
    curl -sf -H "X-API-Key: $LOCAL_API_KEY" "$LOCAL_API/rest/system/ping" > /dev/null 2>&1 && break
    sleep 2
done

if ! curl -sf -H "X-API-Key: $LOCAL_API_KEY" "$LOCAL_API/rest/system/ping" > /dev/null 2>&1; then
    echo "ERROR: Syncthing did not start. Log output:"
    cat /tmp/syncthing-owner.log
    exit 1
fi

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
    > /dev/null || true

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
    > /dev/null || true

# Register this device with Railway
curl -sfL -X POST "$RAILWAY_URL/rest/config/devices" \
    -H "X-API-Key: $RAILWAY_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"deviceID\":\"$LOCAL_DEVICE_ID\",\"name\":\"Owner\",\"addresses\":[\"dynamic\"],\"autoAcceptFolders\":false}" \
    > /dev/null || true

# Add this device to Railway's vault folder
FOLDER_CONFIG=$(curl -sL -H "X-API-Key: $RAILWAY_API_KEY" "$RAILWAY_URL/rest/config/folders/$FOLDER_ID")
UPDATED_CONFIG=$(echo "$FOLDER_CONFIG" | python3 -c "
import sys, json
cfg = json.load(sys.stdin)
ids = [d['deviceID'] for d in cfg['devices']]
if '$LOCAL_DEVICE_ID' not in ids:
    cfg['devices'].append({'deviceID': '$LOCAL_DEVICE_ID', 'encryptionPassword': ''})
print(json.dumps(cfg))
")
curl -sfL -X PUT "$RAILWAY_URL/rest/config/folders/$FOLDER_ID" \
    -H "X-API-Key: $RAILWAY_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$UPDATED_CONFIG" \
    > /dev/null

echo "[4/4] Done! Your vault is now syncing to Railway."
echo "  Files will upload in the background — check progress at http://localhost:8384"
echo ""
echo "  Add this to your .env to reuse the same API key next time:"
echo "  LOCAL_ST_API_KEY=$LOCAL_API_KEY"
