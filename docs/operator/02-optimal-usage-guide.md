# pi-hunt — Optimal Usage Guide

_How to run a hunt, steer it mid-flight, and drive each phase with the right prompts
and commands. Grounded in the live install on this box (2026-10-25)._

pi-hunt is a **bug-bounty coordinator** running on Kimi Code `kimi-coding/k3` at max
reasoning, with 26 specialist subagents (8 mechanical on
`google-direct/gemini-3.1-flash-lite`), 7 MCP servers, a RAG knowledge base, and a
continuous recon engine. You steer it in natural language; it delegates, chains,
validates, and writes report artifacts to disk. It never submits to a platform — it
stops at local report creation.

---

## 0. TL;DR cheat sheet

```bash
# start a hunt (interactive)
pi-hunt
> Hunt acme in Intigriti for CRITICAL

# one-shot headless
pi-hunt -p "Hunt finbank in Intigriti for HIGH"

# mid-hunt steering (just type in the TUI):
#   "Focus only on *.hotelco.io and the SSRF surface."
#   "Ensemble the OAuth login flow, 6 passes."
#   "Swarm every API endpoint in js_assets.txt for IDOR + BOLA."
#   "Stop that branch — it's negative. Move to the payment flow."
#   "Triage case_xxxx now and write the report folder."
```

Stop markers the coordinator emits: `[[HUNT_COMPLETE]]` (done/exhausted) or
`[[HUNT_BLOCKED: reason]]` (needs you — e.g. a CAPTCHA to solve).

---

## 1. Launchers (what each does)

| Command | Purpose |
|---|---|
| `pi-hunt` | Coordinator brain (build.md + workflow + pi adapter) on k3, all subagents + MCP. This is the hunt entrypoint. |
| `pi-4.8` | Flagship toggle: `k3` ↔ `k3.1-pro`; does not touch the mechanical tier. |
| `pi-kiro` | Legacy Kiro wrapper; not part of the default runtime path. |
| `pi-tier on\|off\|status` | Cost tiering: mechanical agents → `google-direct/gemini-3.1-flash-lite`, flagship stays on `kimi-coding/k3`, elite on `k3.1-pro`. Affects **new** subagent spawns. |

`make -C pi-hunt status` shows per-agent models + RAG stats. `make -C pi-hunt help`
lists install/rag targets.

---

## 2. The hunt trigger grammar

`Hunt <PROGRAM> [in HackerOne|in Intigriti] [for <FLOOR>]`

- **Platform:** `in HackerOne` or `in Intigriti`. Default is Intigriti if omitted.
  The handle is passed verbatim to every subagent (handle-lock, anti-drift).
- **Severity floor:** `for CRITICAL`, `for HIGH`, or `for CRITICAL/EXCEPTIONAL`
  (EXCEPTIONAL = "critical or above"). With a floor set, the coordinator keeps
  hunting high-value branches until a finding **at/above** the floor is validated by
  `strict-triager`, or those branches are exhausted/blocked with evidence. It will
  **not** stop just because low/medium/invalid findings appeared.

Examples:
```
Hunt acme in Intigriti for CRITICAL
Hunt finbank in Intigriti for HIGH
Hunt crmco in HackerOne for CRITICAL/EXCEPTIONAL
```

---

## 3. The phases (and how to drive each)

A full hunt runs roughly: **scope → recon → creative seeding → parallel/swarm
specialists → chaining → triage → report**. You can let it run end-to-end, or steer
each phase. Below: what happens, the prompt to nudge it, and the underlying command
if you want to run it yourself.

### Phase 1 — Scope load (always first)
- **What:** `h1-scope-loader` / `intigriti-scope-loader` pulls authoritative scope from
  the platform API. Every subagent re-confirms scope at its own start.
- **Steer:** `"Reload scope for acme from Intigriti before testing."` (This forces a
  live API reload, not a stale `scope.md` re-read.)
- **Manual:**
  ```bash
  curl -s -H "Authorization: Bearer $INTIGRITI_APP" \
    "https://api.intigriti.com/external/researcher/v1/programs?limit=500" | jq '.records[]|select(.handle=="acme-bounty")'
  ```

### Phase 2 — Recon (surface mapping)
- **What:** `recon` maps the funnel, params, XHR endpoints, JS, fingerprints; writes
  `~/hunts/<p>/structured-recon/*` + `manifest.md` and ingests into the RAG.
- **Steer:**
  - `"Run deep recon on hotelco.io and register it for continuous refresh."`
  - `"Pull current recon for acme from the RAG before mapping."`
- **Manual (continuous recon engine):**
  ```bash
  pihunt-recon <program> <domain[,domain2]> --fast     # or --deep
  pihunt-recon-reg add <program> <domains> [fast|deep]  # register on the 6h timer
  pihunt-recon-reg list | run <program> | rm <program>
  pihunt-rag search "<program> live hosts params" --source recon
  ```
  Output → `~/hunts/<program>/structured-recon/`. Registered programs refresh via
  `pihunt-recon.timer` and re-ingest to the RAG each run (diffs "NEW since last run").

### Phase 3 — Creative seeding (before spraying)
- **What:** `hypothesis-redteam` invents non-obvious angles (shared/overloaded tokens,
  tenancy assumptions, state-machine gaps, cross-flow trust seams) right after recon.
- **Steer:** `"Run hypothesis-redteam on the recon output and give me the top 3
  route-now hypotheses."`

### Phase 4 — Specialist testing (the fan-out)
Three delegation shapes. Pick by the situation:

| Shape | When | How to ask |
|---|---|---|
| **single/parallel** | a few independent leads on different endpoints | `"Test the cart API for BOLA and the login flow for OAuth issues in parallel."` |
| **ensemble** | one high-value surface, want max yield (auth/payment/admin/AI/org-invite) | `"Ensemble the OAuth login on login.acme.com, 6 passes, different angle each."` |
| **swarm** | exhaustive coverage of a big surface×class matrix | `"Swarm every endpoint in js_assets.txt: idor-logic + sqli + injection, one cell each."` |

- **Authz-differential is the default posture for API criticals (BOLA/BFLA/tenancy):**
  `"Provision the authz matrix — two users same tenant, two tenants, low vs admin —
  and run A→B / B→A / unauth on every object reference."` (`test-account-manager` builds
  the identity set; write it to `reports/<p>/structured-recon/authz-matrix.json`.)
- **Live N-day intel per fingerprint:**
  `"Recon says Spring Boot 3.x — run deep-research for criticals disclosed in the last
  90 days and hand the primitives to rce-hunter."`
- **Payloads/wordlists (one exact objective per call):**
  `"payload-researcher: give me an Akamai-aware SSRF payload family for a URL-fetch
  sink that accepts http(s); save to an artifact and return the path."`

### Phase 5 — Chaining (never skip)
- **What:** every low/info signal is appended to `reports/<p>/gadget-ledger.md`; after
  each wave, `security-analyzer` recomposes chains and `hypothesis-redteam` invents
  links it missed. A chain reaching Tier-1 impact **is** a Tier-1 finding.
- **Steer:** `"Hand the full gadget-ledger to security-analyzer and ask: do any N of
  these now chain to account takeover or SSRF-to-metadata?"`

### Phase 6 — Triage (candidates only)
- **What:** `strict-triager` re-runs each material claim (curl/browser/command), writes
  `response.md`, verdicts Valid / Needs-More-Evidence / Invalid. It does **not** block
  exploration — only gate final findings.
- **Steer:** `"Triage case_redacted01 — re-run the PoC, don't accept narrative."`

### Phase 7 — Report (local only)
- **What:** each retained finding gets `reports/<program>/<timestamp>-<slug>/` with
  `title.txt`, `description.md`, `weakness.txt`, `severity.txt`, `asset.txt`,
  `impact.md`, `response.md`, `files/`. `description.md` must be 100% self-contained
  and copy-paste reproducible (full auth + every exact curl + expected output + a
  negative control; no placeholders, no cross-references).
- **Steer:** `"Write the finding folder for case_redacted02 with a self-contained
  description.md and a negative control."`
- **Casefile commands (ledger, enforced state machine):**
  ```
  CaseList / CaseSearch / CaseGet          # review
  CaseAdd (hypothesis|investigating)       # never start at confirmed
  CaseUpdate                               # evidence/impact/status
  PromoteFinding <id> <poc_path>           # investigating→confirmed (runs PoC, exit 0)
  CaseReport <id>                          # confirmed→ (then set reported)
  CaseLink a b                             # build exploit chains
  ```

---

## 4. Steering mid-work (the high-leverage moves)

The coordinator runs autonomously and auto-continues on empty turns. You steer by
typing plain instructions any time. Highest-value interventions:

- **Refocus scope:** `"Ignore everything except *.hotelco.io. Drop the WP magazine branch."`
- **Force a mode:** `"That surface is high-value — ensemble it 8 passes instead of one."`
- **Kill a dead branch:** `"mobile-api-gateway BOLA is negative-swept. Stop and move to checkout."`
- **Escalate a low finding:** `"This open redirect is low alone — send it to security-analyzer to chain with the SSRF candidate."`
- **Disconfirm a wall (do this on every 429/403/"clean"):**
  `"You hit a 429 — prove it's rate-limiting vs a path-signature WAF. Try an encoded
  path and a rotated egress before concluding."` (A 429 or 403 or "not exploitable" is
  a hypothesis, not a conclusion — the reflexive-disconfirm gate is on by default, but
  reinforcing it verbally helps.)
- **Restart a lost subagent:** if a specialist returns empty/"No result", that's a
  delivery failure, not a clean surface — `"Re-run that specialist with a narrower
  objective; it got cut off."`
- **Checkpoint before a big context:** `"Checkpoint the current findings to reports/
  and memory before you start the swarm."`

### Browser / raw-HTTP discipline (tell it if it drifts)
- One snapshot → reuse UIDs → `evaluate_script`/network tools. After 1 snapshot + 1
  post-DOM-change snapshot + 1 fallback, change strategy.
- Use Burp (`burp_*`) for raw HTTP mutation/replay/diffing; browser-live for JS/stateful
  flows. `"Use raw HTTP for this, not the browser."`

---

## 5. Tuning knobs (this box: 12 cores / 15 GB)

Persisted in `~/.pi/secrets/pihunt-tuning.env` (sourced by `.bashrc`/`.profile`):

```bash
PI_SUBAGENT_MAX_CONCURRENCY=8     # simultaneous subagents (default 4)
PI_SUBAGENT_MAX_QUEUE=256         # swarm cells per call
PI_SUBAGENT_RAM_FLOOR_MB=1500     # pause new launches under this free RAM (anti-thrash)
PI_SUBAGENT_RAM_WAIT_MS=300000    # wait up to 5 min for RAM before proceeding
PI_SUBAGENT_DISCONFIRM=1          # reflexive disconfirmation gate ON
PI_SUBAGENT_MCP_PROFILES=1        # per-agent MCP allowlist ON (fits more subagents)
```
RAM math: with MCP profiles on, a web specialist ≈ 300–500 MB (no Burp JVM). 8
concurrent ≈ 3–4 GB, comfortable under ~8 GB free with the 1.5 GB floor as a brake.
Don't exceed 8–10 without watching `free -m`.

Raise concurrency for a big swarm wave, lower it if you're also running heavy recon:
```bash
PI_SUBAGENT_MAX_CONCURRENCY=10 pi-hunt "Hunt petmarket for HIGH"
```

---

## 6. RAG — recall before you test (avoid re-work)

```bash
pihunt-rag search "<vuln class> technique" --source techniques
pihunt-rag search "<program>" --source findings          # your own prior work
pihunt-rag search "<program> live hosts" --source recon   # current recon
pihunt-rag record "<title>" "<reusable heuristic>"        # persist a technique
pihunt-rag ingest [findings|recon|memory|techniques]      # re-index a source
pihunt-rag stats
```
The coordinator does this at startup automatically; run it yourself when you want to
check whether a surface was already swept.

---

## 7. The single highest-leverage habit

Treat every subagent as if it will be killed mid-sentence. Its entire result is its
**final plain-text message** — if it ends on a tool call or runs out of turns, you get
`No result` and its work is lost. So the coordinator (and you, when steering) should
always: **checkpoint to `reports/` continuously, summarize early, restart empties.**
Throughput is capped far more by lost-work delivery failures than by model quality.
