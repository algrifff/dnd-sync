#!/usr/bin/env bash
# Run this ONCE after your first Railway deploy to create the vault folder.
# Usage: ./init-railway.sh <railway-url> <api-key>
# Example: ./init-railway.sh https://compendium.up.railway.app abc123xyz

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/.env" ]]; then
    source "$SCRIPT_DIR/.env"
else
    echo "ERROR: .env file not found. Copy .env.example to .env and fill in RAILWAY_URL and RAILWAY_API_KEY."
    exit 1
fi

FOLDER_ID="${FOLDER_ID:-the-compendium}"
FOLDER_PATH="/var/syncthing/The-Compendium"

if [[ -z "$RAILWAY_URL" || -z "$RAILWAY_API_KEY" ]]; then
    echo "ERROR: RAILWAY_URL and RAILWAY_API_KEY must be set in .env"
    exit 1
fi

echo "Waiting for Syncthing to be ready..."
until curl -sfL -H "X-API-Key: $RAILWAY_API_KEY" "$RAILWAY_URL/rest/system/ping" > /dev/null 2>&1; do
    printf "."
    sleep 3
done
echo " ready."

echo "Fetching Railway device ID..."
STATUS_RESPONSE=$(curl -sL -H "X-API-Key: $RAILWAY_API_KEY" "$RAILWAY_URL/rest/system/status")
echo "  Raw response: $STATUS_RESPONSE"
DEVICE_ID=$(echo "$STATUS_RESPONSE" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['myID'])")
echo "  Railway device ID: $DEVICE_ID"

echo "Creating vault folder on Railway..."
HTTP_STATUS=$(curl -sL -o /dev/null -w "%{http_code}" -X POST \
    -H "X-API-Key: $RAILWAY_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{
        \"id\": \"$FOLDER_ID\",
        \"label\": \"The Compendium\",
        \"path\": \"$FOLDER_PATH\",
        \"type\": \"sendreceive\",
        \"devices\": [],
        \"rescanIntervalS\": 30,
        \"fsWatcherEnabled\": true
    }" \
    "$RAILWAY_URL/rest/config/folders")

if [[ "$HTTP_STATUS" == "200" || "$HTTP_STATUS" == "201" ]]; then
    echo "  Folder created."
else
    echo "  Warning: got HTTP $HTTP_STATUS — folder may already exist, continuing."
fi

echo ""
echo "========================================================"
echo "  Copy these values into the three setup scripts:"
echo "========================================================"
echo "  RAILWAY_URL      = $RAILWAY_URL"
echo "  RAILWAY_API_KEY  = $RAILWAY_API_KEY"
echo "  RAILWAY_DEVICE_ID = $DEVICE_ID"
echo "  FOLDER_ID        = $FOLDER_ID"
echo "========================================================"
echo ""
echo "Next: add RAILWAY_DEVICE_ID to your .env, then run setup-owner.sh."
