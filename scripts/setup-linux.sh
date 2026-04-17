#!/usr/bin/env bash
# The Compendium — Linux Setup
# Run: bash setup-linux.sh

set -e

# ── CONFIG (filled in by vault owner) ─────────────────────────────────────────
RAILWAY_URL="FILL_IN"         # e.g. https://compendium.up.railway.app
RAILWAY_API_KEY="FILL_IN"     # Syncthing API key
RAILWAY_DEVICE_ID="FILL_IN"   # Railway device ID
FOLDER_ID="the-compendium"
VAULT_PATH="$HOME/Documents/The-Compendium"
# ─────────────────────────────────────────────────────────────────────────────

if [[ "$RAILWAY_URL" == "FILL_IN" ]]; then
    echo "ERROR: This script hasn't been configured. Ask the vault owner for an updated version."
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
if command -v obsidian &>/dev/null || [[ -f "/opt/Obsidian/obsidian" ]]; then
    print_ok "Obsidian already installed."
else
    echo "  Downloading Obsidian AppImage..."
    OBSIDIAN_URL=$(curl -s https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest \
        | python3 -c "import sys,json; assets=json.load(sys.stdin)['assets']; print(next(a['browser_download_url'] for a in assets if a['name'].endswith('.AppImage')))")
    mkdir -p "$HOME/.local/bin"
    curl -L "$OBSIDIAN_URL" -o "$HOME/.local/bin/obsidian.AppImage"
    chmod +x "$HOME/.local/bin/obsidian.AppImage"

    # Create desktop shortcut
    mkdir -p "$HOME/.local/share/applications"
    cat > "$HOME/.local/share/applications/obsidian.desktop" << EOF
[Desktop Entry]
Name=Obsidian
Exec=$HOME/.local/bin/obsidian.AppImage --no-sandbox %u
Terminal=false
Type=Application
Categories=Office;
MimeType=x-scheme-handler/obsidian;
EOF
    xdg-mime default obsidian.desktop x-scheme-handler/obsidian 2>/dev/null || true
    print_ok "Obsidian installed to ~/.local/bin/obsidian.AppImage"
fi

# ── 2. Install Syncthing ──────────────────────────────────────────────────────
print_step 2 "Checking Syncthing..."
if command -v syncthing &>/dev/null; then
    print_ok "Syncthing already installed."
else
    # Try package manager first
    if command -v apt-get &>/dev/null; then
        echo "  Installing via apt..."
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
        echo "  Downloading binary..."
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

# ── 4. Start Syncthing and configure ─────────────────────────────────────────
print_step 4 "Starting Syncthing..."
ST_DATA="$HOME/.local/share/syncthing"
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

# ── 5. Auto-start Syncthing via systemd ──────────────────────────────────────
print_step 5 "Setting Syncthing to run on login..."
if command -v systemctl &>/dev/null; then
    systemctl --user enable syncthing 2>/dev/null || \
    systemctl --user enable "syncthing@$USER" 2>/dev/null || {
        # Fallback: write a user service manually
        mkdir -p "$HOME/.config/systemd/user"
        cat > "$HOME/.config/systemd/user/syncthing.service" << EOF
[Unit]
Description=Syncthing

[Service]
ExecStart=$(command -v syncthing) --no-browser --home=$ST_DATA
Restart=on-failure

[Install]
WantedBy=default.target
EOF
        systemctl --user enable syncthing
        systemctl --user start syncthing
    }
    print_ok "Syncthing will start automatically on login."
else
    echo "  (No systemd found — start Syncthing manually with: syncthing --no-browser)"
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
echo "Open Obsidian and select that folder as your vault."
