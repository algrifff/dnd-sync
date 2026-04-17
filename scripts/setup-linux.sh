#!/usr/bin/env bash
# The Compendium — Linux Setup
# Run: bash setup-linux.sh

set -e

# Load from .env if present (owner use), otherwise fall back to hardcoded values
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$SCRIPT_DIR/../.env" ]] && source "$SCRIPT_DIR/../.env"
[[ -f "$SCRIPT_DIR/.env"    ]] && source "$SCRIPT_DIR/.env"

# ── CONFIG (vault owner: fill these in before sending to friends) ─────────────
RAILWAY_URL="${RAILWAY_URL:-FILL_IN}"
RAILWAY_API_KEY="${RAILWAY_API_KEY:-FILL_IN}"
RAILWAY_DEVICE_ID="${RAILWAY_DEVICE_ID:-FILL_IN}"
FOLDER_ID="${FOLDER_ID:-the-compendium}"
VAULT_PATH="${VAULT_PATH:-$HOME/Documents/The-Compendium}"
LOCAL_ST_API_KEY="compendium-setup-key"
# ─────────────────────────────────────────────────────────────────────────────

if [[ "$RAILWAY_URL" == "FILL_IN" ]]; then
    echo "ERROR: This script hasn't been configured. Ask the vault owner for an updated version."
    exit 1
fi

print_step() { echo ""; echo "[$1/5] $2"; }
print_ok()   { echo "  ✓ $1"; }
print_info() { echo "  $1"; }

echo ""
echo "==============================="
echo "  The Compendium — Sync Setup  "
echo "==============================="

# ── 1. Install Obsidian ───────────────────────────────────────────────────────
print_step 1 "Checking Obsidian..."
OBSIDIAN_BIN="$HOME/.local/bin/obsidian.AppImage"
if command -v obsidian &>/dev/null || [[ -f "$OBSIDIAN_BIN" ]]; then
    print_ok "Obsidian already installed."
else
    print_info "Downloading Obsidian AppImage..."
    OBSIDIAN_URL=$(curl -s https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest \
        | python3 -c "
import sys, json
assets = json.load(sys.stdin)['assets']
url = next((a['browser_download_url'] for a in assets if a['name'].endswith('.AppImage')), None)
if not url: raise SystemExit('No AppImage found')
print(url)
")
    mkdir -p "$HOME/.local/bin"
    curl -L "$OBSIDIAN_URL" -o "$OBSIDIAN_BIN"
    chmod +x "$OBSIDIAN_BIN"

    mkdir -p "$HOME/.local/share/applications"
    cat > "$HOME/.local/share/applications/obsidian.desktop" << EOF
[Desktop Entry]
Name=Obsidian
Exec=$OBSIDIAN_BIN --no-sandbox %u
Terminal=false
Type=Application
Categories=Office;
MimeType=x-scheme-handler/obsidian;
EOF
    xdg-mime default obsidian.desktop x-scheme-handler/obsidian 2>/dev/null || true
    print_ok "Obsidian installed to $OBSIDIAN_BIN"
fi

# ── 2. Install Syncthing ──────────────────────────────────────────────────────
print_step 2 "Checking Syncthing..."
if command -v syncthing &>/dev/null; then
    print_ok "Syncthing already installed."
else
    if command -v apt-get &>/dev/null; then
        print_info "Installing via apt..."
        curl -s https://syncthing.net/release-key.gpg | sudo gpg --dearmor \
            -o /usr/share/keyrings/syncthing-archive-keyring.gpg
        echo "deb [signed-by=/usr/share/keyrings/syncthing-archive-keyring.gpg] https://apt.syncthing.net/ syncthing stable" \
            | sudo tee /etc/apt/sources.list.d/syncthing.list > /dev/null
        sudo apt-get update -qq && sudo apt-get install -y syncthing
    elif command -v dnf &>/dev/null; then
        sudo dnf install -y syncthing
    elif command -v pacman &>/dev/null; then
        sudo pacman -S --noconfirm syncthing
    else
        print_info "Downloading binary..."
        ARCH=$(uname -m)
        [[ "$ARCH" == "aarch64" ]] && ST_ARCH="arm64" || ST_ARCH="amd64"
        VERSION=$(curl -s https://api.github.com/repos/syncthing/syncthing/releases/latest \
            | python3 -c "import sys,json; print(json.load(sys.stdin)['tag_name'])")
        FNAME="syncthing-linux-${ST_ARCH}-${VERSION}"
        curl -L "https://github.com/syncthing/syncthing/releases/download/${VERSION}/${FNAME}.tar.gz" \
            -o /tmp/syncthing.tar.gz
        tar -xzf /tmp/syncthing.tar.gz -C /tmp
        sudo mv "/tmp/${FNAME}/syncthing" /usr/local/bin/syncthing
        rm -rf /tmp/syncthing.tar.gz "/tmp/${FNAME}"
    fi
    print_ok "Syncthing installed."
fi

# ── 3. Create vault folder ────────────────────────────────────────────────────
print_step 3 "Creating vault folder..."
mkdir -p "$VAULT_PATH"
print_ok "Vault folder: $VAULT_PATH"

# ── 4. Start Syncthing with known API key and configure ───────────────────────
print_step 4 "Starting Syncthing..."
ST_DATA="$HOME/.local/share/syncthing"
mkdir -p "$ST_DATA"
LOCAL_API="http://localhost:8384"

# Kill any existing instance so we start with a known API key
if pgrep -x syncthing > /dev/null 2>&1; then
    print_info "Stopping existing Syncthing instance..."
    pkill -x syncthing || true
    sleep 3
fi

STGUIAPIKEY="$LOCAL_ST_API_KEY" syncthing \
    --no-browser \
    --home="$ST_DATA" \
    --gui-address="127.0.0.1:8384" \
    > /tmp/syncthing-setup.log 2>&1 &

print_info "Waiting for Syncthing API..."
for i in {1..30}; do
    curl -sf -H "X-API-Key: $LOCAL_ST_API_KEY" "$LOCAL_API/rest/system/ping" > /dev/null 2>&1 && break
    sleep 2
done
if ! curl -sf -H "X-API-Key: $LOCAL_ST_API_KEY" "$LOCAL_API/rest/system/ping" > /dev/null 2>&1; then
    echo "ERROR: Syncthing failed to start. Log:"; cat /tmp/syncthing-setup.log; exit 1
fi

LOCAL_DEVICE_ID=$(curl -s -H "X-API-Key: $LOCAL_ST_API_KEY" "$LOCAL_API/rest/system/status" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['myID'])")
print_info "Your device ID: $LOCAL_DEVICE_ID"

# Add Railway device locally
curl -sf -X POST "$LOCAL_API/rest/config/devices" \
    -H "X-API-Key: $LOCAL_ST_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"deviceID\":\"$RAILWAY_DEVICE_ID\",\"name\":\"The Compendium Server\",\"addresses\":[\"dynamic\"],\"autoAcceptFolders\":false}" \
    > /dev/null || true

# Add vault folder locally
curl -sf -X POST "$LOCAL_API/rest/config/folders" \
    -H "X-API-Key: $LOCAL_ST_API_KEY" \
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
curl -sfL -X POST "$RAILWAY_URL/rest/config/devices" \
    -H "X-API-Key: $RAILWAY_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"deviceID\":\"$LOCAL_DEVICE_ID\",\"name\":\"$(hostname)\",\"addresses\":[\"dynamic\"],\"autoAcceptFolders\":false}" \
    > /dev/null || print_info "Note: Could not register with server — vault owner may need to approve your device."

# Add this device to Railway's vault folder (with duplicate guard)
FOLDER_CFG=$(curl -sL -H "X-API-Key: $RAILWAY_API_KEY" "$RAILWAY_URL/rest/config/folders/$FOLDER_ID")
UPDATED=$(echo "$FOLDER_CFG" | python3 -c "
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
    -d "$UPDATED" > /dev/null || true

print_ok "Connected to sync server."

# ── 5. Auto-start Syncthing via systemd ──────────────────────────────────────
print_step 5 "Setting Syncthing to run on login..."
if command -v systemctl &>/dev/null && systemctl --user status > /dev/null 2>&1; then
    # Try enabling the packaged unit first, then fall back to writing our own
    if ! systemctl --user enable --now syncthing 2>/dev/null; then
        mkdir -p "$HOME/.config/systemd/user"
        cat > "$HOME/.config/systemd/user/syncthing.service" << EOF
[Unit]
Description=Syncthing

[Service]
ExecStart=$(command -v syncthing) --no-browser --home=$ST_DATA --gui-address=127.0.0.1:8384
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
        systemctl --user daemon-reload
        systemctl --user enable --now syncthing
    fi
    print_ok "Syncthing will start automatically on login."
else
    print_info "No systemd user session found. Start Syncthing manually with:"
    print_info "  syncthing --no-browser --home=$ST_DATA"
fi

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
echo "In Obsidian: File > Open Vault > select the folder above."
