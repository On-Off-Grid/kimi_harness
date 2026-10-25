---
name: wordlist-sourcing
description: "Reference for wordlist-curator: source priority (local SecLists, GitHub, assetnote CDN) and the tech/surface → list mapping. Load before choosing or merging lists."
---

# Wordlist sourcing & tech mapping

## Source priority

1. **LOCAL first** — SecLists `/usr/share/seclists`, `/usr/share/wordlists`, `~/wordlists`, kiterunner. Index with `pihunt-wordlist map <tech>`, then `local <path> --tags … --use …`.
2. **GitHub** — `assetnote/wordlists`, `danielmiessler/SecLists`, `Bo0oM/fuzz.txt`, `six2dez/OneListForAll`, `swisskyrepo/PayloadsAllTheThings`, `chrislockard/api_wordlist`; also search `<framework> wordlist`.
3. **assetnote CDN** — `fetch` the exact tech list (aspx / swagger / api-endpoints) when local+GitHub lack it.

Always tag `--tags <tech,surface>` and `--use <content|params|api|subdomains|vhosts|traversal|auth>`.

## Tech → list mapping

| Stack / surface | Lists to prefer |
|---|---|
| IIS / ASP.NET | aspx, asp, IIS shortname, windows web-root |
| PHP / WordPress / Laravel | wp/laravel routes, CommonBackdoors-PHP, .env/config |
| Java / Tomcat / Spring | tomcat-manager, actuator, struts |
| Node / Express | js endpoint lists |
| API / GraphQL | api-endpoints, graphql, swagger, assetnote routes |
| params / IDOR / SSRF | burp-parameter-names, assetnote parameters (tag `params,idor,ssrf`) |
| subdomains / vhosts | subdomains-top1million, dns-Jhaddix, bitquark |
| traversal / LFI | LFI-Jhaddix |

Rules: focused beats giant; overlapping lists → `merge` into one curated `<program>-<surface>.txt`; keep provenance tags on everything.

## Guardrails

Never index multi-hundred-MB lists wholesale. rockyou-scale password lists must be tagged clearly and are never auto-pulled. Only index — never run lists against targets. Well-known hosts only (SecLists, assetnote, established GitHub repos).
