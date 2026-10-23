# Continuous Recon + Session Memory

Two capabilities that turn pi-hunt from "recon once at the start" into a system
with **always-fresh recon** and **cross-session continuity**.

## 1. Continuous recon engine (`pihunt-recon`)

A deep recon pipeline that re-runs on a schedule and feeds the RAG, so the model
always pulls *current* attack surface instead of stale first-run data.

### Pipeline stages
1. **Subdomain enum** — subfinder, amass (passive, deep mode), assetfinder, findomain, crt.sh
2. **DNS brute** — puredns+massdns (or dnsx) with SecLists DNS wordlists + fresh resolvers
3. **Resolve + takeover** — dnsx A/CNAME; flags dangling-CNAME takeover candidates
4. **Port scan** (deep) — naabu top-1000 (masscan/nmap fallbacks)
5. **HTTP probe** — httpx (status, title, tech, server, CDN, TLS) → `tech-stack.md`
6. **URL collection** — katana crawl + gau + waybackurls
7. **Parameter discovery** — arjun on live hosts + param mining from URLs/JS
8. **Content fuzzing** (deep) — ffuf dir discovery on a capped set of live hosts
9. **JS/secret mining** — pull JS, grep AKIA/AIza/AppSync `da2-`/Firebase/Stripe/etc.
10. **RAG ingest** — everything indexed under `source=recon`, keyed by program

Each run **diffs against the previous run** (via `anew`): new subdomains/hosts surface
as `NEW_*` files and `recon-new` chunks ("NEW since last run").

### Usage
```bash
pihunt-recon <program> <domain[,domain2]>            # normal
pihunt-recon acme example.com,api.example.com --fast # passive + probe (quick)
pihunt-recon acme example.com --deep                 # + brute + ports + fuzz (heavy)
```
Artifacts land in `~/hunts/<program>/structured-recon/` (override with `PIHUNT_RECON_ROOT`):
`subdomains_all.txt`, `subdomains_live.txt`, `NEW_*`, `hosts_resolved.txt`,
`takeover_candidates.txt`, `urls.txt`, `params.txt`, `content_discovery.txt`,
`js_assets.txt`, `js_secrets.txt`, `tech-stack.md`, `manifest.md`, `run_history.log`.

### Make it continuous (periodic)
```bash
pihunt-recon-reg add acme example.com,api.example.com   # register a program
pihunt-recon-reg list                                    # show registry
pihunt-recon-reg run acme                                # run it once now
pihunt-recon-reg rm acme                                 # unregister
```
The **systemd timer** `pihunt-recon.timer` runs `pihunt-recon-scheduler --fast` every
6h (installed + enabled by `install.sh`), refreshing every registered program and
re-ingesting into the RAG. Tunables: `RECON_SUBS_CAP` (5000), `RECON_RESOLVE_CAP` (3000),
`RECON_FFUF_HOST_CAP` (8). Each stage is internally timeout-bounded so a slow target
can't wedge the timer.

### How the model uses it
```bash
pihunt-rag search "live hosts and tech for acme" --program acme --source recon
pihunt-rag search "new subdomains since last run" --program acme --source recon
pihunt-rag search "discovered parameters to test for idor/ssrf" --program acme --source recon
```
The coordinator prompt now pulls `--source recon` at hunt start.

## 2. Session memory (cross-session continuity)

The `session-memory` pi extension makes your work **survive across sessions**:

- **Capture:** on every compaction (`/compact` or auto) and on session shutdown/switch,
  it persists pi's structured summary into the RAG (`source=session`, keyed by the
  working directory). Keeps the newest ~12 summaries per project.
- **Restore:** when you open a **new** session in the same directory, it semantically
  pulls the most recent prior summaries and injects a "here's what we did last time /
  how to continue" note — so a fresh session resumes the thread.
- **On demand:** run `/resume-context`, or
  `pihunt-rag search "what was I doing here" --source session`.

Toggle with `PIHUNT_SESSION_MEMORY=0`; restore depth `PIHUNT_SESSION_RESTORE_K` (default 3).

### Why RAG (not just pi's built-in compaction)
pi compaction keeps context *within* one session. This persists the summary into the
same vector store the model already searches, so it's queryable from any future
session, any agent, and alongside recon/findings/techniques.

## Files
- `recon/recon-engine.sh` → `~/.local/bin/pihunt-recon`
- `recon/recon-scheduler.sh` → `~/.local/bin/pihunt-recon-scheduler`
- `recon/recon-reg.sh` → `~/.local/bin/pihunt-recon-reg`
- `rag/pihunt_rag/recon_ingest.py` (recon → RAG)
- `rag/pihunt_rag/cli.py` `session-add` (session → RAG)
- `pi-agent/extensions/session-memory/` (capture/restore extension)
- `systemd/pihunt-recon.{service,timer}` (6h cadence)

## Haddix methodology integration

The engine + agents implement Jason Haddix's recon + app-analysis methodology
("Recon Like an Adversary" + "TBHM: Application Analysis"):

**Wide-scope (engine Stage 0–1):** ASN/IP-space first (`asnmap` + `whois.cymru`
fallback — skips IP scanning when the apex is CDN-fronted), cloud-cert SAN harvest
(`mapcidr`+`cero`), naabu→nmap service enum (SMAP/Shodan passive option),
many-source subdomains incl. `github-subdomains` (~28% more), real-time CT-log
monitoring (`pihunt-ct-monitor` = gungnir+notify).

**App analysis (recon agent + recon-checklist skill):** 6-layer threat model,
tech profiling, the 5/6 strategic questions (data-passing, user identifiers,
multi-tenancy/roles, crown jewels, framework defenses), content-type splitting
(multipart→LFI/RCE, XML→XXE, JSON→BOLA), visual heat-mapping (gowitness/eyewitness),
and parameter prioritization (`gf` + interesting/sus params).

## Wordlist curator (`wordlist-curator` agent + `pihunt-wordlist`)

A dedicated agent whose only job is assembling the RIGHT wordlists for the target's
fingerprinted stack and indexing them into the RAG (`source=wordlist`):

```bash
pihunt-wordlist index-seclists                 # baseline the high-value SecLists (once)
pihunt-wordlist map iis                         # local lists matching a tech
pihunt-wordlist github assetnote/wordlists web  # clone + index a repo's lists
pihunt-wordlist fetch <assetnote-cdn-url> --tags aspx --use "IIS dir discovery"
pihunt-wordlist merge acme-api api-endpoints.txt objects.txt   # dedupe-merge + index
pihunt-rag search "iis aspx content discovery wordlist" --source wordlist   # the model pulls
```
It maps lists to the discovered tech (IIS/ASP.NET, PHP/WP/Laravel, Java/Tomcat/Spring,
Node, API/GraphQL, params/IDOR/SSRF, subdomains, LFI) so fuzzing uses a tech-matched
list, not a generic one — then ffuf/feroxbuster (via cmd-optimizer or explicit `-w`)
run the right list.

## Port scanning (masscan) + CVE/misconfig deep-dive

**masscan (engine Stage 4, --deep):** extracts resolved A-record IPs and runs a
`sudo masscan` SYN sweep across a wide high-value port set (web, db, cache, admin,
k8s, message queues), then `nmap -sV` ONLY on the ip:port pairs masscan flags
(intrusive scan only where a port is actually open). Falls back to naabu→nmap, then
smap/Shodan passive. Tunables: `RECON_MASSCAN_PORTS`, `RECON_MASSCAN_RATE`. Open
non-80/443 services are written to `nmap_services.txt` and fed to the CVE agent.

**`cve-misconfig-hunter` agent + `pihunt-vulnscan`:** deep CVE + misconfiguration
research consolidating gofingerprint/Sn1per/Intrigue/Vulners-style coverage:
```bash
pihunt-vulnscan <program> <url|host|file> [--deep] [--tech "Spring,WordPress"]
```
httpx fingerprint → **nuclei** (cve, misconfig, exposure, default-login, takeover,
tech) → **jaeles** (j3ssi3jjj signatures) → **retire.js** (vulnerable client libs) →
**nikto** (server misconfig) → **wpscan** (if WordPress) → **searchsploit** (version →
public exploit). Results dedup'd, written to `structured-recon/vulnscan/`, and
RAG-ingested (`--source session`, key `vuln-<program>`).

The agent's job is the DEEP DIVE: every scanner hit is chased version → exact CVE →
public PoC → adapted in-scope non-destructive proof → negative control. It prioritizes
obscure/new subdomains (where un-dup'd CVEs live) and hands real exploitation leads
(RCE/SSRF/SQLi/auth) back to the class specialists. Coordinator routes here at step 5b
once recon fingerprints a stack.

## Content discovery (multi-tool, Stage 8)

`--deep` runs active content discovery with your choice of 5 tools (default
**feroxbuster** — recursive, auto-filters false 200s, Haddix's pick):
```bash
RECON_CD_TOOL=feroxbuster   # or ffuf | gobuster | dirsearch | wfuzz
RECON_CD_WORDLIST=/path      # override; else auto-pulls a tech-matched list from the RAG
```
It auto-selects a tech-matched wordlist by reading `tech-stack.md` and querying the
curator's RAG index (`--source wordlist`), falling back to raft-large-directories.
Findings → `content_discovery.txt`. The `cmd-optimizer` extension also auto-injects a
SecLists wordlist whenever any agent runs these 5 tools without `-w`.
