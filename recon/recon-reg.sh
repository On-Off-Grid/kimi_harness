#!/usr/bin/env bash
# pihunt-recon-reg — manage the continuous-recon program registry.
#   pihunt-recon-reg add <program> <domain[,domain2]> [fast|normal|deep]
#   pihunt-recon-reg list
#   pihunt-recon-reg rm <program>
#   pihunt-recon-reg run <program>     # run recon for it once, now
# The registry is read by pihunt-recon-scheduler (systemd timer).
set -uo pipefail
RAG_HOME="${PIHUNT_RAG_HOME:-$HOME/.pi-hunt-rag}"
REG="${PIHUNT_RECON_REGISTRY:-$RAG_HOME/recon-programs.txt}"
mkdir -p "$(dirname "$REG")"; touch "$REG"

cmd="${1:-list}"; shift || true
case "$cmd" in
  add)
    prog="${1:-}"; doms="${2:-}"; mode="${3:-normal}"
    [ -z "$prog" ] || [ -z "$doms" ] && { echo "usage: pihunt-recon-reg add <program> <domains> [fast|normal|deep]"; exit 1; }
    grep -qE "^$prog[[:space:]]" "$REG" && sed -i "/^$prog[[:space:]].*/d" "$REG"
    echo "$prog $doms $mode" >> "$REG"
    echo "registered: $prog $doms $mode"
    echo "(runs on the next timer tick; or now: pihunt-recon-reg run $prog)"
    ;;
  rm|remove)
    prog="${1:-}"; [ -z "$prog" ] && { echo "usage: pihunt-recon-reg rm <program>"; exit 1; }
    sed -i "/^$prog[[:space:]].*/d" "$REG"; echo "removed: $prog"
    ;;
  list|ls)
    echo "# registered recon programs ($REG):"
    grep -vE "^\s*#|^\s*$" "$REG" 2>/dev/null | sed 's/^/  /' || echo "  (none)"
    ;;
  run)
    prog="${1:-}"; [ -z "$prog" ] && { echo "usage: pihunt-recon-reg run <program>"; exit 1; }
    exec "$HOME/.local/bin/pihunt-recon-scheduler" "$prog"
    ;;
  *) echo "usage: pihunt-recon-reg {add|rm|list|run}"; exit 1;;
esac
