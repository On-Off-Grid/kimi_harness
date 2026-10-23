#!/usr/bin/env bash
# =============================================================================
# pihunt-vulnscan — CVE + misconfiguration deep-dive scanner for the
# `cve-misconfig-hunter` agent. Orchestrates the best-in-class scanners
# (nuclei, jaeles, nikto, retire.js, wpscan, searchsploit) against confirmed
# in-scope live hosts, DEDUPES noise, and writes evidence + RAG-ingestible
# findings. Built around Haddix's rule: scan obscure/new subdomains, not the
# heavily-automated root, and DEEP-DIVE every hit (version -> exact CVE -> PoC).
#
# Usage:
#   pihunt-vulnscan <program> <target-or-file> [--deep] [--tech "Spring,IIS"]
#     <target-or-file>  a single URL/host, or a file of live hosts
#   pihunt-vulnscan acme https://obscure.acme.com --deep --tech "Apache,WordPress"
#
# Stages: fingerprint -> nuclei(tech+cve+misconfig) -> jaeles -> retire.js(client libs)
#         -> nikto(server misconfig) -> wpscan(if WP) -> searchsploit(version->exploit)
#         -> dedupe + ingest to RAG (source=vuln). Each stage best-effort/timeout-bounded.
# Env: PIHUNT_RAG_HOME, PIHUNT_RAG_REPO, PIHUNT_RECON_ROOT, VULN_NUCLEI_TAGS
# =============================================================================
set -uo pipefail
PROG="${1:-}"; TGT="${2:-}"
[ -z "$PROG" ] || [ -z "$TGT" ] && { echo "usage: pihunt-vulnscan <program> <url|host|file> [--deep] [--tech T]"; exit 1; }
shift 2 || true
MODE="normal"; TECH=""
while [ $# -gt 0 ]; do case "$1" in --deep) MODE="deep";; --tech) TECH="$2";shift;; esac; shift; done

ROOT="${PIHUNT_RECON_ROOT:-$HOME/hunts}"
OUT="$ROOT/$PROG/structured-recon/vulnscan"; mkdir -p "$OUT"
TS="$(date -u +%Y%m%dT%H%M%SZ)"; RUN="$OUT/$TS"; mkdir -p "$RUN"
RAG_HOME="${PIHUNT_RAG_HOME:-$HOME/.pi-hunt-rag}"
RAG_REPO=""
for c in "${PIHUNT_RAG_REPO:-}" "$HOME/Documents/ai/pi-Hunt/pi-hunt-restore/rag" "$HOME/pi-hunt/rag" "$HOME/tools/pi-hunt/rag"; do
  [ -n "$c" ] && [ -f "$c/pihunt_rag/cli.py" ] && { RAG_REPO="$c"; break; }
done
have(){ command -v "$1" >/dev/null 2>&1; }
log(){ printf '\033[1;35m[vulnscan %s]\033[0m %s\n' "$(date -u +%H:%M:%S)" "$*"; }
rag(){ [ -n "$RAG_REPO" ] && [ -x "$RAG_HOME/.venv/bin/python" ] && \
  PIHUNT_RAG_HOME="$RAG_HOME" PYTHONPATH="$RAG_REPO" HF_HOME="$RAG_HOME/data/hf" \
  "$RAG_HOME/.venv/bin/python" -m pihunt_rag.cli "$@" 2>/dev/null; }

# target list
if [ -f "$TGT" ]; then cp "$TGT" "$RUN/targets.txt"; else echo "$TGT" > "$RUN/targets.txt"; fi
# normalize to URLs for http scanners
sed -E 's#^#@@#; s#@@https?://#https://#; s#^@@#https://#' "$RUN/targets.txt" | sort -u > "$RUN/urls.txt"
N=$(wc -l < "$RUN/urls.txt")
log "program=$PROG mode=$MODE targets=$N tech='${TECH:-auto}'"

# ---------- 1. fingerprint (httpx tech) ----------
if have httpx; then
  log "fingerprint (httpx -td)"
  httpx -silent -td -title -sc -server -json -l "$RUN/urls.txt" 2>/dev/null > "$RUN/fp.jsonl"
  DETECTED=$(grep -oE '"tech":\[[^]]*\]' "$RUN/fp.jsonl" 2>/dev/null | tr ',' '\n' | grep -oE '"[^"]+"' | tr -d '"' | sort -u | paste -sd,)
  [ -z "$TECH" ] && TECH="$DETECTED"
  echo "$TECH" > "$RUN/tech.txt"
fi

# ---------- 2. nuclei (CVE + misconfig + exposures) ----------
if have nuclei; then
  log "nuclei (cve, misconfig, exposure, default-login, tech)"
  TAGS="${VULN_NUCLEI_TAGS:-cve,misconfig,exposure,default-login,tech,takeover}"
  SEV="info,low,medium,high,critical"; [ "$MODE" != "deep" ] && SEV="medium,high,critical"
  timeout 1800 nuclei -l "$RUN/urls.txt" -tags "$TAGS" -severity "$SEV" \
    -rl 150 -c 25 -timeout 8 -silent -jsonl -o "$RUN/nuclei.jsonl" 2>/dev/null
  # human summary
  python3 - "$RUN/nuclei.jsonl" "$RUN/nuclei_findings.txt" 2>/dev/null <<'PY'
import json,sys
src,out=sys.argv[1],sys.argv[2]
rows=[]
for ln in open(src,errors='replace') if __import__('os').path.exists(src) else []:
    ln=ln.strip()
    if not ln: continue
    try: o=json.loads(ln)
    except: continue
    info=o.get('info',{})
    rows.append(f"[{info.get('severity','?').upper()}] {o.get('template-id','?')} :: {info.get('name','')} :: {o.get('matched-at') or o.get('host','')}")
open(out,'w').write('\n'.join(sorted(set(rows)))+'\n')
PY
  log "nuclei findings: $(wc -l < "$RUN/nuclei_findings.txt" 2>/dev/null||echo 0)"
fi

# ---------- 3. jaeles (j3ssi3jjj signatures: deep misconfig/vuln) ----------
if have jaeles && [ "$MODE" = "deep" ]; then
  log "jaeles (signature scan)"
  timeout 1200 jaeles scan -u "$(head -1 "$RUN/urls.txt")" -s ~/.jaeles/base-signatures 2>/dev/null \
    | grep -iE "\[Vulnerable\]|\[High\]|\[Critical\]|\[Medium\]" > "$RUN/jaeles.txt" 2>/dev/null
  # for many targets, loop a capped set
  if [ "$N" -gt 1 ]; then
    head -10 "$RUN/urls.txt" | while read -r u; do
      timeout 300 jaeles scan -u "$u" -s ~/.jaeles/base-signatures 2>/dev/null | grep -iE "\[Vulnerable\]" >> "$RUN/jaeles.txt"
    done
  fi
  log "jaeles hits: $(wc -l < "$RUN/jaeles.txt" 2>/dev/null||echo 0)"
fi

# ---------- 4. retire.js (vulnerable client-side libraries) ----------
if have retire; then
  log "retire.js (outdated JS libraries)"
  head -20 "$RUN/urls.txt" | while read -r u; do
    timeout 60 retire --outputformat json --outputpath /dev/stdout --jspath <(curl -s -m15 "$u" 2>/dev/null) 2>/dev/null
  done > "$RUN/retire.json" 2>/dev/null || true
  # simpler: retire scans served JS best via a headless fetch; record raw
  log "retire output: $RUN/retire.json"
fi

# ---------- 5. nikto (web-server misconfig) ----------
if have nikto && [ "$MODE" = "deep" ]; then
  log "nikto (server misconfig, top target)"
  timeout 600 nikto -h "$(head -1 "$RUN/urls.txt")" -nointeractive -Format txt -output "$RUN/nikto.txt" 2>/dev/null
fi

# ---------- 6. wpscan (if WordPress fingerprinted) ----------
if have wpscan && echo "$TECH" | grep -qi wordpress; then
  log "wpscan (WordPress detected)"
  timeout 600 wpscan --url "$(head -1 "$RUN/urls.txt")" --no-banner --format cli-no-color 2>/dev/null > "$RUN/wpscan.txt"
fi

# ---------- 7. searchsploit (version -> known public exploit) ----------
if have searchsploit && [ -n "$TECH" ]; then
  log "searchsploit (map fingerprinted tech -> public exploits)"
  echo "$TECH" | tr ',' '\n' | grep . | while read -r t; do
    searchsploit --color=never "$t" 2>/dev/null | grep -ivE "no results|^---|Exploit Title" | head -10 | sed "s/^/[$t] /"
  done > "$RUN/searchsploit.txt" 2>/dev/null
  log "searchsploit candidates: $(wc -l < "$RUN/searchsploit.txt" 2>/dev/null||echo 0)"
fi

# ---------- consolidate + ingest ----------
SUMMARY="$OUT/latest_summary.md"
{
  echo "# Vuln/misconfig scan — $PROG @ $TS (mode=$MODE)"
  echo "Targets: $N | Tech: ${TECH:-auto-detected}"
  echo ""
  echo "## nuclei (CVE/misconfig/exposure)"; sed 's/^/- /' "$RUN/nuclei_findings.txt" 2>/dev/null | head -100
  echo ""; echo "## jaeles"; sed 's/^/- /' "$RUN/jaeles.txt" 2>/dev/null | head -40
  echo ""; echo "## nikto (server misconfig)"; grep -E "^\+ " "$RUN/nikto.txt" 2>/dev/null | head -40
  echo ""; echo "## wpscan"; grep -iE "vuln|outdated|insecure|\[!\]" "$RUN/wpscan.txt" 2>/dev/null | head -30
  echo ""; echo "## searchsploit (tech -> public exploits)"; sed 's/^/- /' "$RUN/searchsploit.txt" 2>/dev/null | head -40
  echo ""; echo "Raw artifacts: $RUN/"
} > "$SUMMARY"
log "summary -> $SUMMARY"

# ingest into RAG (source=vuln) so the model pulls scan results by context
if [ -n "$RAG_REPO" ] && [ -x "$RAG_HOME/.venv/bin/python" ]; then
  BODY="$(head -c 7000 "$SUMMARY")"
  rag session-add --key "vuln-$PROG" --title "Vuln/misconfig scan $PROG $TS" --body "$BODY" --cwd "$RUN" --keep 20 >/dev/null 2>&1 \
    && log "ingested scan summary into RAG (search: --source session, key vuln-$PROG)"
fi
log "vulnscan complete -> $OUT"
