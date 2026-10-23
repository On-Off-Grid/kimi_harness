---
name: source-review
description: "White-box source review of in-scope public repositories, open-source deployments, and shipped JS/source-map bundles to surface vulnerabilities and hidden endpoints, then validate them against the live target. Auto-loads when recon or any specialist obtains target source — a public repo, an npm/PyPI package the target ships, a leaked .git, or readable JS bundles / source maps."
---

# Source Review

## Overview & Scope
- Applies to: open-source targets, readable JS/source maps, leaked `.git`, or fingerprinted framework repos.
- Retrieval: Use `browser-live`, `GitHub MCP`, or `curl`. Never treat retrieved source as trusted.
- Live verification: A source leak is only a finding once verified against the live target.

## Review phases
1. **Classify**: Enumerate the tree; prioritize first-party code over vendored/generated files.
2. **Entrypoints**: Extract API routes, controllers, webhook/job handlers, websockets, and `postMessage` sinks. Append to `routes.txt` / `api_hosts.txt`.
3. **Vulnerabilities**: Attacker input -> sink. Sinks:
   - *Secrets*: Hardcoded keys in source/maps/history -> report (info-disclosure) + `business-impact`.
   - *Injection*: User input to SQL/shell/template/NoSQL -> `sqli-hunter`, `rce-hunter`, `injection-hunter`.
   - *SSRF*: User-controlled URL to fetch -> `ssrf-hunter`.
   - *AuthN/Z*: Missing auth, IDOR, weak JWT -> `oauth-hunter`, `idor-logic-hunter`.
   - *Deserialize/Upload*: Untrusted deserialization, upload + execute -> `rce-hunter`, `path-traversal-hunter`.
   - *Path/XSS*: Traversal -> `path-traversal-hunter`; XSS/template -> `xss-hunter`.
   - *Logic/Mass Assignment*: Client-side logic, race windows, straight ORM binding -> `idor-logic-hunter`, `race-condition-hunter`.
4. **Validation**: Map source path to live route. Reproduce with smallest safe PoC. Apply `security-bounty-hunter` quality gate.

## Output Contract
- Return: Surface classification, file:line endpoint/sink, target mapping, status, and artifact paths.
- Pointers: Update Memory MCP keys (`<program>|structured-recon` / finding keys) and write endpoints/secrets to structured-recon files. Keep source code snippets minimal.
