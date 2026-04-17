#!/usr/bin/env bash
# Shared wizard logic — sourced by setup-mac.sh and setup-linux.sh
# Handles: .env loading, interactive prompts, Railway connection validation

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$SCRIPT_DIR/../.env" ]] && source "$SCRIPT_DIR/../.env"
[[ -f "$SCRIPT_DIR/.env"    ]] && source "$SCRIPT_DIR/.env"

FOLDER_ID="${FOLDER_ID:-the-compendium}"
VAULT_PATH="${VAULT_PATH:-$HOME/Documents/The-Compendium}"
LOCAL_ST_API_KEY="compendium-setup-key"

echo ""
echo "==============================="
echo "  The Compendium — Sync Setup  "
echo "==============================="
echo ""
echo "This will install Obsidian and set up the shared vault on your machine."
echo "You'll need two things from your DM before continuing."
echo ""

# Skip prompts if values already loaded from .env
if [[ -z "$RAILWAY_URL" ]]; then
    echo "Step 1 of 2 — Server address"
    echo "  This looks like: https://something.up.railway.app"
    read -rp "  Enter server address: " RAILWAY_URL </dev/tty
    RAILWAY_URL="${RAILWAY_URL%/}"
    echo ""
fi

if [[ -z "$RAILWAY_API_KEY" ]]; then
    echo "Step 2 of 2 — Join key"
    echo "  Your DM should have sent you a join key."
    read -rsp "  Enter join key: " RAILWAY_API_KEY </dev/tty
    echo ""
    echo ""
fi

echo "Verifying connection..."
if ! curl -sfL -H "X-API-Key: $RAILWAY_API_KEY" "$RAILWAY_URL/rest/system/ping" > /dev/null 2>&1; then
    echo ""
    echo "ERROR: Could not connect to the sync server."
    echo "  Check the server address and join key and try again."
    exit 1
fi

RAILWAY_DEVICE_ID=$(curl -sL -H "X-API-Key: $RAILWAY_API_KEY" "$RAILWAY_URL/rest/system/status" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['myID'])")
echo "  Connected!"
echo ""
