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
UI_TOTAL_STEPS=4

if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
    print_err ".env not found. Copy .env.example to .env and fill in the COUCHDB_* values."
    exit 1
fi
# shellcheck disable=SC1091
source "$SCRIPT_DIR/.env"

: "${COUCHDB_URL:?COUCHDB_URL must be set in .env}"
: "${COUCHDB_USER:?COUCHDB_USER must be set in .env}"
: "${COUCHDB_PASSWORD:?COUCHDB_PASSWORD must be set in .env}"
DB="${COUCHDB_DBNAME:-vault}"
COUCHDB_URL="${COUCHDB_URL%/}"

AUTH="-u $COUCHDB_USER:$COUCHDB_PASSWORD"

print_step 1 "Waiting for CouchDB to come online"
for i in {1..60}; do
    if curl -sf "$COUCHDB_URL/_up" >/dev/null 2>&1; then
        print_ok "CouchDB is responding at $COUCHDB_URL"
        break
    fi
    sleep 2
    [[ $i -eq 60 ]] && { print_err "CouchDB did not come up. Check the Railway deploy logs."; exit 1; }
done

print_step 2 "Verifying admin credentials"
if ! curl -sf $AUTH "$COUCHDB_URL/_session" >/dev/null; then
    print_err "Admin login failed. Check COUCHDB_USER / COUCHDB_PASSWORD match the Railway env vars."
    exit 1
fi
print_ok "Admin credentials accepted."

print_step 3 "Creating databases"
for sys in _users _replicator _global_changes; do
    code=$(curl -s -o /dev/null -w "%{http_code}" -X PUT $AUTH "$COUCHDB_URL/$sys")
    case "$code" in
        201|202|412) print_ok "$sys ready." ;;
        *)           print_err "Failed to create $sys (HTTP $code)"; exit 1 ;;
    esac
done

code=$(curl -s -o /dev/null -w "%{http_code}" -X PUT $AUTH "$COUCHDB_URL/$DB")
case "$code" in
    201|202) print_ok "Vault database '$DB' created." ;;
    412)     print_ok "Vault database '$DB' already exists." ;;
    *)       print_err "Failed to create database '$DB' (HTTP $code)"; exit 1 ;;
esac

print_step 4 "Checking CORS (Obsidian desktop origin)"
preflight=$(curl -s -o /dev/null -w "%{http_code}" \
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
echo ""
echo "  ${BOLD}${GOLD}Paste these values into Obsidian → LiveSync → Remote database:${R}"
echo "     ${BOLD}URI:${R}      $COUCHDB_URL"
echo "     ${BOLD}Username:${R} $COUCHDB_USER"
echo "     ${BOLD}Password:${R} $COUCHDB_PASSWORD"
echo "     ${BOLD}Database:${R} $DB"
echo ""
echo "  ${DIM}${GREY}Share the same four values with your friends. After Setup, enable${R}"
echo "  ${DIM}${GREY}'LiveSync' mode for near-real-time file updates.${R}"
echo ""
