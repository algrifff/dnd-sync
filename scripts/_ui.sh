#!/usr/bin/env bash
# Shared UI: colors, pixel dragon banner, print helpers.
# Sourced by _wizard.sh (friends) and by setup-owner.sh.
# Has no side effects at source time — call show_banner() explicitly.

# ── Colors ────────────────────────────────────────────────────────────────────
if [[ -t 1 ]] && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 256 ]]; then
    R=$'\033[0m'
    BOLD=$'\033[1m'
    DIM=$'\033[2m'
    GOLD=$'\033[38;5;220m'     # title / step header
    AMBER=$'\033[38;5;214m'
    EMBER=$'\033[38;5;208m'
    FLAME=$'\033[38;5;202m'
    BLAZE=$'\033[38;5;196m'    # fire hot red
    SPARK=$'\033[38;5;226m'    # fire hot yellow
    GREEN=$'\033[38;5;46m'     # ✓
    SCALE=$'\033[38;5;34m'     # dragon body (mid)
    SCALE_L=$'\033[38;5;40m'   # dragon highlight
    SCALE_D=$'\033[38;5;22m'   # dragon shadow
    EYE=$'\033[38;5;208m'      # dragon eye
    SKY=$'\033[38;5;51m'       # info arrow
    GREY=$'\033[38;5;244m'
    DGREY=$'\033[38;5;238m'
    RED=$'\033[38;5;196m'
elif [[ -t 1 ]]; then
    R=$'\033[0m'; BOLD=$'\033[1m'; DIM=$'\033[2m'
    GOLD=$'\033[0;33m'; AMBER=$'\033[0;33m'; EMBER=$'\033[0;33m'
    FLAME=$'\033[0;31m'; BLAZE=$'\033[0;31m'; SPARK=$'\033[0;33m'
    GREEN=$'\033[0;32m'; SCALE=$'\033[0;32m'; SCALE_L=$'\033[0;32m'
    SCALE_D=$'\033[0;32m'; EYE=$'\033[0;33m'
    SKY=$'\033[0;36m'; GREY=$'\033[0;37m'; DGREY=$'\033[0;37m'
    RED=$'\033[0;31m'
else
    R=''; BOLD=''; DIM=''
    GOLD=''; AMBER=''; EMBER=''; FLAME=''; BLAZE=''; SPARK=''
    GREEN=''; SCALE=''; SCALE_L=''; SCALE_D=''; EYE=''
    SKY=''; GREY=''; DGREY=''; RED=''
fi

# Total steps in the friend setup flow. Scripts override this before calling print_step.
UI_TOTAL_STEPS="${UI_TOTAL_STEPS:-5}"

# ── Pixel dragon banner with fire animation ───────────────────────────────────
show_banner() {
    [[ -t 1 ]] || return 0

    _frame() {
        local fire="$1"
        tput cup 0 0 2>/dev/null || printf '\n'
        echo ""
        echo "    ${SCALE_D}       ▄▄▄▄▄▄▄▄▄▄${R}"
        echo "    ${SCALE_D}    ▄▟${SCALE}█████████${SCALE_D}█▙▄${R}"
        echo "    ${SCALE_D}  ▗▟${SCALE}████${SCALE_L}▀▀${EYE}◉${SCALE_L}▀▀${SCALE}█████${SCALE_D}▙▖${R}"
        echo "    ${SCALE_D} ▟${SCALE}███████${SCALE_L}▄▄▄${SCALE}████████${SCALE_D}▙${R}    ${DGREY}▄▄${R}"
        echo "    ${SCALE}▟████████████████████${SCALE_D}▙${R}${fire}"
        echo "    ${SCALE}▜████████████████████${SCALE_D}▛${R}${fire}"
        echo "    ${SCALE_D} ▜${SCALE}███████${SCALE_L}▀▀▀${SCALE}████████${SCALE_D}▛${R}    ${DGREY}▀▀${R}"
        echo "    ${SCALE_D}  ▝▜${SCALE}█████████████${SCALE_D}▛▘${R}"
        echo "    ${SCALE_D}     ▜${SCALE}█▛${SCALE_D}▘  ▝${SCALE}█▛${SCALE_D}▘${R}"
        echo ""
        echo "  ${BOLD}${GOLD}╔════════════════════════════════════════════╗${R}"
        echo "  ${BOLD}${GOLD}║${R}    ${BOLD}T H E   C O M P E N D I U M${R}             ${BOLD}${GOLD}║${R}"
        echo "  ${BOLD}${GOLD}╠════════════════════════════════════════════╣${R}"
        echo "  ${BOLD}${GOLD}║${R}    ${GREY}Vault Sync — First-time Setup${R}           ${BOLD}${GOLD}║${R}"
        echo "  ${BOLD}${GOLD}╚════════════════════════════════════════════╝${R}"
        echo ""
    }

    # Fire frames — layered reds → oranges → yellows, flickering out the jaw.
    local FIRES=(
        "                                      "
        " ${BLAZE}▸${R}                                   "
        " ${BLAZE}▸${FLAME}═${R}                                  "
        " ${BLAZE}▸${FLAME}══${R}                                 "
        " ${BLAZE}▸${FLAME}══${EMBER}═${R}                                "
        " ${BLAZE}▸${FLAME}══${EMBER}══${R}                               "
        " ${BLAZE}▸${FLAME}══${EMBER}══${AMBER}░${R}                              "
        " ${BLAZE}▸${FLAME}══${EMBER}══${AMBER}░░${GOLD}∴${R}                           "
        " ${BLAZE}▸${FLAME}══${EMBER}══${AMBER}░░${GOLD}∴${SPARK}·${R}                          "
        " ${BLAZE}▸${FLAME}══${EMBER}══${AMBER}░░${GOLD}∴∴${SPARK}·${R}                         "
        " ${BLAZE}▸${FLAME}══${EMBER}══${AMBER}░░${GOLD}∴∴${SPARK}·${GOLD}∵${R}                       "
        " ${BLAZE}▸${FLAME}══${EMBER}══${AMBER}░░${GOLD}∴${SPARK}·${GOLD}∵${SPARK}∴${GOLD}·${R}                       "
        " ${BLAZE}▸${FLAME}══${EMBER}══${AMBER}░░${GOLD}∴∴${SPARK}·${GOLD}∵${SPARK}∴${R}                       "
    )

    clear 2>/dev/null || true
    local seq=(0 1 2 3 4 5 6 7 8 9 10 11 12 10 11 12 11 12)
    for i in "${seq[@]}"; do
        _frame "${FIRES[$i]}"
        sleep 0.055
    done
    _frame "${FIRES[11]}"
}

# ── Progress bar (n of total) ─────────────────────────────────────────────────
_progress() {
    local n="$1" total="$2" bar=""
    local i
    for ((i=1; i<=total; i++)); do
        if [[ $i -le $n ]]; then
            bar+="${GOLD}▰${R}"
        else
            bar+="${DGREY}▱${R}"
        fi
    done
    printf '%s' "$bar"
}

# ── Print helpers ─────────────────────────────────────────────────────────────
print_step() {
    local n="$1" title="$2"
    local prog; prog="$(_progress "$n" "$UI_TOTAL_STEPS")"
    echo ""
    echo "  ${prog}  ${BOLD}${GOLD}STEP ${n} / ${UI_TOTAL_STEPS}${R}  ${DIM}${GREY}—${R}  ${BOLD}${title}${R}"
}

print_section() {
    echo ""
    echo "  ${BOLD}${GOLD}›${R} ${BOLD}$1${R}"
}

print_ok()   { echo "     ${GREEN}✓${R} $1"; }
print_info() { echo "     ${SKY}›${R} ${DIM}$1${R}"; }
print_warn() { echo "     ${AMBER}!${R} $1"; }
print_err()  { echo "     ${RED}${BOLD}✗${R} ${BOLD}$1${R}"; }

print_done() {
    echo ""
    echo "  ${BOLD}${GOLD}╔════════════════════════════════════════════╗${R}"
    echo "  ${BOLD}${GOLD}║${R}         ${BOLD}${GREEN}Setup complete!${R}                    ${BOLD}${GOLD}║${R}"
    echo "  ${BOLD}${GOLD}╚════════════════════════════════════════════╝${R}"
    echo ""
}
