#!/usr/bin/env bash
# =============================================================================
# pihunt-recon-scheduler — run continuous recon for every registered program.
#
# Reads a simple registry file (one program per line) and runs recon-engine for
# each, so recon keeps refreshing in the background and the RAG stays current.
# Driven by a systemd user timer (see systemd/pihunt-recon.{service,timer}).
#
# Registry: ~/.pi-hunt-rag/recon-programs.txt
#   format (one per line):   <program> <domain[,domain2,...]> [mode]
#   mode = fast | normal | deep   (default: normal; timer uses fast for cadence)
#   lines starting with # are ignored. Manage with:  pihunt-recon-add / -list / -rm
#
# Usage:
#   pihunt-recon-scheduler            # run all registered programs (mode from registry)
#   pihunt-recon-scheduler --fast     # force fast mode for all (timer default)
#   pihunt-recon-scheduler --deep     # force deep mode for all (heavy; manual)
#   pihunt-recon-scheduler <program>  # run just one registered program
# =============================================================================
set -uo pipefail

RAG_HOME="${PIHUNT_RAG_HOME:-$HOME/.pi-hunt-rag}"
REGISTRY="${PIHUNT_RECON_REGISTRY:-$RAG_HOME/recon-programs.txt}"
LOCK="$RAG_HOME/.recon-scheduler.lock"
LOG="$RAG_HOME/recon-scheduler.log"
ENGINE=""
for c in "$HOME/.local/bin/pihunt-recon" "$(dirname "$0")/recon-engine.sh"; do
  [ -x "$c" ] && { ENGINE="$c"; break; }
done
[ -z "$ENGINE" ] && { echo "recon-engine not found"; exit 1; }

FORCE_MODE=""; ONLY=""
for a in "$@"; do case "$a" in
  --fast) FORCE_MODE="fast";; --normal) FORCE_MODE="normal";; --deep) FORCE_MODE="deep";;
  -*) ;; *) ONLY="$a";;
esac; done

[ -f "$REGISTRY" ] || { echo "no registry at $REGISTRY (add one with: pihunt-recon-add <program> <domains>)"; exit 0; }

# single-flight: don't overlap scheduler runs
exec 9>"$LOCK"
if ! flock -n 9; then echo "another recon-scheduler run is active; exiting"; exit 0; fi

ts(){ date -u +%Y-%m-%dT%H:%M:%SZ; }
echo "[$(ts)] scheduler start (force_mode=${FORCE_MODE:-registry} only=${ONLY:-all})" >> "$LOG"

while IFS= read -r line; do
  line="${line%%#*}"; line="$(echo "$line" | xargs)"; [ -z "$line" ] && continue
  prog="$(echo "$line" | awk '{print $1}')"
  doms="$(echo "$line" | awk '{print $2}')"
  mode="$(echo "$line" | awk '{print $3}')"; mode="${mode:-normal}"
  [ -n "$FORCE_MODE" ] && mode="$FORCE_MODE"
  [ -n "$ONLY" ] && [ "$prog" != "$ONLY" ] && continue
  [ -z "$prog" ] || [ -z "$doms" ] && continue
  echo "[$(ts)] recon $prog ($doms) mode=$mode" >> "$LOG"
  PIHUNT_RAG_HOME="$RAG_HOME" "$ENGINE" "$prog" "$doms" --"$mode" >> "$LOG" 2>&1 \
    && echo "[$(ts)] done $prog" >> "$LOG" \
    || echo "[$(ts)] FAILED $prog (rc=$?)" >> "$LOG"
done < "$REGISTRY"

echo "[$(ts)] scheduler complete" >> "$LOG"
