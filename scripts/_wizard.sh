#!/usr/bin/env bash
# Shared wizard: banner, env loading, interactive prompts, Railway validation.
# Sourced by setup-mac.sh and setup-linux.sh.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null)" || SCRIPT_DIR=""

# Load UI helpers (local checkout OR curl-fetched when piped from GitHub).
_WIZARD_UI_URL="https://raw.githubusercontent.com/algrifff/dnd-sync/main/scripts/_ui.sh"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/_ui.sh" ]]; then
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/_ui.sh"
else
    _UI_SRC="$(curl -fsSL "$_WIZARD_UI_URL" 2>/dev/null || true)"
    if [[ -n "$_UI_SRC" ]]; then
        eval "$_UI_SRC"
    else
        # Last-resort stubs so the script still runs without colors/banner.
        show_banner()   { :; }
        print_step()    { echo ""; echo "[$1/${UI_TOTAL_STEPS:-5}] $2"; }
        print_section() { echo ""; echo "› $1"; }
        print_ok()      { echo "   ✓ $1"; }
        print_info()    { echo "   › $1"; }
        print_warn()    { echo "   ! $1"; }
        print_err()     { echo "   ✗ $1"; }
        print_done()    { echo ""; echo "=== Setup complete! ==="; }
    fi
fi
unset _WIZARD_UI_URL _UI_SRC

# Load .env if present (owner's checkout); friends won't have one.
[[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/../.env" ]] && source "$SCRIPT_DIR/../.env"
[[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/.env"    ]] && source "$SCRIPT_DIR/.env"

FOLDER_ID="${FOLDER_ID:-the-compendium}"
VAULT_PATH="${VAULT_PATH:-$HOME/Documents/The-Compendium}"
LOCAL_ST_API_KEY="compendium-setup-key"
UI_TOTAL_STEPS=5

show_banner

echo "  ${BOLD}${GOLD}🐉  Welcome, adventurer.${R}"
echo ""
echo "  This installer will:"
echo "     ${GREEN}•${R} Install Obsidian (the vault reader)"
echo "     ${GREEN}•${R} Install Syncthing (the sync engine)"
echo "     ${GREEN}•${R} Connect you to the shared vault"
echo ""
echo "  You need ${BOLD}two things${R} from your DM before you begin:"
echo "     ${GOLD}①${R} Server address   ${DIM}${GREY}— like https://xxx.up.railway.app${R}"
echo "     ${GOLD}②${R} Join key         ${DIM}${GREY}— a secret string${R}"
echo ""

# Skip prompts if values already loaded from .env
if [[ -z "$RAILWAY_URL" ]]; then
    printf "  ${BOLD}${GOLD}①${R} ${BOLD}Server address:${R} "
    read -r RAILWAY_URL </dev/tty
    RAILWAY_URL="${RAILWAY_URL%/}"
fi

if [[ -z "$RAILWAY_API_KEY" ]]; then
    printf "  ${BOLD}${GOLD}②${R} ${BOLD}Join key:${R} "
    read -rs RAILWAY_API_KEY </dev/tty
    echo ""
fi

echo ""
print_info "Verifying connection to the sync server..."
if ! curl -sfL -H "X-API-Key: $RAILWAY_API_KEY" "$RAILWAY_URL/rest/system/ping" > /dev/null 2>&1; then
    print_err "Could not reach the sync server."
    echo "     ${DIM}${GREY}Check the server address and join key, then run the installer again.${R}"
    exit 1
fi

RAILWAY_DEVICE_ID=$(curl -sL -H "X-API-Key: $RAILWAY_API_KEY" "$RAILWAY_URL/rest/system/status" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['myID'])")
print_ok "Connected to the sync server."
echo ""
