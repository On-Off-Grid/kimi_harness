---
name: security-bounty-hunter
description: "Payout-first triage filter that separates bounty-worthy, remotely reachable vulnerabilities from low-signal noise platforms reject. Auto-loads when any specialist or the strict-triager is deciding whether a candidate finding is worth keeping, scoring severity, or building the payout-optimized finding queue."
---

# Security Bounty Hunter

A decision filter, not a scanner. Use it to answer one question about any candidate: **"Does this actually pay, and is it in scope?"** — before a hunter spends more turns on it or the triager writes it up.

It complements the existing specialists: hunters find signals, `security-analyzer` chains them, `business-impact` prices them, and this skill is the go/no-go gate that keeps the queue focused on reports a program will actually accept and pay.

## When It Applies

- A specialist has a candidate and is deciding whether to keep digging or drop it.
- `strict-triager` is assigning a verdict and needs a reachability/scope sanity check.
- The coordinator is ordering the payout-optimized finding queue (autoflow step 8).
- You are about to create a `reports/<program>/...` finding folder and want to confirm it clears the bar.

## Core Bias

Favor **remotely reachable, attacker-controlled** paths that reach a meaningful sink. Discard anything that requires local access, victim self-sabotage, or that platforms routinely close as informative/out-of-scope.

## In-Scope Patterns (these pay)

| Pattern | CWE | Typical impact | pi-hunt owner |
| --- | --- | --- | --- |
| SSRF via user-controlled URL | CWE-918 | internal access, cloud metadata/cred theft | `ssrf-hunter` |
| Auth bypass in middleware / API guard | CWE-287 | unauthorized account or data access | `oauth-hunter`, `idor-logic-hunter` |
| Deserialization / upload-to-RCE | CWE-502 | code execution | `rce-hunter` |
| SQL injection on reachable endpoint | CWE-89 | data exfil, auth bypass | `sqli-hunter` |
| Command injection in a request handler | CWE-78 | code execution | `rce-hunter`, `injection-hunter` |
| Path traversal in file-serving path | CWE-22 | arbitrary file read/write | `path-traversal-hunter` |
| Stored / auto-triggered XSS | CWE-79 | session theft, admin compromise | `xss-hunter` |
| IDOR/BOLA with sensitive read/write | CWE-639 | cross-tenant data access | `idor-logic-hunter` |
| Request smuggling / desync with impact | CWE-444 | cache poison, auth bypass, queue poisoning | `request-smuggling-hunter` |
| Prompt injection / MCP tool abuse reaching data or actions | — | data theft, unauthorized tool actions | `llm-hunter` |

When a candidate matches one of these AND clears the Quality Gate below, it is a keep — route it to the owner (or to `strict-triager` if already evidenced).

## Drop These (low-signal / usually out of scope)

Unless the specific program rules say otherwise:

- Local-only `pickle.loads` / `torch.load` / `eval()` / `exec()` with no remote path.
- `shell=True` on fully hardcoded commands.
- Missing security headers (CSP, HSTS, X-Frame-Options) as a standalone finding.
- Generic "no rate limiting" with no concrete exploit impact.
- Self-XSS that needs the victim to paste payload into their own console.
- CORS reflection with no sensitive authenticated data behind it.
- Verbose errors / version banners with nothing exploitable attached.
- Findings only in demo, example, fixture, test, or vendored code.
- CI/CD or repo issues that are not part of the target program scope.

These belong in a holding note, not a report — summarize as a count, don't spend turns on them.

## Workflow (fits the autoflow)

1. **Scope first.** Confirm the asset is in the platform-confirmed in-scope list (autoflow reloads scope per run). Read program rules / `SECURITY.md` / exclusions. If not clearly in scope, stop and return the blocker.
2. **Find the real entrypoint.** HTTP handler, upload, webhook, background job, parser, or integration endpoint — not an internal helper.
3. **Prove attacker control reaches the sink.** Trace user input end to end. No proven path = not a finding yet.
4. **Confirm exploitability** with the smallest safe PoC (no destructive tokens — see DESTRUCTIVE PAYLOAD SAFETY in `burp-scan`). Capture a deterministic differential or decisive evidence.
5. **Check duplicates** against prior work: `rag_search` over `findings`/memory for this program before drafting.
6. **Keep or drop.** Keep → route to owner or `strict-triager` and create the finding folder. Drop → one-line holding note with the reason.

## Quality Gate (all must hold before keep)

- [ ] Asset is in the platform-confirmed scope for this program.
- [ ] The code path / endpoint is reachable from a real user or network boundary.
- [ ] The input is genuinely attacker-controlled.
- [ ] The sink is meaningful and exploitable (not theoretical).
- [ ] A minimal PoC works and is captured as evidence.
- [ ] Not a duplicate of a known advisory/CVE/prior finding (`rag_search` checked).

A candidate that fails any box is `needs-more-evidence` or a drop — never a `Valid` report.

## Output Contract

- **Keep:** state weakness class + CWE, the in-scope asset, the reachability proof, owner specialist (or "ready for strict-triager"), and the artifact path. Then create `reports/<program>/<timestamp>-<slug>/` with the required field files (`title.txt`, `description.md`, `weakness.txt`, `severity.txt`, `asset.txt`, `impact.md`, `response.md`, `files/`).
- **Drop:** one line — pattern, why it fails the gate, which holding bucket.
- Refresh the per-finding Memory MCP key (`<program>|<asset>|<weakness>|<auth-state>|<surface>`) with status and next step. Record any reusable keep/drop heuristic via `rag_record_technique`.
