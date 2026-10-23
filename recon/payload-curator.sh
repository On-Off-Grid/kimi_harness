#!/usr/bin/env bash
# =============================================================================
# pihunt-payload — gather/curate offensive PAYLOADS (not wordlists) from local
# SecLists, GitHub, and the web, mapped to vuln class + exact context, and index
# them into the RAG (source=payload) so hunters pull the LATEST, context-matched
# payloads instead of spraying a static list. (Jason Haddix: pull current
# techniques per sink/filter/WAF, don't reuse a stale list.)
#
# Subcommands:
#   search <regex>                      find local payload files by name
#   add <path> --class C --tags T --use U   index an existing local payload file
#   github <owner/repo> [subpath] --class C --tags T   clone repo, index payload files
#   fetch <raw-url> --class C --tags T --use U          download a raw payload file + index
#   map <class>                         suggest local payload files for a vuln class
#   bootstrap                           pull the canonical payload repos + index by class (run once / on a timer)
#
# Canonical sources (Haddix-style "latest techniques"):
#   swisskyrepo/PayloadsAllTheThings, payloadbox/* (xss/sqli/...), PortSwigger XSS cheat sheet,
#   SecLists/Fuzzing. Env: PIHUNT_RAG_HOME, PIHUNT_RAG_REPO, PAYLOAD_HOME.
# =============================================================================
set -uo pipefail
RAG_HOME="${PIHUNT_RAG_HOME:-$HOME/.pi-hunt-rag}"
PL_HOME="${PAYLOAD_HOME:-$RAG_HOME/payloads}"
CACHE="$PL_HOME/cache"; CURATED="$PL_HOME/curated"
SECLISTS="${SECLISTS_DIR:-/usr/share/seclists}"
mkdir -p "$CACHE" "$CURATED"
RAG_REPO=""
for c in "${PIHUNT_RAG_REPO:-}" "$HOME/Documents/ai/pi-Hunt/pi-hunt-restore/rag" "$HOME/pi-hunt/rag" "$HOME/tools/pi-hunt/rag"; do
  [ -n "$c" ] && [ -f "$c/pihunt_rag/cli.py" ] && { RAG_REPO="$c"; break; }
done
rag(){ [ -n "$RAG_REPO" ] && [ -x "$RAG_HOME/.venv/bin/python" ] && \
  PIHUNT_RAG_HOME="$RAG_HOME" PYTHONPATH="$RAG_REPO" HF_HOME="$RAG_HOME/data/hf" \
  "$RAG_HOME/.venv/bin/python" -m pihunt_rag.cli "$@"; }

# infer a vuln class from a file path/name when --class not given
infer_class(){ case "$(echo "$1" | tr 'A-Z' 'a-z')" in
  *xss*) echo xss;; *sql*) echo sqli;; *ssrf*) echo ssrf;; *ssti*|*template*) echo ssti;;
  *lfi*|*traversal*|*path*) echo lfi;; *rce*|*command*|*cmdi*) echo rce;; *xxe*|*xml*) echo xxe;;
  *redirect*|*ssjs*) echo redirect;; *nosql*) echo nosqli;; *crlf*) echo crlf;; *) echo generic;; esac; }

cmd="${1:-help}"; shift || true
case "$cmd" in
  search)
    q="${1:-.}"
    find "$SECLISTS/Fuzzing" "$CURATED" "$CACHE" -type f \( -name '*.txt' -o -name '*.fuzz' \) 2>/dev/null | grep -iE "$q" | sort -u | head -60
    ;;
  add)
    path="${1:?usage: pihunt-payload add <path> [--class C] [--tags T] [--use U]}"; shift
    cls=""; tags=""; use=""; prog=""
    while [ $# -gt 0 ]; do case "$1" in --class) cls="$2";shift;; --tags) tags="$2";shift;; --use) use="$2";shift;; --program) prog="$2";shift;; esac; shift; done
    [ -f "$path" ] || { echo "not a file: $path"; exit 1; }
    [ -z "$cls" ] && cls="$(infer_class "$path")"
    rag payload-add --path "$path" --vclass "$cls" --tags "${tags:-$cls}" --use "$use" --origin "local" --program "$prog"
    ;;
  github)
    repo="${1:?usage: pihunt-payload github <owner/repo> [subpath] [--class C] [--tags T]}"; shift
    sub=""; [ $# -gt 0 ] && [[ "$1" != --* ]] && { sub="$1"; shift; }
    cls=""; tags=""
    while [ $# -gt 0 ]; do case "$1" in --class) cls="$2";shift;; --tags) tags="$2";shift;; esac; shift; done
    dest="$CACHE/gh_$(echo "$repo" | tr '/' '_')"
    if [ -d "$dest/.git" ]; then git -C "$dest" pull --ff-only -q 2>/dev/null; else git clone --depth 1 "https://github.com/$repo" "$dest" 2>&1 | tail -1; fi
    base="$dest${sub:+/$sub}"; n=0
    while IFS= read -r f; do
      [ -s "$f" ] || continue
      c="${cls:-$(infer_class "$f")}"
      rag payload-add --path "$f" --vclass "$c" --tags "${tags:-github,$repo,$c}" --origin "github:$repo" >/dev/null && n=$((n+1))
    done < <(find "$base" -type f \( -name '*.txt' -o -iname '*payload*' -o -iname '*.fuzz' \) -size +0c 2>/dev/null | grep -ivE 'readme|license|\.md$|\.png$|\.gif$' | head -150)
    echo "indexed $n payload files from github:$repo${sub:+/$sub}"
    ;;
  fetch)
    url="${1:?usage: pihunt-payload fetch <url> [--class C] [--tags T] [--use U]}"; shift
    cls=""; tags=""; use=""
    while [ $# -gt 0 ]; do case "$1" in --class) cls="$2";shift;; --tags) tags="$2";shift;; --use) use="$2";shift;; esac; shift; done
    fn="$CACHE/$(echo "$url" | md5sum | cut -c1-12)_$(basename "${url%%\?*}")"
    curl -fsSL -m120 "$url" -o "$fn" 2>/dev/null || { echo "fetch failed: $url"; exit 1; }
    [ -s "$fn" ] || { echo "empty download"; exit 1; }
    [ -z "$cls" ] && cls="$(infer_class "$url")"
    rag payload-add --path "$fn" --title "$(basename "${url%%\?*}")" --vclass "$cls" --tags "${tags:-$cls}" --use "$use" --origin "$url"
    ;;
  map)
    cls="$(echo "${1:?usage: pihunt-payload map <class>}" | tr 'A-Z' 'a-z')"
    case "$cls" in
      xss) pat="XSS|xss";; sqli|sql) pat="SQLi|SQL";; ssrf) pat="SSRF|ssrf";;
      ssti) pat="SSTI|Template";; lfi|traversal) pat="LFI|Traversal|Directory";;
      rce|cmdi) pat="Command|RCE|cmd";; xxe) pat="XXE|XML";; *) pat="$cls";; esac
    find "$SECLISTS/Fuzzing" -type f -iregex ".*\($pat\).*" 2>/dev/null | sort -u | head -25
    ;;
  bootstrap)
    echo "bootstrapping canonical payload sources into the RAG..."
    # 1. local SecLists Fuzzing (fast, offline) — index high-value per-class files (real SecLists layout)
    for f in \
      "$SECLISTS/Fuzzing/XSS/robot-friendly/XSS-Jhaddix.txt:xss" \
      "$SECLISTS/Fuzzing/XSS/robot-friendly/XSS-BruteLogic.txt:xss" \
      "$SECLISTS/Fuzzing/XSS/Polyglots/XSS-Polyglots.txt:xss" \
      "$SECLISTS/Fuzzing/Databases/SQLi/Generic-SQLi.txt:sqli" \
      "$SECLISTS/Fuzzing/Databases/SQLi/quick-SQLi.txt:sqli" \
      "$SECLISTS/Fuzzing/Databases/SQLi/SQLi-Polyglots.txt:sqli" \
      "$SECLISTS/Fuzzing/LFI/LFI-Jhaddix.txt:lfi" \
      "$SECLISTS/Fuzzing/template-engines-special-vars.txt:ssti" \
      "$SECLISTS/Fuzzing/XXE-Fuzzing.txt:xxe" \
      "$SECLISTS/Fuzzing/command-injection-commix.txt:rce" ; do
      p="${f%:*}"; c="${f##*:}"
      [ -f "$p" ] && rag payload-add --path "$p" --vclass "$c" --tags "seclists,$c" --origin "seclists" >/dev/null 2>&1 && echo "  + seclists $c: $(basename "$p")"
    done
    # 2. GitHub canonical repos (latest community payloads)
    pihunt_self="$(command -v pihunt-payload || echo "$0")"
    "$pihunt_self" github payloadbox/xss-payload-list --class xss --tags "xss,payloadbox" 2>/dev/null | tail -1
    "$pihunt_self" github payloadbox/sql-injection-payload-list --class sqli --tags "sqli,payloadbox" 2>/dev/null | tail -1
    "$pihunt_self" github payloadbox/command-injection-payload-list --class rce --tags "rce,cmdi,payloadbox" 2>/dev/null | tail -1
    "$pihunt_self" github swisskyrepo/PayloadsAllTheThings "XSS Injection" --class xss --tags "xss,PayloadsAllTheThings" 2>/dev/null | tail -1
    "$pihunt_self" github swisskyrepo/PayloadsAllTheThings "Server Side Request Forgery" --class ssrf --tags "ssrf,PayloadsAllTheThings" 2>/dev/null | tail -1
    "$pihunt_self" github swisskyrepo/PayloadsAllTheThings "Server Side Template Injection" --class ssti --tags "ssti,PayloadsAllTheThings" 2>/dev/null | tail -1
    echo "bootstrap complete (search: pihunt-rag search '<class> <context> payloads' --source payload)"
    ;;
  *) sed -n '2,30p' "$0" | sed 's/^# \?//';;
esac
