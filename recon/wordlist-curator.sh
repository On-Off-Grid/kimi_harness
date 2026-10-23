#!/usr/bin/env bash
# =============================================================================
# pihunt-wordlist — gather/curate wordlists from local FS, GitHub, or the web,
# context-mapped to the target's tech stack, and index them into the RAG so the
# model (and ffuf/feroxbuster via cmd-optimizer) can pull the RIGHT list.
#
# Backs the `wordlist-curator` agent. Everything is cached under
# ~/.pi-hunt-rag/wordlists/ and indexed via `pihunt-rag wordlist-add`.
#
# Subcommands:
#   search <regex>                 find local lists (SecLists + common dirs) by name
#   local  <path> --tags t --use u index an existing local list into the RAG
#   github <owner/repo> [subpath]  shallow-clone a repo's wordlists, index *.txt
#   fetch  <url> --tags t --use u  download a raw wordlist, cache + index it
#   map    <tech>                  suggest the best local lists for a tech/context
#   merge  <out> <f1> <f2> ...     dedupe-merge lists into a curated list + index
#   index-seclists                 bulk-index the high-value SecLists by category
#
# Env: PIHUNT_RAG_HOME, PIHUNT_RAG_REPO, WORDLIST_HOME (default ~/.pi-hunt-rag/wordlists)
# =============================================================================
set -uo pipefail
RAG_HOME="${PIHUNT_RAG_HOME:-$HOME/.pi-hunt-rag}"
WL_HOME="${WORDLIST_HOME:-$RAG_HOME/wordlists}"
CACHE="$WL_HOME/cache"; CURATED="$WL_HOME/curated"
SECLISTS="${SECLISTS_DIR:-/usr/share/seclists}"
mkdir -p "$CACHE" "$CURATED"
RAG_REPO=""
for c in "${PIHUNT_RAG_REPO:-}" "$HOME/Documents/ai/pi-Hunt/pi-hunt-restore/rag" "$HOME/pi-hunt/rag" "$HOME/tools/pi-hunt/rag"; do
  [ -n "$c" ] && [ -f "$c/pihunt_rag/cli.py" ] && { RAG_REPO="$c"; break; }
done
rag(){ [ -n "$RAG_REPO" ] && [ -x "$RAG_HOME/.venv/bin/python" ] && \
  PIHUNT_RAG_HOME="$RAG_HOME" PYTHONPATH="$RAG_REPO" HF_HOME="$RAG_HOME/data/hf" \
  "$RAG_HOME/.venv/bin/python" -m pihunt_rag.cli "$@"; }
have(){ command -v "$1" >/dev/null 2>&1; }

cmd="${1:-help}"; shift || true
case "$cmd" in
  search)
    q="${1:-.}"
    { find "$SECLISTS" -type f \( -name '*.txt' -o -name '*.fuzz.txt' \) 2>/dev/null
      ls -d /usr/share/wordlists/* "$HOME/wordlists/"* "$CURATED/"* 2>/dev/null
    } | grep -iE "$q" | sort -u | head -60
    ;;
  local)
    path="${1:?usage: pihunt-wordlist local <path> [--tags t] [--use u] [--program p]}"; shift
    tags=""; use=""; prog=""
    while [ $# -gt 0 ]; do case "$1" in --tags) tags="$2";shift;; --use) use="$2";shift;; --program) prog="$2";shift;; esac; shift; done
    [ -f "$path" ] || { echo "not a file: $path"; exit 1; }
    rag wordlist-add --path "$path" --tags "$tags" --use "$use" --origin "local" --program "$prog"
    ;;
  github)
    repo="${1:?usage: pihunt-wordlist github <owner/repo> [subpath] [--tags t] [--use u]}"; shift
    sub="${1:-}"; [ -n "$sub" ] && [[ "$sub" != --* ]] && shift || sub=""
    tags=""; use=""
    while [ $# -gt 0 ]; do case "$1" in --tags) tags="$2";shift;; --use) use="$2";shift;; esac; shift; done
    dest="$CACHE/gh_$(echo "$repo" | tr '/' '_')"
    if [ -d "$dest/.git" ]; then git -C "$dest" pull --ff-only -q 2>/dev/null; else
      git clone --depth 1 "https://github.com/$repo" "$dest" 2>&1 | tail -1; fi
    base="$dest${sub:+/$sub}"
    n=0
    while IFS= read -r f; do
      [ -s "$f" ] || continue
      rag wordlist-add --path "$f" --tags "${tags:-github,$repo}" --use "$use" --origin "github:$repo" >/dev/null && n=$((n+1))
    done < <(find "$base" -type f \( -name '*.txt' -o -name '*.list' \) -size +0c 2>/dev/null | head -200)
    echo "indexed $n wordlists from github:$repo${sub:+/$sub} (cached at $dest)"
    ;;
  fetch)
    url="${1:?usage: pihunt-wordlist fetch <url> [--tags t] [--use u]}"; shift
    tags=""; use=""
    while [ $# -gt 0 ]; do case "$1" in --tags) tags="$2";shift;; --use) use="$2";shift;; esac; shift; done
    fn="$CACHE/$(echo "$url" | md5sum | cut -c1-12)_$(basename "${url%%\?*}")"
    curl -fsSL -m120 "$url" -o "$fn" 2>/dev/null || { echo "fetch failed: $url"; exit 1; }
    [ -s "$fn" ] || { echo "empty download: $url"; exit 1; }
    rag wordlist-add --path "$fn" --title "$(basename "${url%%\?*}")" --tags "${tags:-web}" --use "$use" --origin "$url"
    ;;
  map)
    tech="${1:?usage: pihunt-wordlist map <tech/context>}"
    echo "# Best local lists for: $tech"
    case "$(echo "$tech" | tr 'A-Z' 'a-z')" in
      *iis*|*asp*|*.net*|*windows*) pat="IIS|aspx|asp|dotnet|windows|sharepoint";;
      *api*|*rest*|*graphql*|*swagger*) pat="api|swagger|graphql|openapi|rest";;
      *php*|*wordpress*|*wp*|*laravel*) pat="php|wordpress|wp-|laravel|CommonBackdoors-PHP";;
      *java*|*tomcat*|*spring*|*jboss*) pat="java|tomcat|spring|jboss|struts";;
      *node*|*express*|*js*) pat="nodejs|javascript|js";;
      *param*|*idor*|*ssrf*) pat="burp-parameter|param";;
      *) pat="$tech";;
    esac
    find "$SECLISTS" -type f -name '*.txt' 2>/dev/null | grep -iE "$pat" | sort -u | head -25
    ;;
  merge)
    out="${1:?usage: pihunt-wordlist merge <out-name> <f1> [f2 ...]}"; shift
    dst="$CURATED/$out"; : > "$dst"
    for f in "$@"; do [ -f "$f" ] && cat "$f" >> "$dst"; done
    if have anew; then sort -u "$dst" -o "$dst"; else sort -u "$dst" -o "$dst"; fi
    rag wordlist-add --path "$dst" --title "$out" --tags "curated,merged" --use "merged curated list" --origin "generated"
    echo "merged $# lists -> $dst ($(wc -l < "$dst") unique)"
    ;;
  index-seclists)
    echo "indexing high-value SecLists by category..."
    declare -A L=(
      ["raft-large-directories"]="content-discovery,dirs"
      ["raft-large-words"]="content-discovery,words"
      ["api/api-endpoints"]="api,rest"
      ["api/objects"]="api,objects"
      ["burp-parameter-names"]="params,idor,ssrf"
      ["graphql"]="api,graphql"
      ["common"]="content-discovery,generic"
    )
    n=0
    for key in "${!L[@]}"; do
      f=$(find "$SECLISTS/Discovery/Web-Content" -path "*$key.txt" 2>/dev/null | head -1)
      [ -s "$f" ] && rag wordlist-add --path "$f" --tags "${L[$key]}" --use "${L[$key]}" --origin "seclists" >/dev/null && n=$((n+1))
    done
    # DNS + LFI
    for f in "$SECLISTS/Discovery/DNS/subdomains-top1million-110000.txt" "$SECLISTS/Fuzzing/LFI/LFI-Jhaddix.txt"; do
      [ -s "$f" ] && rag wordlist-add --path "$f" --tags "$(basename "$f" .txt)" --use "dns/lfi" --origin "seclists" >/dev/null && n=$((n+1))
    done
    echo "indexed $n high-value SecLists into the RAG (source=wordlist)"
    ;;
  *) sed -n '2,30p' "$0" | sed 's/^# \?//';;
esac
