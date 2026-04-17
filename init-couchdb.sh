#!/usr/bin/env bash
# Run once after deploying this branch to Railway.
# Creates CouchDB system databases and the vault database, verifies
# CORS is working, and prints the values to paste into LiveSync.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Optional UI helpers
if [[ -f "$SCRIPT_DIR/scripts/_ui.sh" ]]; then
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/scripts/_ui.sh"
else
    print_ok()   { echo "   ✓ $1"; }
    print_info() { echo "   › $1"; }
    print_err()  { echo "   ✗ $1"; }
    print_step() { echo ""; echo "[$1/$UI_TOTAL_STEPS] $2"; }
    print_done() { echo "Done."; }
    R=""; BOLD=""; DIM=""; GOLD=""; GREEN=""; GREY=""
fi
UI_TOTAL_STEPS=5

if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
    print_err ".env not found. Copy .env.example to .env and fill in the COUCHDB_* values."
    exit 1
fi

# Tolerant .env parser — accepts KEY=VALUE, KEY = VALUE, KEY="VALUE", trims
# surrounding whitespace/quotes. Survives common hand-editing mistakes.
_load_env() {
    local file="$1" line key val
    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line%$'\r'}"                        # strip CR (Windows line endings)
        [[ -z "${line// }" || "$line" =~ ^[[:space:]]*# ]] && continue
        if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]]; then
            key="${BASH_REMATCH[1]}"
            val="${BASH_REMATCH[2]}"
            val="${val%\"}"; val="${val#\"}"        # strip matched double quotes
            val="${val%\'}"; val="${val#\'}"        # or single quotes
            val="${val%"${val##*[![:space:]]}"}"    # right-trim whitespace
            printf -v "$key" '%s' "$val"
            export "$key"
        fi
    done < "$file"
}
_load_env "$SCRIPT_DIR/.env"

: "${COUCHDB_URL:?COUCHDB_URL must be set in .env}"
: "${COUCHDB_USER:?COUCHDB_USER must be set in .env}"
: "${COUCHDB_PASSWORD:?COUCHDB_PASSWORD must be set in .env}"
DB="${COUCHDB_DBNAME:-vault}"
COUCHDB_URL="${COUCHDB_URL%/}"

# Auto-prepend https:// if the user left the scheme off.
if [[ "$COUCHDB_URL" != http://* && "$COUCHDB_URL" != https://* ]]; then
    print_warn "No scheme on COUCHDB_URL — assuming https://$COUCHDB_URL. Please update .env."
    COUCHDB_URL="https://$COUCHDB_URL"
fi

# Railway auto-redirects http:// → https:// (301). Detect and upgrade so our
# URL matches what the server actually serves.
if [[ "$COUCHDB_URL" == http://* ]]; then
    final="$(curl -sILo /dev/null -w '%{url_effective}' "$COUCHDB_URL/" 2>/dev/null || true)"
    final="${final%/}"
    if [[ "$final" == https://* && "$final" != "$COUCHDB_URL" ]]; then
        print_warn "Upgrading COUCHDB_URL to $final (server redirected). Please update .env."
        COUCHDB_URL="$final"
    fi
fi

AUTH="-u $COUCHDB_USER:$COUCHDB_PASSWORD"

print_step 1 "Waiting for CouchDB to come online"
# /_up may or may not require auth depending on CouchDB config — try with
# credentials so we succeed either way. Fall back to /_session to distinguish
# 'server down' from 'auth rejected'.
ok=""
for i in {1..60}; do
    code=$(curl -sLo /dev/null -w "%{http_code}" $AUTH "$COUCHDB_URL/_up")
    if [[ "$code" == "200" ]]; then ok=1; break; fi
    # Server up but health endpoint locked behind auth failure? Probe /_session.
    sess=$(curl -sLo /dev/null -w "%{http_code}" $AUTH "$COUCHDB_URL/_session")
    if [[ "$sess" == "200" ]]; then ok=1; break; fi
    sleep 2
done
if [[ -z "$ok" ]]; then
    print_err "CouchDB did not respond at $COUCHDB_URL (last code: $code / $sess)."
    echo "     ${DIM}${GREY}If Railway logs say CouchDB started, check the service's public domain maps to port 5984.${R}"
    exit 1
fi
print_ok "CouchDB is responding at $COUCHDB_URL"

print_step 2 "Verifying admin credentials"
if ! curl -sfL $AUTH "$COUCHDB_URL/_session" >/dev/null; then
    print_err "Admin login failed. Check COUCHDB_USER / COUCHDB_PASSWORD match the Railway env vars."
    exit 1
fi
print_ok "Admin credentials accepted."

print_step 3 "Creating databases"
for sys in _users _replicator _global_changes; do
    code=$(curl -sL -o /dev/null -w "%{http_code}" -X PUT $AUTH "$COUCHDB_URL/$sys")
    case "$code" in
        201|202|412) print_ok "$sys ready." ;;
        *)           print_err "Failed to create $sys (HTTP $code)"; exit 1 ;;
    esac
done

code=$(curl -sL -o /dev/null -w "%{http_code}" -X PUT $AUTH "$COUCHDB_URL/$DB")
case "$code" in
    201|202) print_ok "Vault database '$DB' created." ;;
    412)     print_ok "Vault database '$DB' already exists." ;;
    *)       print_err "Failed to create database '$DB' (HTTP $code)"; exit 1 ;;
esac

print_step 4 "Creating player account for friends"
if [[ -n "$PLAYER_USER" && -n "$PLAYER_PASSWORD" ]]; then
    USER_DOC_ID="org.couchdb.user:$PLAYER_USER"

    # PUT user doc — handle both 'new' and 'already exists' cases.
    code=$(curl -sL -o /tmp/player-resp -w "%{http_code}" -X PUT $AUTH \
        -H "Content-Type: application/json" \
        -d "$(python3 -c "import json; print(json.dumps({'name':'$PLAYER_USER','password':'$PLAYER_PASSWORD','roles':[],'type':'user'}))")" \
        "$COUCHDB_URL/_users/$USER_DOC_ID")
    case "$code" in
        201|202)
            print_ok "Player user '$PLAYER_USER' created."
            ;;
        409)
            # Exists — fetch current rev and update password in place.
            rev=$(curl -sfL $AUTH "$COUCHDB_URL/_users/$USER_DOC_ID" \
                | python3 -c "import sys,json; print(json.load(sys.stdin)['_rev'])")
            upd=$(python3 -c "import json; print(json.dumps({'_rev':'$rev','name':'$PLAYER_USER','password':'$PLAYER_PASSWORD','roles':[],'type':'user'}))")
            code=$(curl -sL -o /dev/null -w "%{http_code}" -X PUT $AUTH \
                -H "Content-Type: application/json" -d "$upd" \
                "$COUCHDB_URL/_users/$USER_DOC_ID")
            if [[ "$code" =~ ^20 ]]; then
                print_ok "Player user '$PLAYER_USER' password updated."
            else
                print_err "Failed to update player user (HTTP $code)"; exit 1
            fi
            ;;
        *)
            print_err "Failed to create player user (HTTP $code)"
            cat /tmp/player-resp 2>/dev/null; echo
            exit 1
            ;;
    esac
    rm -f /tmp/player-resp

    # Grant read/write on the vault DB (admins section left empty — only the
    # admin user configured in CouchDB env vars stays admin).
    sec=$(curl -sL -o /dev/null -w "%{http_code}" -X PUT $AUTH \
        -H "Content-Type: application/json" \
        -d "{\"admins\":{\"names\":[],\"roles\":[]},\"members\":{\"names\":[\"$PLAYER_USER\"],\"roles\":[]}}" \
        "$COUCHDB_URL/$DB/_security")
    if [[ "$sec" =~ ^20 ]]; then
        print_ok "Player has read/write on '$DB' (no admin rights)."
    else
        print_err "Failed to set _security on '$DB' (HTTP $sec)"; exit 1
    fi
else
    print_warn "PLAYER_USER / PLAYER_PASSWORD not set in .env — skipping player account."
    print_info "Friends would have to use your admin creds, which is not recommended."
fi

print_step 5 "Checking CORS (Obsidian desktop origin)"
preflight=$(curl -sL -o /dev/null -w "%{http_code}" \
    -H "Origin: app://obsidian.md" \
    -H "Access-Control-Request-Method: GET" \
    -X OPTIONS "$COUCHDB_URL/$DB")
if [[ "$preflight" =~ ^20 ]]; then
    print_ok "CORS preflight passed (HTTP $preflight)."
else
    print_err "CORS preflight returned HTTP $preflight — LiveSync will fail to connect."
    echo "     ${DIM}${GREY}Check couchdb/local.ini was baked into the image and redeploy.${R}"
fi

print_done

if [[ -n "$PLAYER_USER" && -n "$PLAYER_PASSWORD" ]]; then
    echo "  ${BOLD}${GOLD}Share these values with your friends (non-admin):${R}"
    echo "     ${BOLD}URI:${R}      $COUCHDB_URL"
    echo "     ${BOLD}Username:${R} $PLAYER_USER"
    echo "     ${BOLD}Password:${R} $PLAYER_PASSWORD"
    echo "     ${BOLD}Database:${R} $DB"
    echo ""
fi

echo "  ${BOLD}${GREY}For your own machine (admin — keep private):${R}"
echo "     ${DIM}URI:${R}      $COUCHDB_URL"
echo "     ${DIM}Username:${R} $COUCHDB_USER"
echo "     ${DIM}Password:${R} $COUCHDB_PASSWORD"
echo "     ${DIM}Database:${R} $DB"
echo ""
echo "  ${DIM}${GREY}Everyone enables 'LiveSync' mode in Obsidian for sub-second updates.${R}"
echo ""
