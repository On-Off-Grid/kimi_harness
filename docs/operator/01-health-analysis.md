# pi-hunt — Historical Kiro Health Analysis & Diagnostics

> [!WARNING]
> Historical Kiro-era snapshot. The active runtime uses Kimi Code:
> `kimi-coding/k3` flagship, `kimi-coding/k3.1-pro` elite,
> `google-direct/gemini-3.5-flash-lite` mechanical tier, and
> `kimi-coding/k3-256k` for compaction. Gateway health commands below are
> reference material, not the current startup procedure.

_Last verified: 2026-07-07 on this box (12 cores / 15 GB RAM, ~8 GB free)._

> Paths below use `$PIHUNT_HOME` for the repo checkout. Set it to wherever you
> cloned pi-hunt, e.g. `export PIHUNT_HOME=~/pi-hunt` (this box used
> `~/Desktop/Desktop/bbp/_BU/pi-hunt`).

This file is the reference for **checking whether pi-hunt is healthy** and for the
**known silent-failure modes** that degrade hunts without throwing an error. Run the
commands here whenever a session starts cold, after a reboot, or when recon output
"looks thin."

---

## 1. What "healthy" looks like (baseline snapshot)

| Component | Healthy state | How to check |
|---|---|---|
| **Provider config** | `defaultProvider: kimi-coding`, default `k3`; mechanical `google-direct/gemini-3.5-flash-lite` | inspect `~/.pi/agent/{models,settings}.json` |
| **Launchers** | `pi-hunt`, `pi-4.8`, `pi-tier`; `pi-kiro` is legacy-only | `ls $PIHUNT_HOME/bin/` |
| **Agents** | 26 installed (`~/.pi/agent/agents/*.md`) | `ls ~/.pi/agent/agents/ | wc -l` |
| **Model tiering** | 8 mechanical → `google-direct/gemini-3.5-flash-lite`, 16 flagship → `kimi-coding/k3`, 2 elite → `kimi-coding/k3.1-pro` | `pi-tier status` |
| **Skills** | 17 skills, gate green | `node bin/prompt-gate.mjs --repo` |
| **MCP servers** | 7 wired: browser-live, burp, memory, github, medium, pihunt-rag, gmail | `cat ~/.pi/agent/mcp.json` / `/mcp` inside pi |
| **RAG** | `total` climbs; `by_source` has findings + techniques + memory + recon | `pihunt-rag stats` |
| **Recon toolchain** | 27/27 tools resolve under a **clean** PATH | see §3 test |
| **Recon registry** | active programs listed (not "(none)") | `pihunt-recon-reg list` |
| **Recon timer** | `pihunt-recon.timer` active, next-run scheduled | `systemctl --user list-timers | grep pihunt` |
| **Credentials** | `H1_API`, `INTIGRITI_APP` set | see §4 |

RAG baseline after the 2026-07 fixes: `findings 25 / memory 35 / techniques 23 / session 12 / model-notes 4 / recon 8+` (recon grows every run).

---

## 2. One-shot health sweep

Paste this whole block. It prints a pass/fail-ish snapshot with zero side effects.

```bash
PH=$PIHUNT_HOME
echo "== gateway =="; systemctl --user is-active kiro-gateway; curl -s -m3 http://127.0.0.1:8790/health
echo "== agents =="; ls ~/.pi/agent/agents/*.md 2>/dev/null | wc -l
echo "== tiering =="; make -C "$PH" status 2>/dev/null | tail -3
echo "== skills =="; ls ~/.pi/agent/skills/*/SKILL.md 2>/dev/null | wc -l
echo "== rag =="; pihunt-rag stats 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['total'],'total',d['by_source'])"
echo "== recon registry =="; pihunt-recon-reg list | tail -8
echo "== recon timer =="; systemctl --user list-timers 2>/dev/null | grep -i pihunt || echo "NO TIMER"
echo "== toolchain (clean PATH) =="; env -i PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" bash -c 'n=0;for t in subfinder httpx nuclei katana dnsx naabu gau waybackurls dalfox qsreplace anew feroxbuster ffuf gowitness jaeles amass nmap retire assetfinder github-subdomains puredns asnmap mapcidr cero unfurl gf interactsh-client;do command -v $t>/dev/null&&n=$((n+1))||echo "MISSING $t";done;echo "$n present"'
echo "== creds =="; for v in H1_API INTIGRITI_APP; do [ -n "${!v}" ] && echo "$v set" || echo "$v UNSET"; done
```

---

## 3. Known silent-failure modes (the ones that cost bugs)

These are the defects that were live on this box and are now fixed. They are
documented here because **they fail silently** — recon "completes" but produces
near-nothing, and nothing errors out. If recon output ever looks thin again, check
these first.

### 3.1 `~/go/bin` not on the non-interactive PATH  ← FIXED 2026-07-07
- **Symptom:** `pihunt-recon` stages 1–9 print "missing tool, skipped"; subdomain
  enum / DNS / crawl / params all produce 0. No error.
- **Root cause:** the go-based recon arsenal (`subfinder, katana, dnsx, naabu, gau,
  dalfox, ...`) lives in `~/go/bin`, which is added to PATH only in `.bashrc`. pi and
  its subagents run **non-interactive** shells that never source `.bashrc`.
- **Fix applied:** symlinked all `~/go/bin/*` into `~/.local/bin` (already on PATH) +
  added `export PATH="$HOME/go/bin:$PATH"` to `~/.profile`. Installed missing `dalfox`.
- **Verify:** the `toolchain (clean PATH)` line in §2 must report **27 present**.

### 3.2 dnsx colour/timestamp parse zeroed `hosts_resolved.txt`  ← FIXED 2026-07-07
- **Symptom:** `stage 3: resolved hosts: 0` even though DNS resolves fine manually;
  everything downstream (httpx, crawl, params) gets empty input.
- **Root cause:** dnsx wrote ANSI-colour + `[HH:MM:SS]` prefixed lines; the parser
  `grep -oE "^[a-zA-Z0-9._-]+"` anchored at `^` and matched the junk, not the host.
- **Fix applied** (in `~/.local/bin/pihunt-recon`): added `-no-color` to the dnsx call
  and replaced the parse with an ANSI/timestamp-stripping `sed | awk '{print $1}'`.
- **Verify:** a fast recon shows non-zero `resolved hosts` (acme run: 957).

### 3.3 Stage-10 RAG ingest skipped (`PIHUNT_RAG_REPO` unset)  ← FIXED 2026-07-07
- **Symptom:** `stage 10: RAG recon ingester not found (set PIHUNT_RAG_REPO)`; recon
  never becomes searchable, so the coordinator's "recall prior recon" step is blind.
- **Root cause:** the ingester repo is at `$PIHUNT_HOME/rag`,
  which isn't in the engine's default search list, and `PIHUNT_RAG_REPO` was unset.
  The **systemd timer does not source your shell profile**, so a profile export alone
  would not fix timer-driven runs.
- **Fix applied:** `PIHUNT_RAG_REPO` set in `~/.config/pihunt/recon.env` (shell) **and**
  as an inline `Environment=` line in the `pihunt-recon.service` systemd unit (timer).
- **Verify:** stage 10 prints `{'program': '<p>', 'recon_chunks': N}` and
  `pihunt-rag search --source recon` returns host tables.

### 3.4 systemd `EnvironmentFile` gotcha (for future secret wiring)
`EnvironmentFile=` does **not** honour `export ` prefixes or `$HOME` expansion. Keep
**two** flavours of any secret/env file:
- `*.env` — with `export ` and `$HOME`, for shell `source` (`.bashrc`/`.profile`).
- `*.systemd.env` — bare `KEY=value` with absolute paths, for `EnvironmentFile=`.

---

## 4. Credentials & where they live

| Var | Purpose | Stored in | Sourced by |
|---|---|---|---|
| `H1_API` / `H1_USER` | HackerOne scope API (Basic auth) | `~/.pi/secrets/h1_api.env`, `~/.config/pihunt/h1.env` | `.bashrc` |
| `INTIGRITI_APP` / `INTIGRITI_TOKEN` | Intigriti researcher API (Bearer) | `~/.pi/secrets/intigriti.env`, `~/.config/pihunt/intigriti.env`; systemd-clean copy at `~/.config/pihunt/intigriti.systemd.env` | `.bashrc`, `.profile`, systemd unit |
| `PIHUNT_RAG_REPO` | RAG ingester path for recon stage 10 | `~/.config/pihunt/recon.env` (+ `.systemd.env`) | `.bashrc`, `.profile`, systemd unit |
| `PI_SUBAGENT_*` | Subagent runner tuning (see guide) | `~/.pi/secrets/pihunt-tuning.env` | `.bashrc`, `.profile` |

All secret files are `chmod 600`. Validate a token live before trusting it:
```bash
# Intigriti (expect HTTP 200 + program count)
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $INTIGRITI_APP" \
  "https://api.intigriti.com/external/researcher/v1/programs?limit=1"
```

---

## 5. Optional / minor (not blocking)

- `XACTIONS_SESSION_COOKIE` unset → X MCP research is public-only. Set it only if you
  need authenticated X OSINT.
- Continuous-learning `instincts.jsonl` has 1 malformed/empty line (0 promoted). The
  `INSTINCT:` / `DEADEND:` / `CHAIN:` feedback loop isn't yet producing durable memory.
  Watch after the next full hunt; if it stays flat, the tagging convention isn't being
  followed by the agents. Non-blocking.
- Recon output root is `~/hunts/<program>/structured-recon` (`PIHUNT_RECON_ROOT`
  default `~/hunts`), **not** `reports/`. Finding folders still go under `reports/`.

---

## 6. When to re-run this

- **Cold session / after reboot:** run §2.
- **Recon looks thin (few live hosts, empty params):** check §3.1–3.3 in order.
- **A specialist says "tool not found":** run the §2 toolchain line under a clean PATH.
- **New platform/program added:** validate its token (§4) before the first hunt.
