#!/usr/bin/env bash
# =============================================================================
# pi-hunt bootstrap — the easy, one-command installer.
#
#   curl -fsSL https://raw.githubusercontent.com/USER/pi-hunt/main/bootstrap.sh | bash
#   # or, from a clone:
#   ./bootstrap.sh
#
# What it does:
#   1. Installs missing prerequisites (Node 22+, python3, rsync, git, curl) via
#      the system package manager when possible (apt/dnf/pacman/brew).
#   2. Clones pi-hunt (if run via curl) or uses the current checkout.
#   3. Runs install.sh (framework) and optionally extras.sh (recon CLIs+SecLists).
#
# Flags:  --with-extras   also install the runtime recon toolchain (needs sudo)
#         --dry-run       show what would happen, change nothing
#         --repo <url>    clone from a custom fork URL
# =============================================================================
set -uo pipefail

# Replace <user> with your GitHub handle (or your fork) before sharing the installer.
REPO_URL_DEFAULT="https://github.com/<user>/pi-hunt.git"
WITH_EXTRAS=0; DRY=0; REPO_URL="$REPO_URL_DEFAULT"
while [ $# -gt 0 ]; do case "$1" in
  --with-extras) WITH_EXTRAS=1;;
  --dry-run) DRY=1;;
  --repo) REPO_URL="$2"; shift;;
  -h|--help) sed -n '2,20p' "$0" | sed 's/^#\s\?//'; exit 0;;
esac; shift; done

c(){ printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok(){ printf '   \033[1;32m✓\033[0m %s\n' "$*"; }
warn(){ printf '   \033[1;33m! %s\033[0m\n' "$*"; }
die(){ printf '   \033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }
run(){ if [ "$DRY" = 1 ]; then printf '   [dry] %s\n' "$*"; else eval "$@"; fi; }
have(){ command -v "$1" >/dev/null 2>&1; }

# ---- detect package manager -------------------------------------------------
PM=""; SUDO=""
[ "$(id -u)" -ne 0 ] && have sudo && SUDO="sudo"
if   have apt-get; then PM="apt";    elif have dnf; then PM="dnf"
elif have pacman;  then PM="pacman"; elif have brew; then PM="brew"
fi
pkg_install(){ # $@ = package names
  case "$PM" in
    apt)    run "$SUDO apt-get update -y" && run "$SUDO apt-get install -y $*";;
    dnf)    run "$SUDO dnf install -y $*";;
    pacman) run "$SUDO pacman -Sy --noconfirm $*";;
    brew)   run "brew install $*";;
    *) warn "no known package manager — install manually: $*";;
  esac
}

c "1/4  prerequisites"
# Node 22+: prefer system pkg; on apt use NodeSource if too old/missing.
need_node=0
if have node; then
  NMAJ="$(node -v | sed 's/v\([0-9]*\).*/\1/')"; [ "${NMAJ:-0}" -lt 22 ] 2>/dev/null && need_node=1
else need_node=1; fi
if [ "$need_node" = 1 ]; then
  warn "Node 22+ not found"
  if [ "$PM" = "apt" ]; then
    run "curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -" && pkg_install nodejs
  else pkg_install nodejs npm; fi
fi
have node && ok "node $(node -v)" || die "node still missing — install Node 22+ and re-run"
for t in python3 git curl rsync; do
  have "$t" && ok "$t present" || { warn "$t missing"; case "$t" in
    python3) pkg_install python3 python3-venv;; *) pkg_install "$t";; esac; }
done
# python venv module (Debian splits it out)
python3 -c "import venv" 2>/dev/null || pkg_install python3-venv
ok "prerequisites ready"

c "2/4  get pi-hunt"
SRC=""
if [ -f "./install.sh" ] && [ -d "./pi-agent" ]; then
  SRC="$(pwd)"; ok "using current checkout: $SRC"
else
  DEST="$HOME/pi-hunt"
  if [ -d "$DEST/.git" ]; then run "git -C '$DEST' pull --ff-only" && SRC="$DEST" && ok "updated $DEST"
  else run "git clone --depth 1 '$REPO_URL' '$DEST'" && SRC="$DEST" && ok "cloned -> $DEST"; fi
fi
[ -n "$SRC" ] || die "could not locate pi-hunt sources"

c "3/4  install framework"
run "cd '$SRC' && bash install.sh ${DRY:+--dry-run}"

c "4/4  recon toolchain (optional)"
if [ "$WITH_EXTRAS" = 1 ]; then
  run "cd '$SRC' && bash extras.sh ${DRY:+--dry-run}"
else
  warn "skipped recon CLIs/SecLists. Run '$SRC/extras.sh' (needs sudo) for full recon/fuzzing."
fi

printf '\n\033[1;32m──────────────────────────────────────────────────────────────\033[0m\n'
cat <<EOF
 pi-hunt is installed${DRY:+ (dry-run — nothing changed)}.

 Next (one-time, machine-specific):
   Configure OpenRouter authentication locally for Pi. The repository does not carry keys.
   # GitHub MCP token, Gmail OAuth, Burp app — see README "Post-install"

 Make sure ~/.local/bin is on PATH, then:
   pi-hunt                        # then type:  Hunt <program> for CRITICAL
EOF
printf '\033[1;32m──────────────────────────────────────────────────────────────\033[0m\n'
