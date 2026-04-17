#!/usr/bin/env bash
# Run this ONCE after your first Railway deploy to create the vault folder.
# Usage: ./init-railway.sh <railway-url> <api-key>
# Example: ./init-railway.sh https://compendium.up.railway.app abc123xyz

set -e

RAILWAY_URL="${1:-}"
RAILWAY_API_KEY="${2:-}"
FOLDER_ID="the-compendium"
FOLDER_PATH="/var/syncthing/The-Compendium"

if [[ -z "$RAILWAY_URL" || -z "$RAILWAY_API_KEY" ]]; then
    echo "Usage: ./init-railway.sh <railway-url> <api-key>"
    exit 1
fi

echo "Waiting for Syncthing to be ready..."
until curl -sf -H "X-API-Key: $RAILWAY_API_KEY" "$RAILWAY_URL/rest/system/ping" > /dev/null 2>&1; do
    printf "."
    sleep 3
done
echo " ready."

echo "Fetching Railway device ID..."
DEVICE_ID=$(curl -s -H "X-API-Key: $RAILWAY_API_KEY" "$RAILWAY_URL/rest/system/status" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['myID'])")
echo "  Railway device ID: $DEVICE_ID"

echo "Creating vault folder on Railway..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
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
echo "Next: run setup-owner.sh on YOUR machine to connect your local vault."
