#!/usr/bin/env bash
# =============================================================================
# pi-hunt recon-engine — continuous, deep recon that feeds the RAG.
#
# Runs a full passive+active recon pipeline for a program/domain and writes
# normalized artifacts under reports/<program>/structured-recon/. Designed to be
# re-run periodically (systemd timer): each run DIFFS against the previous run
# (via `anew`) so new subdomains/endpoints/params surface as "NEW since last run",
# then re-ingests everything into the RAG so the model can pull current recon.
#
# Stages (each best-effort; missing tools are skipped with a note):
#   0. Wide-scope infra (Haddix) — asnmap+whois ASN/IP-space; cloud-cert SAN harvest (mapcidr+cero, deep)
#   1. Subdomain enum   — subfinder, amass(passive), assetfinder, findomain, crt.sh, github-subdomains
#   2. DNS brute + resolve — dnsx/puredns(massdns) with SecLists DNS wordlists
#   3. Resolution+takeover — dnsx (A/CNAME), flags dangling CNAMEs
#   4. Port scan        — masscan wide-port SYN sweep (sudo) -> nmap -sV on open ports (deep); naabu/smap fallback; smap passive (normal)
#   5. HTTP probe       — httpx (status, title, tech, CDN, TLS)
#   5b.Visual heat-map  — gowitness/eyewitness screenshots of live hosts (deep)
#   6. Crawl + URLs     — katana + gau + waybackurls
#   7. Param discovery  — arjun on live hosts + param mining from URLs/JS
#   8. Content discovery — feroxbuster/ffuf/gobuster/dirsearch/wfuzz (RECON_CD_TOOL) on capped live hosts
#   9. JS/secret mine   — pull JS -> jsleak (784-pattern secret sweep + endpoint mining,
#                        detector-filtered; fallback: hardcoded core regexes) + trufflehog verify (deep)
#  10. Ingest to RAG    — source=recon, keyed by program (semantic pull)
#
# Implements Jason Haddix "Recon Like an Adversary": ASN/IP-space first, cloud-cert
# org matching, github-subdomains as a top source, naabu->nmap chain, SMAP passive,
# and visual prioritization. Supply API keys (Chaos/GitHub/Shodan) in subfinder's
# provider-config + GITHUB_TOKEN for ~28% more subdomains.
#
# Usage:
#   recon-engine.sh <program> <domain[,domain2,...]> [--scope-file F] [--fast] [--deep]
#   recon-engine.sh acme example.com,api.example.com
#   recon-engine.sh acme example.com --fast        # passive + probe only (quick, timer-friendly)
#   recon-engine.sh acme example.com --deep         # + brute + ports + fuzz (heavy)
#
# Env: PIHUNT_RECON_ROOT (default ~/hunts), RECON_FFUF_HOST_CAP (default 8),
#      RECON_PORTS (default "top-1000"), PIHUNT_RAG_HOME.
# =============================================================================
set -uo pipefail

PROG="${1:-}"; DOMAINS_CSV="${2:-}"
[ -z "$PROG" ] || [ -z "$DOMAINS_CSV" ] && { echo "usage: recon-engine.sh <program> <domain[,domain2]> [--fast|--deep] [--scope-file F]"; exit 1; }
shift 2 || true

MODE="normal"; SCOPE_FILE=""
while [ $# -gt 0 ]; do case "$1" in
  --fast) MODE="fast";; --deep) MODE="deep";;
  --scope-file) SCOPE_FILE="$2"; shift;;
esac; shift; done

ROOT="${PIHUNT_RECON_ROOT:-$HOME/hunts}"
OUT="$ROOT/$PROG/structured-recon"
RUN_TS="$(date -u +%Y%m%dT%H%M%SZ)"
RUNS="$OUT/runs/$RUN_TS"
RESOLVERS="$HOME/.pi-hunt-rag/recon-assets/resolvers.txt"
DNS_WL="/usr/share/seclists/Discovery/DNS/subdomains-top1million-110000.txt"
[ "$MODE" = "deep" ] && DNS_WL="/usr/share/seclists/Discovery/DNS/dns-Jhaddix.txt"
DIR_WL="/usr/share/seclists/Discovery/Web-Content/raft-large-directories.txt"
FFUF_CAP="${RECON_FFUF_HOST_CAP:-8}"
RAG_HOME="${PIHUNT_RAG_HOME:-$HOME/.pi-hunt-rag}"
# Locate the rag package: env override, else fallback candidates, else common installs.
_self_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RAG_REPO=""
for cand in "${PIHUNT_RAG_REPO:-}" "$_self_dir/../rag" "$_self_dir/rag" "$HOME/Desktop/Desktop/harness/rag" "$HOME/Documents/ai/pi-Hunt/pi-hunt-restore/rag" "$HOME/pi-hunt/rag" "$HOME/tools/pi-hunt/rag"; do
  [ -n "$cand" ] && [ -f "$cand/pihunt_rag/recon_ingest.py" ] && { RAG_REPO="$(cd "$cand" && pwd)"; break; }
done

mkdir -p "$OUT" "$RUNS"
have(){ command -v "$1" >/dev/null 2>&1; }
log(){ printf '\033[1;36m[recon %s]\033[0m %s\n' "$(date -u +%H:%M:%S)" "$*"; }
note(){ printf '   %s\n' "$*"; }
DOMAINS="$(echo "$DOMAINS_CSV" | tr ',' '\n' | sed 's/^\*\.//; s/^\s*//; s/\s*$//' | grep . | sort -u)"
echo "$DOMAINS" > "$OUT/scope_domains.txt"

log "program=$PROG mode=$MODE domains=$(echo "$DOMAINS"|tr '\n' ' ')"

# Reuse a GitHub token (env, or scrape the MCP config) for github-subdomains.
GH_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-${GITHUB_MCP_TOKEN:-}}}"
[ -z "$GH_TOKEN" ] && GH_TOKEN="$(grep -hoE 'github_pat_[A-Za-z0-9_]+|ghp_[A-Za-z0-9]+' "$HOME/.pi/agent/mcp.json" "$HOME/.kiro/settings/mcp.json" 2>/dev/null | head -1)"
ORG_NAME="${RECON_ORG_NAME:-$PROG}"   # human org name for ASN search (override if handle != company)

# ========== STAGE 0: WIDE-SCOPE INFRA (Haddix) — ASN / IP-space / cloud certs ==========
# Owned IP space + ASNs + cloud-cert org matches. Heavy/noisy -> normal+deep only.
if [ "$MODE" != "fast" ]; then
  log "stage 0: ASN / IP-space discovery (asnmap + whois.cymru)"
  : > "$RUNS/asn.txt"; : > "$RUNS/cidrs.txt"
  PDCP_KEY="${PDCP_API_KEY:-${CHAOS_KEY:-}}"
  if have asnmap && [ -n "$PDCP_KEY" ]; then
    # asnmap needs a ProjectDiscovery Cloud key; only call it when one is set (else it hangs on a prompt).
    PDCP_API_KEY="$PDCP_KEY" asnmap -org "$ORG_NAME" -silent </dev/null 2>/dev/null >> "$RUNS/cidrs.txt"
    while read -r d; do [ -z "$d" ] && continue; PDCP_API_KEY="$PDCP_KEY" asnmap -d "$d" -silent </dev/null 2>/dev/null >> "$RUNS/cidrs.txt"; done <<< "$DOMAINS"
  fi
  # whois.cymru ASN cross-lookup (NO key; reveals ASN/BGP-prefix/owner AND whether target is CDN-fronted)
  while read -r d; do
    [ -z "$d" ] && continue
    ip=$(getent hosts "$d" 2>/dev/null | awk '{print $1; exit}')
    [ -n "$ip" ] && whois -h whois.cymru.com " -v $ip" 2>/dev/null | tail -1 | sed "s/^/$d | /" >> "$RUNS/asn.txt"
  done <<< "$DOMAINS"
  # if asnmap gave nothing but cymru found owner BGP prefixes that are NOT CDN, harvest those CIDRs
  if [ ! -s "$RUNS/cidrs.txt" ]; then
    grep -ivE "cloudflare|akamai|fastly|amazon|cloudfront|google|azure|incapsula|sucuri" "$RUNS/asn.txt" 2>/dev/null \
      | awk -F'|' '{print $4}' | grep -oE "([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]+|[0-9a-f:]+/[0-9]+" | sort -u >> "$RUNS/cidrs.txt"
  fi
  sort -u "$RUNS/cidrs.txt" -o "$RUNS/cidrs.txt" 2>/dev/null
  note "owned CIDRs: $(wc -l < "$RUNS/cidrs.txt" 2>/dev/null||echo 0) | ASN/owner hints: $(wc -l < "$RUNS/asn.txt" 2>/dev/null||echo 0)"
  cp -f "$RUNS/cidrs.txt" "$OUT/owned_cidrs.txt" 2>/dev/null; cp -f "$RUNS/asn.txt" "$OUT/asn_info.txt" 2>/dev/null

  # cloud-cert reverse: expand owned CIDRs (mapcidr) -> grab TLS cert CN/SAN (cero) -> match org/domains
  if [ "$MODE" = "deep" ] && have cero && have mapcidr && [ -s "$RUNS/cidrs.txt" ]; then
    log "stage 0b: cloud-cert SAN harvest (mapcidr + cero) [deep]"
    CIDR_IP_CAP="${RECON_CIDR_IP_CAP:-4096}"
    head -64 "$RUNS/cidrs.txt" | timeout 120 mapcidr -silent </dev/null 2>/dev/null | head -"$CIDR_IP_CAP" \
      | timeout 600 cero -d -c 200 2>/dev/null | grep -E '\.' | sort -u > "$RUNS/cert_names.txt"
    grep -F -f <(echo "$DOMAINS") "$RUNS/cert_names.txt" 2>/dev/null >> "$RUNS/subs_raw.txt" 2>/dev/null
    cp -f "$RUNS/cert_names.txt" "$OUT/cloud_cert_names.txt" 2>/dev/null
    note "cloud cert names: $(wc -l < "$RUNS/cert_names.txt" 2>/dev/null||echo 0)"
  fi
fi

# ---------- 1. subdomain enumeration ----------
log "stage 1: subdomain enumeration"
: >> "$RUNS/subs_raw.txt"
while read -r d; do
  [ -z "$d" ] && continue
  have subfinder    && subfinder -silent -d "$d"            2>/dev/null >> "$RUNS/subs_raw.txt"
  have assetfinder  && assetfinder --subs-only "$d"          2>/dev/null >> "$RUNS/subs_raw.txt"
  have findomain    && findomain -t "$d" -q                  2>/dev/null >> "$RUNS/subs_raw.txt"
  # crt.sh passive (no key)
  curl -s -m20 "https://crt.sh/?q=%25.$d&output=json" 2>/dev/null \
    | grep -oE "[a-zA-Z0-9._-]+\.$d" >> "$RUNS/subs_raw.txt" 2>/dev/null
  if [ "$MODE" = "deep" ] && have amass; then
    timeout 300 amass enum -passive -d "$d" 2>/dev/null >> "$RUNS/subs_raw.txt"
  fi
  # github-subdomains: scrape domain refs in code (Haddix: top-3 source, finds obscure refs)
  if have github-subdomains && [ -n "$GH_TOKEN" ]; then
    timeout 120 github-subdomains -d "$d" -t "$GH_TOKEN" -q 2>/dev/null >> "$RUNS/subs_raw.txt"
  fi
done <<< "$DOMAINS"
echo "$DOMAINS" >> "$RUNS/subs_raw.txt"
sort -u "$RUNS/subs_raw.txt" | grep -E '\.' > "$RUNS/subs_passive.txt"
note "passive subdomains: $(wc -l < "$RUNS/subs_passive.txt")"
# Safety cap so a giant crt.sh footprint can't make a periodic run unbounded.
SUBS_CAP="${RECON_SUBS_CAP:-5000}"
if [ "$(wc -l < "$RUNS/subs_passive.txt")" -gt "$SUBS_CAP" ]; then
  note "capping passive subdomains to $SUBS_CAP (full set in subs_raw.txt)"
  head -"$SUBS_CAP" "$RUNS/subs_passive.txt" > "$RUNS/subs_passive.capped.txt" && mv "$RUNS/subs_passive.capped.txt" "$RUNS/subs_passive.txt"
fi

# ---------- 2. DNS brute (skip in fast mode) ----------
if [ "$MODE" != "fast" ] && [ -f "$DNS_WL" ]; then
  log "stage 2: DNS brute ($(basename "$DNS_WL"))"
  while read -r d; do
    [ -z "$d" ] && continue
    if have puredns && have massdns && [ -s "$RESOLVERS" ]; then
      puredns bruteforce "$DNS_WL" "$d" -r "$RESOLVERS" --quiet 2>/dev/null >> "$RUNS/subs_brute.txt"
    elif have dnsx; then
      sed "s/$/.$d/" "$DNS_WL" | head -20000 | dnsx -silent -r "$RESOLVERS" 2>/dev/null >> "$RUNS/subs_brute.txt"
    fi
  done <<< "$DOMAINS"
  sort -u "$RUNS/subs_brute.txt" 2>/dev/null > "$RUNS/subs_brute.sorted.txt"
  note "brute subdomains: $(wc -l < "$RUNS/subs_brute.sorted.txt" 2>/dev/null || echo 0)"
fi
cat "$RUNS/subs_passive.txt" "$RUNS/subs_brute.sorted.txt" 2>/dev/null | sort -u > "$RUNS/subs_all.txt"

# ---------- 3. resolve + takeover signal ----------
log "stage 3: DNS resolution"
if have dnsx; then
  # cap brute/passive union to keep periodic runs bounded; full list stays on disk
  RESOLVE_CAP="${RECON_RESOLVE_CAP:-3000}"
  head -"$RESOLVE_CAP" "$RUNS/subs_all.txt" > "$RUNS/subs_to_resolve.txt"
  timeout 240 dnsx -silent -no-color -a -cname -resp -r "$RESOLVERS" < "$RUNS/subs_to_resolve.txt" 2>/dev/null > "$RUNS/dns_resolved.txt"
  # strip any ANSI colour + leading [HH:MM:SS] timestamp before extracting the host,
  # then take the first whitespace-delimited token (the resolved hostname).
  sed -r 's/\x1B\[[0-9;]*[mK]//g; s/^\[[0-9:]+\] *//' "$RUNS/dns_resolved.txt" \
    | awk '{print $1}' | grep -E '\.' | sort -u > "$RUNS/hosts_resolved.txt"
  # dangling-CNAME candidates: CNAME present but provider-orphan keywords
  grep -iE "CNAME" "$RUNS/dns_resolved.txt" 2>/dev/null \
    | grep -iE "s3|azurewebsites|cloudfront|github.io|heroku|unbounce|sendgrid|fastly|netlify|ghost|surge|bitbucket|readthedocs|wpengine|zendesk|cargocollective" \
    > "$OUT/takeover_candidates.txt" 2>/dev/null
else
  cp "$RUNS/subs_all.txt" "$RUNS/hosts_resolved.txt"
fi
note "resolved hosts: $(wc -l < "$RUNS/hosts_resolved.txt" 2>/dev/null || echo 0) | takeover candidates: $(wc -l < "$OUT/takeover_candidates.txt" 2>/dev/null || echo 0)"

# ---------- 4. port scan ----------
if [ "$MODE" = "deep" ]; then
  log "stage 4: port scan (masscan wide -> nmap -sV; naabu fallback)"
  # extract resolved A-record IPs (masscan needs IPs, not hostnames)
  grep -oE "([0-9]{1,3}\.){3}[0-9]{1,3}" "$RUNS/dns_resolved.txt" 2>/dev/null | sort -u > "$RUNS/ips.txt"
  [ -s "$RUNS/ips.txt" ] || awk '{print $NF}' "$RUNS/hosts_resolved.txt" 2>/dev/null | grep -oE "([0-9]{1,3}\.){3}[0-9]{1,3}" | sort -u > "$RUNS/ips.txt"
  MASSCAN_PORTS="${RECON_MASSCAN_PORTS:-0-1024,1433,1521,2049,2375,3000,3306,3389,4443,4444,5000,5432,5601,5900,5984,6379,7001,8000,8008,8080,8081,8086,8088,8443,8888,9000,9092,9200,9300,11211,15672,27017}"
  MASSCAN_RATE="${RECON_MASSCAN_RATE:-1000}"
  if have masscan && [ -s "$RUNS/ips.txt" ] && sudo -n true 2>/dev/null; then
    # masscan by NAME: fast SYN sweep of wide port set across resolved IPs (needs root/sudo)
    timeout 900 sudo -n masscan -iL "$RUNS/ips.txt" -p"$MASSCAN_PORTS" --rate "$MASSCAN_RATE" -oG "$RUNS/masscan.gnmap" 2>/dev/null
    # parse open ip:port pairs
    grep -oE "Host: [0-9.]+ .*Ports: [0-9]+" "$RUNS/masscan.gnmap" 2>/dev/null \
      | sed -E 's/Host: ([0-9.]+).*Ports: ([0-9]+)/\1:\2/' | sort -u > "$RUNS/open_ports.txt"
    awk -F: '{print $1}' "$RUNS/open_ports.txt" | sort -u > "$RUNS/open_ips.txt"
    PORTLIST=$(awk -F: '{print $2}' "$RUNS/open_ports.txt" | sort -un | paste -sd,)
    # nmap -sV ONLY on the IPs/ports masscan flagged (intrusive scan only where a port is open)
    if have nmap && [ -n "$PORTLIST" ] && [ -s "$RUNS/open_ips.txt" ]; then
      timeout 1200 nmap -sV -T4 -Pn -p "$PORTLIST" -iL "$RUNS/open_ips.txt" -oN "$RUNS/nmap_sv.txt" 2>/dev/null
    fi
    cat "$RUNS/open_ports.txt" "$RUNS/nmap_sv.txt" 2>/dev/null > "$RUNS/ports.txt"
  elif have naabu && have nmap; then
    timeout 900 naabu -silent -top-ports 1000 -l "$RUNS/hosts_resolved.txt" -nmap-cli 'nmap -sV -T4' 2>/dev/null > "$RUNS/ports.txt"
  elif have naabu; then
    timeout 600 naabu -silent -top-ports 1000 -l "$RUNS/hosts_resolved.txt" 2>/dev/null > "$RUNS/ports.txt"
  elif have smap; then
    timeout 300 smap -iL "$RUNS/hosts_resolved.txt" 2>/dev/null > "$RUNS/ports.txt"
  fi
  cp -f "$RUNS/ports.txt" "$OUT/ports.txt" 2>/dev/null
  cp -f "$RUNS/nmap_sv.txt" "$OUT/nmap_services.txt" 2>/dev/null
  note "open ports/services: $(wc -l < "$RUNS/ports.txt" 2>/dev/null || echo 0) (masscan IPs: $(wc -l < "$RUNS/ips.txt" 2>/dev/null||echo 0))"
elif [ "$MODE" = "normal" ] && have smap; then
  log "stage 4: passive port scan (smap/Shodan — zero target traffic)"
  timeout 200 smap -iL "$RUNS/hosts_resolved.txt" 2>/dev/null > "$OUT/ports_passive.txt"
  note "passive ports: $(wc -l < "$OUT/ports_passive.txt" 2>/dev/null || echo 0)"
fi

# ---------- 5. HTTP probe ----------
log "stage 5: HTTP probe (httpx)"
if have httpx; then
  timeout 300 httpx -silent -td -title -sc -cdn -tls-grab -web-server -ip \
    -json < "$RUNS/hosts_resolved.txt" 2>/dev/null > "$RUNS/httpx.jsonl"
  python3 - "$RUNS/httpx.jsonl" "$RUNS/live_hosts.txt" "$OUT/tech-stack.md" <<'PY' 2>/dev/null
import json,sys
src,live,tech=sys.argv[1],sys.argv[2],sys.argv[3]
hosts=[]; rows=[]
for ln in open(src,errors='replace'):
    ln=ln.strip()
    if not ln: continue
    try: o=json.loads(ln)
    except: continue
    u=o.get('url') or o.get('input'); 
    if u: hosts.append(u)
    rows.append((u, o.get('status_code'), (o.get('title') or '')[:60], ','.join(o.get('tech',[]) or []), o.get('webserver',''), o.get('cdn_name','')))
open(live,'w').write('\n'.join(sorted(set(h for h in hosts if h)))+'\n')
with open(tech,'w') as f:
    f.write('# Tech stack / live hosts\n\n| URL | Status | Title | Tech | Server | CDN |\n|---|---|---|---|---|---|\n')
    for r in sorted(rows, key=lambda x:str(x[0])):
        f.write(f"| {r[0]} | {r[1]} | {r[2]} | {r[3]} | {r[4]} | {r[5]} |\n")
PY
else
  cp "$RUNS/hosts_resolved.txt" "$RUNS/live_hosts.txt"
fi
note "live hosts: $(wc -l < "$RUNS/live_hosts.txt" 2>/dev/null || echo 0)"

# ---------- 5b. visual heat-mapping (Haddix Phase 2: screenshot prioritization) ----------
# Screenshot live hosts so the model/operator can triage by look (legacy UI, login
# portals, exposed config). gowitness preferred (fast, sqlite), eyewitness fallback.
if [ "$MODE" = "deep" ] && [ -s "$RUNS/live_hosts.txt" ]; then
  SHOT_CAP="${RECON_SHOT_CAP:-60}"
  SHOTS="$OUT/screenshots"; mkdir -p "$SHOTS"
  if have gowitness; then
    log "stage 5b: screenshots (gowitness, top $SHOT_CAP live hosts)"
    head -"$SHOT_CAP" "$RUNS/live_hosts.txt" > "$RUNS/shot_targets.txt"
    ( cd "$SHOTS" && timeout 420 gowitness scan file -f "$RUNS/shot_targets.txt" -s ./ --write-db 2>/dev/null \
        || timeout 420 gowitness file -f "$RUNS/shot_targets.txt" -P ./ 2>/dev/null )
    note "screenshots: $(ls "$SHOTS"/*.png 2>/dev/null | wc -l) -> $SHOTS"
  elif have eyewitness; then
    log "stage 5b: screenshots (eyewitness, top $SHOT_CAP)"
    head -"$SHOT_CAP" "$RUNS/live_hosts.txt" > "$RUNS/shot_targets.txt"
    timeout 420 eyewitness --web -f "$RUNS/shot_targets.txt" -d "$SHOTS" --no-prompt 2>/dev/null
    note "screenshots -> $SHOTS"
  fi
fi

# ---------- 6. crawl + url collection ----------
log "stage 6: URL collection (katana + gau + wayback)"
: > "$RUNS/urls_raw.txt"
if [ "$MODE" != "fast" ] && have katana; then
  timeout 180 katana -silent -jc -kf all -d 2 -list "$RUNS/live_hosts.txt" 2>/dev/null | head -20000 >> "$RUNS/urls_raw.txt"
fi
while read -r d; do
  [ -z "$d" ] && continue
  have gau         && timeout 90 gau --threads 5 "$d" 2>/dev/null | head -10000 >> "$RUNS/urls_raw.txt"
  have waybackurls && timeout 90 bash -c "echo '$d' | waybackurls" 2>/dev/null | head -10000 >> "$RUNS/urls_raw.txt"
done <<< "$DOMAINS"
sort -u "$RUNS/urls_raw.txt" | grep -E '^https?://' > "$OUT/urls.txt" 2>/dev/null
note "urls: $(wc -l < "$OUT/urls.txt" 2>/dev/null || echo 0)"

# ---------- 7. parameter discovery ----------
log "stage 7: parameter discovery"
# 7a. mine params from collected URLs
grep -oE '[?&][a-zA-Z0-9_.-]+=' "$OUT/urls.txt" 2>/dev/null | sed 's/[?&=]//g' | sort -u > "$RUNS/params_from_urls.txt"
# 7b. arjun active discovery on a capped set of live hosts (skip in fast)
if [ "$MODE" != "fast" ] && have arjun; then
  head -"$FFUF_CAP" "$RUNS/live_hosts.txt" 2>/dev/null | while read -r u; do
    timeout 90 arjun -u "$u" -oT "$RUNS/arjun_$(echo "$u"|md5sum|cut -c1-8).txt" 2>/dev/null
  done
  cat "$RUNS"/arjun_*.txt 2>/dev/null | grep -oE '[a-zA-Z0-9_.-]+' | sort -u >> "$RUNS/params_from_urls.txt"
fi
sort -u "$RUNS/params_from_urls.txt" 2>/dev/null > "$OUT/params.txt"
note "params: $(wc -l < "$OUT/params.txt" 2>/dev/null || echo 0)"

# ---------- 8. content discovery (deep only, capped; multi-tool) ----------
# Tools: feroxbuster (default; recursive, auto-filter), ffuf, gobuster, dirsearch, wfuzz.
# Pick with RECON_CD_TOOL (default feroxbuster). Tech-matched wordlist via RECON_CD_WORDLIST.
if [ "$MODE" = "deep" ]; then
  CD_TOOL="${RECON_CD_TOOL:-feroxbuster}"
  CD_WL="$DIR_WL"
  [ -n "${RECON_CD_WORDLIST:-}" ] && [ -f "$RECON_CD_WORDLIST" ] && CD_WL="$RECON_CD_WORDLIST"
  # Auto: if no explicit wordlist, ask the RAG for a tech-matched list the curator indexed.
  if [ -z "${RECON_CD_WORDLIST:-}" ] && [ -n "$RAG_REPO" ] && [ -x "$RAG_HOME/.venv/bin/python" ] && [ -s "$OUT/tech-stack.md" ]; then
    TECH_HINT=$(grep -oiE 'iis|asp\.net|php|wordpress|laravel|tomcat|spring|java|node|express|django|rails|graphql|api' "$OUT/tech-stack.md" 2>/dev/null | head -1)
    if [ -n "$TECH_HINT" ]; then
      CAND=$(PIHUNT_RAG_HOME="$RAG_HOME" PYTHONPATH="$RAG_REPO" HF_HOME="$RAG_HOME/data/hf" \
        "$RAG_HOME/.venv/bin/python" -m pihunt_rag.cli search "$TECH_HINT content discovery wordlist" --source wordlist -k 1 --json 2>/dev/null \
        | grep -oE '"ref": *"[^"]+"' | head -1 | cut -d'"' -f4)
      [ -n "$CAND" ] && [ -f "$CAND" ] && { CD_WL="$CAND"; note "auto-selected tech-matched wordlist for '$TECH_HINT': $(basename "$CAND")"; }
    fi
  fi
  have "$CD_TOOL" || { for alt in feroxbuster ffuf gobuster dirsearch wfuzz; do have "$alt" && { CD_TOOL="$alt"; break; }; done; }
  if have "$CD_TOOL" && [ -f "$CD_WL" ]; then
    log "stage 8: content discovery ($CD_TOOL, top $FFUF_CAP hosts, wl=$(basename "$CD_WL"))"
    : > "$OUT/content_discovery.txt"
    MC="200,201,204,301,302,307,401,403,405"
    head -"$FFUF_CAP" "$RUNS/live_hosts.txt" 2>/dev/null | while read -r u; do
      base="${u%/}"; h8=$(echo "$base"|md5sum|cut -c1-8)
      case "$CD_TOOL" in
        feroxbuster)
          timeout 420 feroxbuster -u "$base" -w "$CD_WL" --json -q -k -t 40 -d 2 --no-state -o "$RUNS/cd_$h8.txt" 2>/dev/null
          # --json emits JSON lines; keep only response records and pull their url
          grep -E '"type":"response"' "$RUNS/cd_$h8.txt" 2>/dev/null | grep -oE '"url":"[^"]+"' | cut -d'"' -f4 >> "$OUT/content_discovery.txt" ;;
        ffuf)
          ffuf -u "$base/FUZZ" -w "$CD_WL" -mc "$MC" -t 40 -ac -s 2>/dev/null | sed "s|^|$base/|" >> "$OUT/content_discovery.txt" ;;
        gobuster)
          timeout 300 gobuster dir -u "$base" -w "$CD_WL" -q -t 40 -k -b '' 2>/dev/null | awk '{print $1}' | sed "s|^|$base|" >> "$OUT/content_discovery.txt" ;;
        dirsearch)
          timeout 300 dirsearch -u "$base" -w "$CD_WL" -q --format=plain -o "$RUNS/cd_$h8.txt" 2>/dev/null
          grep -oE 'https?://[^ ]+' "$RUNS/cd_$h8.txt" 2>/dev/null >> "$OUT/content_discovery.txt" ;;
        wfuzz)
          timeout 300 wfuzz -w "$CD_WL" -u "$base/FUZZ" --hc 404 -o raw 2>/dev/null | grep -oE '"/[^" ]+"' | tr -d '"' | sed "s|^|$base|" >> "$OUT/content_discovery.txt" ;;
      esac
    done
    sort -u "$OUT/content_discovery.txt" -o "$OUT/content_discovery.txt" 2>/dev/null
    note "content hits ($CD_TOOL): $(wc -l < "$OUT/content_discovery.txt" 2>/dev/null || echo 0)"
  else
    note "stage 8 skipped: no content-discovery tool or wordlist available"
  fi
fi

# ---------- 9. JS / secret mining ----------
log "stage 9: JS + secret mining"
grep -iE '\.js(\?|$)' "$OUT/urls.txt" 2>/dev/null | sort -u | head -200 > "$OUT/js_assets.txt"
: > "$OUT/js_secrets.txt"
: > "$OUT/js_endpoints.txt"
# jsleak (if present): DB-scale secret regexes + LinkFinder-style endpoint mining,
# concurrent workers. Signals only — verified secrets come from trufflehog (deep)
# below / the strict-triager agent. Overridable env:
#   RECON_JSLEAK_PATTERNS   yaml pattern file (default trufflehog-v3 from secrets-patterns-db)
#   RECON_JSLEAK_CAP        max JS files scanned per run (default 60)
#   RECON_JSLEAK_DETECTORS  case-insensitive detector-name filter ("all" = keep everything)
if have jsleak && [ -s "$OUT/js_assets.txt" ]; then
  JSLEAK_PAT="${RECON_JSLEAK_PATTERNS:-$HOME/.pi-hunt-rag/data/jsleak/trufflehog-v3.yml}"
  jsleak_cap="${RECON_JSLEAK_CAP:-60}"
  dets="${RECON_JSLEAK_DETECTORS:-aws|amazon|google|github|gitlab|slack|stripe|twilio|heroku|mailgun|sendgrid|firebase|appsync|jira|discord|sentry|supabase|openai|anthropic|cloudflare|datadog|jwt}"
  head -"$jsleak_cap" "$OUT/js_assets.txt" | jsleak -t "$JSLEAK_PAT" -s -l -c 20 > "$RUNS/jsleak_raw.txt" 2>/dev/null
  grep 'Found link:' "$RUNS/jsleak_raw.txt" 2>/dev/null \
    | sed -E 's|^\[\+\] Found link: \[([^]]*)\] in \[([^]]*)\].*$|\2 :: \1|' | sort -u > "$OUT/js_endpoints.txt"
  grep -E '^\[\+\] Found \[' "$RUNS/jsleak_raw.txt" 2>/dev/null \
    | sed -E 's|^\[\+\] Found \[([^]]*)\] \[([^]]*)\] \[([^]]*)\].*$|\3 :: \1 :: \2|' | sort -u \
    > "$RUNS/jsleak_all.txt"
  if [ -s "$RUNS/jsleak_all.txt" ]; then
    if [ "$dets" = "all" ]; then
      mv "$RUNS/jsleak_all.txt" "$OUT/js_secrets.txt"
    else
      awk -F ' :: ' -v re="$dets" 'tolower($2) ~ re {print}' "$RUNS/jsleak_all.txt" > "$OUT/js_secrets.txt"
    fi
  fi
fi
if ! have jsleak; then   # fallback: core secret regexes (sequential curl loop)
while read -r js; do
  [ -z "$js" ] && continue
  body=$(curl -s -m15 "$js" 2>/dev/null | head -c 600000)
  echo "$body" | grep -aoE "(AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|da2-[a-z0-9]{20,}|sk_live_[0-9a-zA-Z]{20,}|ghp_[A-Za-z0-9]{30,}|xox[bp]-[0-9A-Za-z-]{10,}|firebaseio\.com|[a-z0-9-]+\.appsync-api\.[a-z0-9-]+\.amazonaws\.com)" \
    | sed "s|^|$js :: |" >> "$OUT/js_secrets.txt" 2>/dev/null
done < <(head -60 "$OUT/js_assets.txt")
fi
# trufflehog: verify live/active secrets across collected JS hosts (Haddix: verify, don't just match)
if have trufflehog && [ -s "$RUNS/live_hosts.txt" ] && [ "$MODE" = "deep" ]; then
  head -30 "$RUNS/live_hosts.txt" | while read -r u; do
    timeout 60 trufflehog filesystem --no-update --only-verified --json <(curl -s -m15 "$u" 2>/dev/null) 2>/dev/null
  done | grep -aoE '"DetectorName":"[^"]+"|"Verified":true' | sort -u >> "$OUT/js_secrets.txt" 2>/dev/null
fi
note "js assets: $(wc -l < "$OUT/js_assets.txt" 2>/dev/null||echo 0) | js endpoints: $(wc -l < "$OUT/js_endpoints.txt" 2>/dev/null||echo 0) | secret signals: $(wc -l < "$OUT/js_secrets.txt" 2>/dev/null||echo 0)"

# ---------- promote run -> stable artifacts + DIFF (new since last run) ----------
log "diffing against previous run"
promote(){ # $1 run-file  $2 stable-name
  local rf="$1" stable="$OUT/$2"
  touch "$stable" "$OUT/NEW_$2"        # always exist so manifest wc never errors
  [ -s "$rf" ] || return 0               # nothing new this run
  if have anew; then
    anew "$stable" < "$rf" > "$OUT/NEW_$2" 2>/dev/null
  else
    comm -13 <(sort "$stable") <(sort "$rf") > "$OUT/NEW_$2" 2>/dev/null
    sort -u "$rf" "$stable" -o "$stable" 2>/dev/null
  fi
}
promote "$RUNS/subs_all.txt"      "subdomains_all.txt"
promote "$RUNS/live_hosts.txt"    "subdomains_live.txt"
promote "$RUNS/hosts_resolved.txt" "hosts_resolved.txt"
cp -f "$RUNS/dns_resolved.txt" "$OUT/dns_resolved.txt" 2>/dev/null
NEW_SUBS=$(wc -l < "$OUT/NEW_subdomains_all.txt" 2>/dev/null || echo 0)
NEW_LIVE=$(wc -l < "$OUT/NEW_subdomains_live.txt" 2>/dev/null || echo 0)
note "NEW subdomains this run: $NEW_SUBS | NEW live: $NEW_LIVE"

# ---------- manifest ----------
cat > "$OUT/manifest.md" <<EOF
# Recon manifest — $PROG
- Last run (UTC): $RUN_TS   | mode: $MODE
- Scope domains: $(echo "$DOMAINS" | tr '\n' ' ')
- owned_cidrs.txt (ASN/IP-space): $([ -f "$OUT/owned_cidrs.txt" ] && wc -l < "$OUT/owned_cidrs.txt" || echo 0) | asn_info.txt
- cloud_cert_names.txt (TLS SAN harvest): $([ -f "$OUT/cloud_cert_names.txt" ] && wc -l < "$OUT/cloud_cert_names.txt" || echo 0)
- subdomains_all.txt: $(wc -l < "$OUT/subdomains_all.txt" 2>/dev/null||echo 0) (NEW this run: $NEW_SUBS)
- subdomains_live.txt: $(wc -l < "$OUT/subdomains_live.txt" 2>/dev/null||echo 0) (NEW: $NEW_LIVE)
- hosts_resolved.txt / dns_resolved.txt
- ports.txt / ports_passive.txt: $([ -f "$OUT/ports.txt" ] && wc -l < "$OUT/ports.txt" || ([ -f "$OUT/ports_passive.txt" ] && wc -l < "$OUT/ports_passive.txt" || echo 0))
- takeover_candidates.txt: $(wc -l < "$OUT/takeover_candidates.txt" 2>/dev/null||echo 0)
- screenshots/: $(ls "$OUT/screenshots/"*.png 2>/dev/null | wc -l) images
- urls.txt: $(wc -l < "$OUT/urls.txt" 2>/dev/null||echo 0)
- params.txt: $(wc -l < "$OUT/params.txt" 2>/dev/null||echo 0)
- content_discovery.txt: $([ -f "$OUT/content_discovery.txt" ] && wc -l < "$OUT/content_discovery.txt" || echo 0)
- js_assets.txt / js_endpoints.txt / js_secrets.txt: $(wc -l < "$OUT/js_secrets.txt" 2>/dev/null||echo 0) secret signals
- tech-stack.md
- per-run raw artifacts: runs/$RUN_TS/
EOF
echo "$RUN_TS|$MODE|subs=$(wc -l <"$OUT/subdomains_all.txt" 2>/dev/null||echo 0)|live=$(wc -l <"$OUT/subdomains_live.txt" 2>/dev/null||echo 0)|new=$NEW_SUBS" >> "$OUT/run_history.log"

# ---------- 10. ingest into RAG ----------
log "stage 10: ingest recon into RAG"
if [ -x "$RAG_HOME/.venv/bin/python" ] && [ -n "$RAG_REPO" ]; then
  PIHUNT_RAG_HOME="$RAG_HOME" PYTHONPATH="$RAG_REPO" HF_HOME="$RAG_HOME/data/hf" \
    "$RAG_HOME/.venv/bin/python" -m pihunt_rag.recon_ingest "$PROG" "$OUT" \
    && note "ingested recon for '$PROG' into RAG" || note "RAG ingest failed (artifacts still on disk at $OUT)"
else
  note "RAG recon ingester not found (set PIHUNT_RAG_REPO); artifacts on disk at $OUT"
fi

log "recon complete -> $OUT"
