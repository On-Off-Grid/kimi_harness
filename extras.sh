#!/usr/bin/env bash
# =============================================================================
# pi-hunt extras — OPTIONAL runtime hunting toolchain (NOT part of pi-hunt config)
#
# install.sh restores the pi-hunt OpenRouter runtime (agent, MCPs, prompts).
# This script installs the external CLI tools + wordlists the specialist agents
# invoke at runtime via the shell. Best-effort: it prints what it can't do.
#
# Usage:  ./extras.sh           # install everything it can
#         ./extras.sh --dry-run
# Needs sudo for apt + SecLists. Go tools install to ~/go/bin (add to PATH).
# =============================================================================
set -uo pipefail
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
run(){ if [ "$DRY" = 1 ]; then printf '   [dry] %s\n' "$*"; else eval "$@"; fi; }
c(){ printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok(){ printf '   \033[1;32m✓\033[0m %s\n' "$*"; }
warn(){ printf '   \033[1;33m! %s\033[0m\n' "$*"; }
have(){ command -v "$1" >/dev/null 2>&1; }
SUDO=""; [ "$(id -u)" -ne 0 ] && have sudo && SUDO="sudo"

c "apt packages (jq, nmap, sqlmap, java, chromium, pipx, golang)"
if have apt-get; then
  run "$SUDO apt-get update -y"
  run "$SUDO apt-get install -y jq nmap sqlmap default-jre chromium pipx golang-go git curl"
  ok "apt packages requested"
else warn "no apt-get — install jq/nmap/sqlmap/java/chromium/go/pipx via your package manager."; fi

c "SecLists  ->  /usr/share/seclists  (1.9G; agents reference this path)"
if [ -d /usr/share/seclists ]; then ok "already present"
elif have apt-get; then
  run "$SUDO apt-get install -y seclists" || { warn "apt seclists failed — cloning"; run "$SUDO git clone --depth 1 https://github.com/danielmiessler/SecLists.git /usr/share/seclists"; }
else run "$SUDO git clone --depth 1 https://github.com/danielmiessler/SecLists.git /usr/share/seclists"; fi

c "Go recon tools  ->  ~/go/bin"
export PATH="$HOME/go/bin:$PATH"
if have go; then
  declare -A GO=(
    [httpx]="github.com/projectdiscovery/httpx/cmd/httpx@latest"
    [katana]="github.com/projectdiscovery/katana/cmd/katana@latest"
    [dnsx]="github.com/projectdiscovery/dnsx/cmd/dnsx@latest"
    [naabu]="github.com/projectdiscovery/naabu/v2/cmd/naabu@latest"
    [subfinder]="github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest"
    [nuclei]="github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest"
    [ffuf]="github.com/ffuf/ffuf/v2@latest"
    [gau]="github.com/lc/gau/v2/cmd/gau@latest"
    [anew]="github.com/tomnomnom/anew@latest"
    [unfurl]="github.com/tomnomnom/unfurl@latest"
    [qsreplace]="github.com/tomnomnom/qsreplace@latest"
    [gf]="github.com/tomnomnom/gf@latest"
    [assetfinder]="github.com/tomnomnom/assetfinder@latest"
    [waybackurls]="github.com/tomnomnom/waybackurls@latest"
    [gowitness]="github.com/sensepost/gowitness@latest"
    [asnmap]="github.com/projectdiscovery/asnmap/cmd/asnmap@latest"
    [mapcidr]="github.com/projectdiscovery/mapcidr/cmd/mapcidr@latest"
    [notify]="github.com/projectdiscovery/notify/cmd/notify@latest"
    [github-subdomains]="github.com/gwen001/github-subdomains@latest"
    [cero]="github.com/glebarez/cero@latest"
    [gungnir]="github.com/g0ldencybersec/gungnir/cmd/gungnir@latest"
    [smap]="github.com/s0md3v/smap/cmd/smap@latest"
    [puredns]="github.com/d3mondev/puredns/v2@latest"
    [jaeles]="github.com/jaeles-project/jaeles@latest"
  )
  for t in "${!GO[@]}"; do have "$t" && { ok "$t present"; continue; }; run "go install ${GO[$t]}" && ok "installed $t"; done
  case ":$PATH:" in *":$HOME/go/bin:"*) :;; *) warn "add ~/go/bin to PATH: export PATH=\"\$HOME/go/bin:\$PATH\"";; esac
else warn "go not found — skipping projectdiscovery/tomnomnom tools."; fi

c "pipx tools (git-dumper, trufflehog, arjun)"
if have pipx; then
  run "pipx install git-dumper" && ok "git-dumper"
  have arjun || run "pipx install arjun" && ok "arjun (param discovery)"
else warn "pipx missing — pip install git-dumper arjun manually."; fi
have trufflehog || { c "trufflehog (verified secret scanning)"; run "curl -sSfL https://raw.githubusercontent.com/trufflesecurity/trufflehog/main/scripts/install.sh | sh -s -- -b \"$HOME/go/bin\"" && ok "trufflehog"; }
have massdns || { c "massdns (puredns brute backend)"; run "git clone --depth 1 https://github.com/blechschmidt/massdns /tmp/massdns && make -C /tmp/massdns && cp /tmp/massdns/bin/massdns \"$HOME/go/bin/\"" && ok "massdns"; }

c "jsleak (JS secret + endpoint sweep -> ~/.local/bin)"
if have jsleak; then ok "already present"
elif have go; then
  run "git clone --depth 1 https://github.com/byt3hx/jsleak /tmp/jsleak && (cd /tmp/jsleak && go mod init jsleak >/dev/null 2>&1; go mod tidy >/dev/null 2>&1; go build -o \"$HOME/.local/bin/jsleak\" .)" && ok "jsleak"
else warn "go not found — jsleak skipped."; fi
# jsleak pattern DB (secrets-patterns-db, trufflehog-v3 dataset; 784 patterns)
if [ -s "$HOME/.pi-hunt-rag/data/jsleak/trufflehog-v3.yml" ]; then ok "jsleak patterns DB present"
else run "mkdir -p \"$HOME/.pi-hunt-rag/data/jsleak\" && curl -sL -o \"$HOME/.pi-hunt-rag/data/jsleak/trufflehog-v3.yml\" https://raw.githubusercontent.com/mazen160/secrets-patterns-db/refs/heads/master/datasets/trufflehog-v3.yml" && ok "jsleak patterns DB fetched"; fi

c "npm tools (retire.js)"
have retire || { have npm && run "npm install -g retire" && ok "retire.js"; }
have jaeles && { have jaeles && run "jaeles config init" >/dev/null 2>&1; }

c "gf parameter-analysis patterns (Haddix HUNT/sus-params -> ~/.gf)"
# gf binary installs via the GO array above; it needs pattern files to be useful.
if have gf; then
  run "mkdir -p '$HOME/.gf'"
  # tomnomnom's stock patterns + 1ndianl33t/Gf-Patterns (idor/sqli/xss/ssrf/lfi/rce/ssti/redirect/...)
  for src in "tomnomnom/gf/master/examples" "1ndianl33t/Gf-Patterns/master"; do
    tmpd="$(mktemp -d)"; run "git clone --depth 1 'https://github.com/${src%%/*}/$(echo "$src"|cut -d/ -f2)' '$tmpd' 2>/dev/null"
    [ -d "$tmpd" ] && { find "$tmpd" -name '*.json' -exec cp -n {} "$HOME/.gf/" \; 2>/dev/null; rm -rf "$tmpd"; }
  done
  ok "gf patterns -> ~/.gf ($(ls "$HOME/.gf/"*.json 2>/dev/null | wc -l) files)"
else warn "gf not installed — parameter analysis (gf idor/sqli/xss/...) unavailable."; fi

c "notes"
warn "protonvpn-cli: add Proton's official repo (distro-specific) — see protonvpn.com/support/linux-vpn-tool."
warn "naabu needs libpcap-dev; nuclei templates: run 'nuclei -update-templates' once."
echo
echo "Done${DRY:+ (dry-run)}. These are runtime tools only — pi-hunt's own setup comes from ./install.sh."
