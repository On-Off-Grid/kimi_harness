#!/usr/bin/env bash
# =============================================================================
# pihunt-ct-monitor — real-time Certificate Transparency monitoring (Haddix
# "just-in-time data"). Streams CT logs via gungnir, filters for in-scope root
# domains, appends new hostnames to the program's recon, ingests them into the
# RAG, and (optionally) fires a webhook via `notify` the moment a target issues
# a new certificate.
#
# Usage:
#   pihunt-ct-monitor <program> <rootdomain[,root2,...]>      # stream + record
#   pihunt-ct-monitor <program> <roots> --notify             # also webhook (notify provider-config)
#
# Run it under tmux/nohup or as a long-lived systemd service. It never exits on
# its own. Newly-seen hosts land in structured-recon/ct_live.txt and the RAG.
# Requires: gungnir (CT stream). Optional: notify (webhooks), anew (dedupe).
# =============================================================================
set -uo pipefail

PROG="${1:-}"; ROOTS_CSV="${2:-}"
[ -z "$PROG" ] || [ -z "$ROOTS_CSV" ] && { echo "usage: pihunt-ct-monitor <program> <root[,root2]> [--notify]"; exit 1; }
shift 2 || true
DO_NOTIFY=0; for a in "$@"; do [ "$a" = "--notify" ] && DO_NOTIFY=1; done

ROOT="${PIHUNT_RECON_ROOT:-$HOME/hunts}"
OUT="$ROOT/$PROG/structured-recon"; mkdir -p "$OUT"
RAG_HOME="${PIHUNT_RAG_HOME:-$HOME/.pi-hunt-rag}"
RAG_REPO=""
for c in "${PIHUNT_RAG_REPO:-}" "$HOME/Documents/ai/pi-Hunt/pi-hunt-restore/rag" "$HOME/pi-hunt/rag" "$HOME/tools/pi-hunt/rag"; do
  [ -n "$c" ] && [ -f "$c/pihunt_rag/recon_ingest.py" ] && { RAG_REPO="$c"; break; }
done
CT_FILE="$OUT/ct_live.txt"; touch "$CT_FILE"
ROOT_RE="$(echo "$ROOTS_CSV" | tr ',' '\n' | sed 's/^\*\.//; s/\./\\./g' | grep . | paste -sd'|')"
command -v gungnir >/dev/null 2>&1 || { echo "gungnir not installed (go install github.com/g0ldencybersec/gungnir/cmd/gungnir@latest)"; exit 1; }

echo "[ct-monitor] $PROG: streaming CT logs, filtering /$ROOT_RE/ -> $CT_FILE (notify=$DO_NOTIFY)"
echo "$ROOTS_CSV" | tr ',' '\n' | sed 's/^\*\.//' | grep . > "$OUT/.ct_roots.txt"

# Stream gungnir, filter to scope roots, dedupe, record, ingest, optional webhook.
gungnir -r "$OUT/.ct_roots.txt" 2>/dev/null | grep -aiE "($ROOT_RE)$" | while read -r host; do
  host="$(echo "$host" | tr 'A-Z' 'a-z' | sed 's/^\*\.//' | xargs)"
  [ -z "$host" ] && continue
  if command -v anew >/dev/null 2>&1; then
    echo "$host" | anew "$CT_FILE" >/tmp/.ct_new.$$ 2>/dev/null
    [ -s /tmp/.ct_new.$$ ] || continue          # already seen
  else
    grep -qxF "$host" "$CT_FILE" 2>/dev/null && continue
    echo "$host" >> "$CT_FILE"
  fi
  echo "[ct-monitor] NEW cert host: $host"
  # feed into the master subdomain list too
  echo "$host" >> "$OUT/subdomains_all.txt"
  [ "$DO_NOTIFY" = 1 ] && command -v notify >/dev/null 2>&1 && \
    echo "🔔 $PROG new cert: $host" | notify -silent 2>/dev/null
done &
GPID=$!

# Periodically re-ingest the growing CT list into the RAG (every 5 min) without
# blocking the stream.
if [ -x "$RAG_HOME/.venv/bin/python" ] && [ -n "$RAG_REPO" ]; then
  while kill -0 $GPID 2>/dev/null; do
    sleep 300
    PIHUNT_RAG_HOME="$RAG_HOME" PYTHONPATH="$RAG_REPO" HF_HOME="$RAG_HOME/data/hf" \
      "$RAG_HOME/.venv/bin/python" -m pihunt_rag.recon_ingest "$PROG" "$OUT" >/dev/null 2>&1
  done &
fi
wait $GPID
rm -f /tmp/.ct_new.$$ 2>/dev/null
