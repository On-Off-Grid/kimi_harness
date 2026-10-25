---
name: recon-arsenal
description: "Exact commands, tool flags, and multi-source enumeration recipes for recon (subdomain/endpoint/DNS/JS sources, recox one-liners, merge rules). Load when executing recon phases, not for planning."
---

## Subdomain enumeration (7 sources via recox or direct)
```bash
# amass passive+active
amass enum -passive -d <domain> -o /tmp/amass.txt
subfinder -d <domain> -all -silent | anew /tmp/subs.txt
# certificate transparency
curl -s "https://crt.sh/?q=%.<domain>&output=json" | jq -r '.[].name_value' | sed 's/\*\.//g' | sort -u | anew /tmp/subs.txt
# ctftld, alienvault, rapiddns, hddns (recox-style)
curl -s "https://otx.alienvault.com/api/v1/indicators/domain/<domain>/passive_dns" | jq -r '.passive_dns[].hostname' | anew /tmp/subs.txt
curl -s "https://rapiddns.io/subdomain/<domain>?full=1" | grep -oE '[a-z0-9.-]+\.<domain>' | sort -u | anew /tmp/subs.txt
curl -s "https://wayback.querytool.sublime.app/" ; curl -s "http://web.archive.org/cdx/search/cdx?url=*.<domain>/*&output=text&fl=original&collapse=urlkey" | anew /tmp/urls.txt
# GitHub org code search (via GitHub MCP): subdomains in code — search_code "domain:<domain>" and "org:<org>"
```
Merge: `cat /tmp/subs.txt | sort -u | anew subdomains_all.txt`; resolve: `dnsx -l subdomains_all.txt -a -silent | anew hosts_resolved.txt`; alive: `httpx -l hosts_resolved.txt -status-code -title -tech-detect -location -o subdomains_live.txt`.

## Endpoint enumeration (4 sources)
1. Wayback/GAU: `gau <domain> --threads 10 | anew /tmp/urls_all.txt`
2. katana crawl of live hosts: `katana -l subdomains_live.txt -jc -kf -d 3 -timeout 10 -silent | anew routes.txt`
3. JS asset mining: download `js_assets.txt`, `grep -hoE '(["'"'"'`])\/[a-zA-Z0-9_/.\-]{3,}\1' *.js | tr -d '"'"'"'`' | sort -u` → routes/params/API hosts; extract secrets with jsleak/trufflehog (`RECON_JSLEAK_*` knobs on pihunt-recon).
4. OpenAPI/GraphQL introspection where public: `/openapi.json`, `/swagger.json`, POST `{graphql}` `{"query":"{__schema{types{name}}}"}`.
Dedupe: `sort -u routes.txt | anew -q routes.txt`; params: extract `?a=b` keys → `params.txt`; API hosts: hosts under `/api|/v[0-9]` paths → `api_hosts.txt`.

## DNS/host extra
`assetfinder --subs-only <domain>`; `findomain -t <domain> -q`; `chaos -d <domain> -silent` (API key present); vhost sweep only with `critical-endpoints` + curated vhost list via @wordlist-curator.

## Fingerprint one-liners
- `httpx -tool -server -title -ip -cdn -sc -location -web-server -tech-detect` on live set.
- Framework deep: fetch `/` + `/robots.txt` + `/favicon.ico` hash (`fv_ifile`/`cmsdetector` if installed); GitHub MCP lookup framework→known-CVE conventions.
- OAuth: crawl for `&client_id=`, `redirect_uri`, `/.well-known/openid-configuration`, `oauth/|sso|saml|login/callback` in routes → `oauth_endpoints.txt`.

## Merge rules
`anew` everywhere (never blind-append); keep `*_all` vs `*_live` split; never overwrite a producer's file without re-reading it; non-empty check before parsing any artifact.
