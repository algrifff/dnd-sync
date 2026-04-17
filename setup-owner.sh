#!/usr/bin/env bash
# Run this on YOUR machine (the vault owner) after init-railway.sh.
# Works on Linux, WSL, and Mac (Intel + Apple Silicon).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load UI helpers if available (colors + banner). Fall back to plain output otherwise.
if [[ -f "$SCRIPT_DIR/scripts/_ui.sh" ]]; then
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/scripts/_ui.sh"
else
    show_banner() { :; }
    print_step() { echo ""; echo "[$1/4] $2"; }
    print_ok()   { echo "   ✓ $1"; }
    print_info() { echo "   › $1"; }
    print_warn() { echo "   ! $1"; }
    print_err()  { echo "   ✗ $1"; }
    print_done() { echo ""; echo "=== Setup complete! ==="; }
    R=""; BOLD=""; DIM=""; GOLD=""; GREEN=""; GREY=""
fi

UI_TOTAL_STEPS=4

if [[ -f "$SCRIPT_DIR/.env" ]]; then
    source "$SCRIPT_DIR/.env"
else
    print_err ".env file not found. Copy .env.example to .env and fill it in."
    exit 1
fi

FOLDER_ID="${FOLDER_ID:-the-compendium}"
VAULT_PATH="${VAULT_PATH:-$HOME/Documents/The-Compendium}"
LOCAL_API="http://localhost:8384"
LOCAL_API_KEY="${LOCAL_ST_API_KEY:-compendium-local-key}"

if [[ -z "$RAILWAY_URL" || -z "$RAILWAY_API_KEY" || -z "$RAILWAY_DEVICE_ID" ]]; then
    print_err "RAILWAY_URL, RAILWAY_API_KEY, and RAILWAY_DEVICE_ID must all be set in .env"
    exit 1
fi

show_banner
echo "  ${BOLD}${GOLD}🐉  Vault owner setup${R}  ${DIM}${GREY}(uploading the vault to Railway)${R}"

# ── Install Syncthing ─────────────────────────────────────────────────────────
detect_platform() {
    case "$(uname)" in
        Darwin) echo "macos" ;;
        Linux)  echo "linux" ;;
        *)      echo "unsupported" ;;
    esac
}

install_syncthing_binary() {
    local PLATFORM="$1"
    local ARCH
    ARCH=$(uname -m)
    case "$ARCH" in
        arm64|aarch64) ARCH="arm64" ;;
        x86_64|amd64)  ARCH="amd64" ;;
        *) print_err "Unsupported CPU architecture: $ARCH"; exit 1 ;;
    esac

    print_info "Downloading Syncthing (${PLATFORM}-${ARCH})..."
    local VERSION
    VERSION=$(curl -s https://api.github.com/repos/syncthing/syncthing/releases/latest \
        | grep '"tag_name"' | cut -d'"' -f4)
    local FILENAME="syncthing-${PLATFORM}-${ARCH}-${VERSION}"
    # macOS releases are .zip; Linux releases are .tar.gz
    local EXT
    [[ "$PLATFORM" == "macos" ]] && EXT="zip" || EXT="tar.gz"
    local URL="https://github.com/syncthing/syncthing/releases/download/${VERSION}/${FILENAME}.${EXT}"
    local ARCHIVE="/tmp/syncthing.${EXT}"
    if ! curl -fL "$URL" -o "$ARCHIVE"; then
        print_err "Could not download Syncthing from $URL"
        exit 1
    fi
    rm -rf "/tmp/${FILENAME}"
    if [[ "$EXT" == "zip" ]]; then
        unzip -q "$ARCHIVE" -d /tmp
    else
        tar -xzf "$ARCHIVE" -C /tmp
    fi
    sudo mkdir -p /usr/local/bin
    sudo mv "/tmp/${FILENAME}/syncthing" /usr/local/bin/syncthing
    sudo chmod +x /usr/local/bin/syncthing
    rm -rf "$ARCHIVE" "/tmp/${FILENAME}"

    if ! /usr/local/bin/syncthing --version &>/dev/null; then
        print_err "Installed syncthing binary won't execute on this CPU."
        [[ "$PLATFORM" == "macos" ]] && echo "     ${DIM}${GREY}If you're on Apple Silicon, try: softwareupdate --install-rosetta${R}"
        exit 1
    fi
}

print_step 1 "Installing Syncthing"
PLATFORM="$(detect_platform)"
if [[ "$PLATFORM" == "unsupported" ]]; then
    print_err "Unsupported OS: $(uname)"
    exit 1
fi

# Validate existing binary — a prior Intel-brew install on Apple Silicon will fail here.
if command -v syncthing &>/dev/null; then
    if syncthing --version &>/dev/null; then
        print_ok "Syncthing already installed."
    else
        print_warn "Existing syncthing binary won't run on this CPU. Reinstalling with the native one."
        install_syncthing_binary "$PLATFORM"
        hash -r
        print_ok "Syncthing reinstalled."
    fi
else
    install_syncthing_binary "$PLATFORM"
    hash -r
    print_ok "Syncthing installed."
fi

# ── Start Syncthing with a known API key ──────────────────────────────────────
print_step 2 "Starting Syncthing"

if pgrep -x syncthing > /dev/null 2>&1; then
    print_info "Stopping existing Syncthing instance..."
    pkill -x syncthing || true
    sleep 3
fi

STGUIAPIKEY="$LOCAL_API_KEY" syncthing --no-browser --gui-address="127.0.0.1:8384" > /tmp/syncthing-owner.log 2>&1 &
print_info "Waiting for Syncthing API..."
for i in {1..30}; do
    curl -sf -H "X-API-Key: $LOCAL_API_KEY" "$LOCAL_API/rest/system/ping" > /dev/null 2>&1 && break
    sleep 2
done

if ! curl -sf -H "X-API-Key: $LOCAL_API_KEY" "$LOCAL_API/rest/system/ping" > /dev/null 2>&1; then
    print_err "Syncthing did not start. Log output:"
    cat /tmp/syncthing-owner.log
    exit 1
fi

LOCAL_DEVICE_ID=$(curl -s -H "X-API-Key: $LOCAL_API_KEY" "$LOCAL_API/rest/system/status" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['myID'])")
print_ok "Local device ID: $LOCAL_DEVICE_ID"

# ── Wire Syncthing to Railway ─────────────────────────────────────────────────
print_step 3 "Connecting to Railway"

curl -sf -X POST "$LOCAL_API/rest/config/devices" \
    -H "X-API-Key: $LOCAL_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"deviceID\":\"$RAILWAY_DEVICE_ID\",\"name\":\"The Compendium Server\",\"addresses\":[\"dynamic\"],\"autoAcceptFolders\":false}" \
    > /dev/null || true

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

curl -sfL -X POST "$RAILWAY_URL/rest/config/devices" \
    -H "X-API-Key: $RAILWAY_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"deviceID\":\"$LOCAL_DEVICE_ID\",\"name\":\"Owner\",\"addresses\":[\"dynamic\"],\"autoAcceptFolders\":false}" \
    > /dev/null || true

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

print_ok "Connected to Railway."

# ── Done ──────────────────────────────────────────────────────────────────────
print_step 4 "Uploading the vault"
print_ok "Vault is syncing to Railway in the background."

print_done
echo "  ${GREEN}›${R} Watch progress at ${BOLD}http://localhost:8384${R}"
echo "  ${GREEN}›${R} Add this to ${BOLD}.env${R} so future runs reuse the same key:"
echo "       ${DIM}LOCAL_ST_API_KEY=$LOCAL_API_KEY${R}"
echo ""
