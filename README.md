<div align="center">

# 🎯 pi-hunt

### Autonomous bug-bounty hunting harness for the [pi](https://pi.dev) coding agent

*A coordinator + 26 specialist sub-agents, Kimi Code subscription models, 7 local MCP servers, a vectorized knowledge base with nightly recon, and cost-tiered model routing — wired together for end-to-end, evidence-first vulnerability research.*

![pi](https://img.shields.io/badge/agent-pi.dev-6b46c1)
![model](https://img.shields.io/badge/model-Kimi%20K3%20%7C%20K3.1%20Pro-d97757)
![platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS-1f2937)
![shell](https://img.shields.io/badge/shell-bash-4eaa25?logo=gnubash&logoColor=white)
![python](https://img.shields.io/badge/python-3.11%2B-3776ab?logo=python&logoColor=white)
![node](https://img.shields.io/badge/node-22%2B-339933?logo=nodedotjs&logoColor=white)
![license](https://img.shields.io/badge/license-MIT-green)
![PRs](https://img.shields.io/badge/PRs-welcome-brightgreen)

`bug-bounty` · `offensive-security` · `web-security` · `recon` · `llm-agents` · `rag` · `mcp` · `automation`

</div>

---

> [!WARNING]
> **Authorized testing only.** pi-hunt is an autonomous offensive-security tool. Use it **exclusively** against targets you own or are explicitly authorized to test under a bug-bounty program's scope and rules. You are responsible for staying in scope and obeying program policy and the law. The maintainers accept no liability for misuse.

---

## Table of contents

- [Why pi-hunt](#why-pi-hunt)
- [Quick start](#quick-start)
- [Post-install (one-time)](#post-install-one-time)
- [Usage](#usage)
- [Architecture](#architecture)
- [What's included](#whats-included)
- [Optimization layers](#optimization-layers)
- [Configuration](#configuration)
- [Requirements](#requirements)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)

---

## Why pi-hunt

Most "AI hacking" setups are a single chat window. pi-hunt is a **team**: a coordinator plans the hunt, routes each surface to the right specialist, runs them in parallel, chains low-severity signals into criticals, and validates every candidate through a strict triager before it's written up — all locally, with full evidence trails.

| | |
|---|---|
| 🧠 **Coordinator + 26 specialists** | One brain delegates to focused hunters (SSRF, OAuth/ATO, RCE, IDOR/BOLA, race, cache, smuggling, XSS, SQLi, LLM/prompt-injection, recon, triage…). |
| 🔌 **7 MCP servers** | Browser (Chrome DevTools), Burp, Memory graph, GitHub, Medium, Gmail, plus a built-in **RAG** server. Verified live: browser-live 29 tools · memory 8 · medium 3 · pihunt-rag 5 · gmail 19. |
| 📚 **Vectorized knowledge base** | Semantic recall over a curated techniques KB, your past findings, the memory graph, and learned heuristics. |
| 💸 **Cost-tiered models** | Mechanical agents on `k3-256k`, the elite validation pair on `k3.1-pro`, everything else on the `k3` flagship. Two toggles. |
| 🌙 **Nightly recon loop** | An 11-stage recon engine on a 6h systemd timer feeds the live attack surface into the RAG, so hunts start from current data. |
| ⚡ **Smarter recon commands** | Auto-injects quality SecLists wordlists into `ffuf`/`gobuster`/etc. — without slowing down everyday commands. |
| 🛡️ **Evidence-first** | Every finding gets a self-contained, copy-paste-reproducible report with negative controls before it's kept. |

---

## Quick start

> [!IMPORTANT]
> The default runtime is **Kimi Code** (`api.kimi.com/coding`, Anthropic-compatible),
> billed to a **Kimi Code subscription** — configure the key locally after
> installation (`~/.pi/agent/auth.json` + `~/.pi/secrets/kimi.env`, keep both
> `chmod 600`; never commit it). The default posture is **conservative**: flagship
> `k3`, the elite pair (strict-triager / hypothesis-redteam) on `k3.1-pro`, and the
> mechanical agents on `k3-256k`.

### Option A — one command (recommended)

```bash
git clone https://github.com/<user>/pi-hunt.git && cd pi-hunt
./bootstrap.sh --with-extras
```

`bootstrap.sh` installs missing prerequisites (Node 22+, Python, rsync, git), runs the pi framework installer (Kimi Code runtime), and (with `--with-extras`) the recon toolchain + SecLists.

### Option B — Make

```bash
make dry      # preview everything, change nothing
make full     # framework + recon CLIs & SecLists (needs sudo)
make install  # framework only
```

### Option C — direct

```bash
./install.sh --dry-run    # preview
./install.sh              # framework only (prompts for the GitHub MCP token)
./extras.sh               # optional: recon CLIs + SecLists (needs sudo)
```

> [!TIP]
> Everything is **idempotent and reversible** — re-running backs up any file it replaces to `<file>.bak-<timestamp>`. Start with `--dry-run` to see every action first.

---

## Post-install (one-time)

These are per-machine secrets the installer can't carry for you (it reminds you too):

```bash
# 1. Kimi Code subscription key (from the Kimi Code console at kimi.com):
#    the SAME key goes in both places; keep both files chmod 600.
#    ~/.pi/agent/auth.json  → auth for the "kimi-coding" provider (pi's source of truth)
#    ~/.pi/secrets/kimi.env → export KIMI_API_KEY=... (sourced by your shell)

# 2. GitHub MCP token (read-only; powers repo hunts + scout searches):
echo 'export GITHUB_MCP_TOKEN=ghp_xxx' > ~/.pi/secrets/github_mcp.env && chmod 600 ~/.pi/secrets/github_mcp.env

# 3. HackerOne — the SAME token pair in BOTH files, or scope loading breaks:
#    ~/.pi/secrets/h1_api.env : export H1_API=… H1_HANDLE=… H1_UA=…
#    ~/.config/pihunt/h1.env  : export H1_USER=… H1_API=…
curl -su "$H1_USER:$H1_API" https://api.hackerone.com/v1/me   # expect 200

# 4. Intigriti personal access token (keep all three copies in sync):
#    ~/.pi/secrets/intigriti.env, ~/.config/pihunt/intigriti.env, intigriti.systemd.env
#    each carries INTIGRITI_APP + INTIGRITI_TOKEN (APP must equal the researcher id)
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $INTIGRITI_TOKEN" \
     https://api.intigriti.com/external/researcher/v1/programs   # expect 200

# 5. Gmail MCP OAuth (optional, for inbox/OTP flows):
mkdir -p ~/.gmail-mcp   # drop gcp-oauth.keys.json + credentials.json here
npx @gongrzhe/server-gmail-autoauth-mcp auth

# 6. Burp (optional): Burp Suite + the official PortSwigger "MCP Server"
#    extension (burp-mcp-all.jar, added via Extender -> Add). In Burp's MCP tab:
#    Host 127.0.0.1, Port 9876, Enabled ON (Output tab shows "Started MCP server").
#    The bridge connects directly to that SSE server — no proxy jar needed.
#    ⚠️ LAUNCH BURP BEFORE pi-hunt — the bridge attaches at session startup.

# 7. Lock down every key file (none should be world-readable):
chmod 600 ~/.keys_secrets/*.txt ~/.pi/secrets/*.env ~/.config/pihunt/*.env
```

Make sure `~/.local/bin` is on your `PATH`:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```

---

## Usage

```bash
pi-hunt                                   # interactive — then type a hunt command
pi-hunt "Hunt acme for CRITICAL"          # one-shot
```

Inside a session:

```
Hunt <program> in HackerOne for CRITICAL
Hunt <program> in Intigriti for HIGH
Hunt <program> in YesWeHack for HIGH
```

The coordinator loads scope, maps the attack surface, routes surfaces to specialists, chains findings, validates them, and writes reports to `reports/<program>/…`.

Handy toggles:

```bash
pi-tier status    # show per-agent models
pi-tier on        # cost tiering: mechanical agents -> k3-256k
pi-4.8 on|off     # flagship quality: k3.1-pro (premium) / k3 (conservative)
pihunt-rag search "ssrf to cloud metadata"     # query the knowledge base
pihunt-recon acme example.com --deep           # manual recon run (also on a 6h timer)
```

### Getting the most out of pi-hunt

1. **Launch Burp first.** MCP servers attach only at `pi-hunt` startup — make sure Burp (AI-Agent extension) is listening on `127.0.0.1:9876` *before* launching. Fixing it later means restarting the session.
2. **Check credentials are live.** Dead tokens make the scope-loader agents come back **empty**, which silently degrades the whole hunt — they don't throw. Verify before big launches (curl checks in [Post-install](#post-install-one-time)).
3. **Recon before hunting.** The 6h recon timer keeps the RAG warm automatically. Before a focused hunt, force one deep pass for the target so the coordinator starts from live surface data: `pihunt-recon <program> <domain> --deep`.
4. **Pick the right posture.**
   - `pi-4.8 off` (default, conservative — `k3` flagship + `k3-256k` mechanicals): wide sweeps, multi-program grinds, long parallel days.
   - `pi-4.8 on` (premium — flagship tier and coordinator on `k3.1-pro`): focused creative pushes at one high-value program. The elite pair (strict-triager, hypothesis-redteam) is always on `k3.1-pro` either way.
5. **Feed the learning loop.** Tag lessons as you work (`INSTINCT:` / `LESSON:` / `DEADEND:` lines or `/instinct "lesson" --domain x --when "context"`); instincts above the 0.70 confidence threshold auto-promote into the RAG and steer future hunts.
6. **Tune concurrency to your box.** `PI_SUBAGENT_MAX_CONCURRENCY` / `_MAX_QUEUE` / `_RAM_FLOOR_MB` in `~/.pi/secrets/pihunt-tuning.env` — preset for a 12-core/15 GB host, lower it on smaller hardware.
7. **Headless hunts** (cron/automation): `pi-hunt -p "Hunt <program> for CRITICAL"`.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                         pi (coding agent)                          │
│                                                                    │
│   coordinator  ──delegates──▶  26 specialist sub-agents            │
│       │                         (ssrf, oauth, rce, idor, race,     │
│       │                          cache, smuggling, xss, sqli,      │
│       │                          llm, recon, triager, …)           │
│       │                                                            │
│   extensions:  subagent (ensemble/swarm) · cmd-optimizer ·         │
│                mcp-bridge · auto-continue · compact-on-46          │
└───────┬───────────────────────────────────────────────┬──────────┘
        │ Anthropic-compatible API                       │ MCP
        ▼                                                ▼
┌────────────────────┐                  ┌──────────────────────────┐
│  Kimi Code API      │  k3 · k3.1-pro   │  MCP servers             │
│  api.kimi.com/coding│◀─────────────────│  browser-live · burp ·   │
│  (subscription)     │  k3-256k         │  memory · github ·       │
└────────────────────┘                  │  medium · gmail ·        │
                                        │  pihunt-rag + ollama     │
                                        └──────────────────────────┘
```

pi calls Kimi Code directly through its Anthropic-compatible Messages API via the
built-in `kimi-coding` provider (`api.kimi.com/coding`, subscription-billed — no
per-token gateway in the path). MCP servers, browser automation, Burp,
memory/RAG, and subagent processes remain local to `pi`. A local **Ollama**
provider is pre-registered in `models.json` as the free fallback tier.
`kiro-gateway/` is retained as legacy/reference-only material and is not on the
default runtime path.

---

## What's included

| Path | Installs to | What it is |
|---|---|---|
| `bin/` | `~/.local/bin/` | `pi-hunt` (Kimi Code launcher) · `pi-4.8` (flagship toggle: k3 ↔ k3.1-pro) · `pi-tier` (cost tiering); `pi-kiro` is legacy-only |
| `pi-agent/` | `~/.pi/agent/` | `models.json`, `settings.json`, **26 agents**, extensions (subagent ensemble/swarm, mcp-bridge, auto-continue, compact-on-46, **cmd-optimizer**, session-memory, **continuous-learning**), coordinator prompt, steering + MCP config |
| `rag/` | `~/.pi-hunt-rag/` + `~/opencode/pihunt-rag-mcp/` | **RAG + knowledge graph** — vectorized search, techniques KB, MCP server ([details](rag/README.md)) |
| `kiro-gateway/` | — | Legacy Anthropic↔Kiro bridge retained for historical/reference use only |
| `kiro-settings/mcp.json` | `~/.pi/agent/mcp.json` | MCP config template (`${GITHUB_MCP_TOKEN}` placeholder) — deployed with real paths to the bridge's first search location |
| `mcp-servers/` | various | browser-live, chrome-devtools, medium-rss, burp-proxy, pihunt-rag server code |
| `skills/` | `~/.pi/agent/skills/` | 9 skills: auth-attack-patterns, business-impact, chain-patterns, critical-endpoints, framework-exploits, recon-checklist, security-bounty-hunter, source-review, writeup-intel |
| `steering/`, `prompts/` | `~/.pi/agent/steering/`, `~/.config/opencode/…` | workflow rules + the coordinator brain |
| `systemd/` | `~/.config/systemd/user/` | **nightly/6h recon auto-run** (`pihunt-recon` service + timer) with its own synced env files |
| `extras.sh` | — | optional recon toolchain installer (httpx, katana, dnsx, naabu, subfinder, nuclei, ffuf, sqlmap, gau, git-dumper, **SecLists**, …) |

### Bundled pi packages

Hunt-relevant packages from the [pi package catalog](https://pi.dev/packages), installed automatically by `install.sh` (and pinned in `pi-agent/settings.json`). Manage with `pi list` / `pi update --extensions` / `pi remove npm:<pkg>`.

| Package | Type | What it adds |
|---|---|---|
| [`pi-casefile`](https://pi.dev/packages/pi-casefile) | extension | Offensive-security **case tracker** — log bug-bounty/CTF/audit findings as you hunt |
| [`pi-recon-tools`](https://pi.dev/packages/pi-recon-tools) | tools | Recon toolkit: headers audit, SSL check, DNS, port scan, tech fingerprint, path discovery (`nmap`/`openssl`/`dig`) |
| [`@artale/pi-pentest`](https://pi.dev/packages/@artale/pi-pentest) | tools | `nmap` wrapper + vulnerability checks |
| [`pi-redteam`](https://pi.dev/packages/pi-redteam) | ext+skills | 10 specialist security agents for vuln assessment & pentest |
| [`@vigolium/piolium`](https://pi.dev/packages/@vigolium/piolium) | ext+skills | Multi-phase security audits with isolated-context specialist sub-agents |
| [`pi-web-access`](https://pi.dev/packages/pi-web-access) | ext+skills | Zero-config web search/fetch/scrape/PDF/GitHub-clone (Exa MCP, no key; optional provider keys) |

> These run with full system access (like any pi package). The recon/pentest ones shell out to standard CLIs (`nmap`, `openssl`, `dig`) that `extras.sh` installs. `pi-web-access` works out of the box; add keys in `~/.pi/web-search.json` for more providers.

---

## Optimization layers

Three layers make hunts cheaper and sharper without dulling the agents that find bugs.

### 1. Model tiering — `pi-tier`

Mechanical agents run on a cheaper **fast** model; reasoning/exploit/validation agents stay on the **flagship**.

| Tier | Agents | Default model |
|---|---|---|
| ⚙️ helper (mechanical) | h1/intigriti/yeswehack scope-loaders, recon, test-account-manager, visual-security, payload-researcher, wordlist-curator | `kimi-coding/k3-256k` |
| 🧠 flagship (reasoning) | coordinator + 16 remaining specialists | `kimi-coding/k3` |
| 🏆 elite (validation/redteam) | strict-triager, hypothesis-redteam | `kimi-coding/k3.1-pro` |

Large-context compaction uses `kimi-coding/k3-256k` as its summarizer (`COMPACT_ON_46_*`).

```bash
pi-tier on      # apply        pi-tier status              # show
pi-tier off     # mechanicals->flagship      pi-tier set-fast <model>   # change fast model
```

Composes with `pi-4.8`: `off` is the conservative default (`k3` flagship), `on`
upgrades the flagship tier *and* the coordinator/defaultModel to `k3.1-pro` for
max-quality pushes. The elite pair is **always** pinned to `k3.1-pro`.

> 💡 A local **Ollama** provider is pre-registered in `models.json`
> (`http://localhost:11434/v1`) with placeholder model ids — swap in your
> upgraded local models and `pi-tier set-fast <id>` for a $0 mechanical tier.

### 2. Command optimization — `cmd-optimizer` extension

A `tool_call` hook that auto-injects mode-aware **SecLists** wordlists + benign flags into discovery tools (`ffuf`, `feroxbuster`, `gobuster`, `dirsearch`, `wfuzz`, `dnsx`) **only when no wordlist is given**.

✅ Never touches everyday commands (`grep`, `ls`, `cat`, `curl`, `git`, …) — they exit on the first token, so normal latency is unchanged.
✅ Respects wordlists you already chose · idempotent · fail-safe · config-driven.

```bash
PIHUNT_CMDOPT=0                       # disable
~/.pi-hunt-rag/data/cmdopt.json       # disabledTools[] / extraTools{}
```

[Details →](pi-agent/extensions/cmd-optimizer/README.md)

### 3. RAG + knowledge graph — `pihunt-rag`

Semantic recall over four sources: a curated **techniques** KB (what top hunters do per class), the **Memory** graph, your **past findings**, and **model notes** (heuristics recorded for reuse). model2vec embeddings (CPU/numpy, ~30 MB, offline hashed-ngram fallback) in a SQLite vector store.

```bash
pihunt-rag search "oauth account takeover" --source techniques
pihunt-rag search "what did I find on acme" --program acme --source findings
pihunt-rag record "## title" "a reusable lesson"
```

MCP tools: `rag_search`, `rag_record_technique`, `rag_graph_add`, `rag_ingest`, `rag_stats`. [Details →](rag/README.md)

### 4. Continuous learning — `continuous-learning` extension

Turns hunt sessions into confidence-scored **instincts** and promotes the strong ones into the RAG (`model-notes`) so future hunts recall them via `rag_search`. Captures two cheap, deterministic signals: tagged lines the agents emit (`INSTINCT:` / `LESSON:` / `DEADEND:`, with optional `#domain` and `when <context>`) and repeated security-tool workflows. Complements `session-memory` (which persists/restores *session context*) — this learns *reusable behaviors*.

```bash
/instinct "pull source maps before fuzzing" --domain recon --when "target is Next.js"
/instinct-status              # ★ = promoted to the RAG
PIHUNT_LEARNING=0             # disable · PIHUNT_LEARNING_THRESHOLD tunes promotion (default 0.70)
```

[Details →](pi-agent/extensions/continuous-learning/README.md)

### 5. Nightly recon → RAG loop — `pihunt-recon`

An 11-stage recon engine (ASN/IP-space first → subdomain enum → DNS brute →
resolution + dangling-CNAME takeover flags → port scan → HTTP probe →
screenshots (deep) → crawl + URLs → param discovery → content discovery →
JS/secret mine. The final stage runs **jsleak**: a 784-pattern secret sweep +
LinkFinder-style endpoint mining over collected JS (detector-name-filtered to
cut noise, hardcoded-regex fallback; `trufflehog --only-verified` in deep mode
stays the strong verifier). It writes normalized artifacts under
`reports/<program>/structured-recon/`, **diffs each run against the previous one**
(`anew`) so "NEW since last run" surfaces, and re-ingests everything into the
RAG so hunts always start from current data.

Runs automatically on a **6h systemd user timer**; 28 tools installed and
path-verified (`~/.pdtm/go/bin` + `~/.local/bin`). Tune with `RECON_JSLEAK_PATTERNS`,
`RECON_JSLEAK_CAP`, and `RECON_JSLEAK_DETECTORS` (default filter:
aws/google/github/slack/stripe/… — set `all` to keep raw output).

```bash
pihunt-recon acme example.com            # normal: passive + probe (timer-friendly)
pihunt-recon acme example.com --deep     # adds ports, brute, fuzz, screenshots
systemctl --user list-timers             # next scheduled run
pihunt-rag stats                         # RAG health after the run
```

Complements the subfinder Chaos/GitHub/Shodan provider keys — supply those in
subfinder's provider-config plus `GITHUB_TOKEN` for ~28% more subdomains.

---

## Configuration

| Env / file | Purpose |
|---|---|
| `~/.pi/agent/settings.json` | default provider/model (`kimi-coding`/`k3`), thinking level (`xhigh`), skills dir, retries, compaction |
| `~/.pi/agent/models.json` | Kimi model catalog merged into the built-in `kimi-coding` provider + Ollama local placeholder |
| `~/.pi/agent/mcp.json` | deployed MCP server config (from `kiro-settings/mcp.json`) |
| `~/.pi/secrets/*.env` | credentials: kimi, github_mcp, h1_api, intigriti, tuning — **keep `chmod 600`** |
| `~/.config/pihunt/*.env` | platform/recon envs synced for login shells + systemd units — **keep `chmod 600`** |
| `~/.pi-hunt-rag/data/cmdopt.json` | command-optimizer rules |
| `~/.pi-hunt-rag/data/instincts.jsonl` | learned instinct store (continuous-learning) |
| `PIHUNT_CMDOPT=0` | disable command optimization |
| `PIHUNT_LEARNING=0` | disable continuous learning · `PIHUNT_LEARNING_THRESHOLD` sets promotion cutoff (default `0.70`) |
| `PI_SUBAGENT_MAX_*` (`~/.pi/secrets/pihunt-tuning.env`) | subagent concurrency / queue / RAM-floor tuning |
| `PIHUNT_RECON_ROOT` (default `~/hunts`) | where `pihunt-recon` writes per-program artifacts |

---

## Requirements

**Required:** Node 22+, npm, Python 3.11+, `curl`, `rsync`, `git`, Java (Burp MCP), and a **Kimi Code subscription** key (models `k3`, `k3.1-pro`, `k3-256k` are subscription-billed — no per-token topups).

**Optional:** Chromium (browser-live) · Gmail OAuth · the recon toolchain via `./extras.sh` · local models via Ollama (provider placeholder ready in `models.json`).

`bootstrap.sh` installs the required ones for you on apt/dnf/pacman/brew systems.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `pi-hunt: command not found` | add `~/.local/bin` to `PATH` (see [Post-install](#post-install-one-time)) |
| auth/model error from `kimi-coding` | key must be present in BOTH `~/.pi/agent/auth.json` and `~/.pi/secrets/kimi.env`; test: `pi --model kimi-coding/k3 -p "say pong"` |
| model id not found (`k3`, `k3-256k`, …) | `~/.pi/agent/models.json` must merge those ids into the built-in `kimi-coding` provider |
| an MCP server failed at launch | servers attach only at session start — fix `~/.pi/agent/mcp.json` (paths/deps/token) and restart the session |
| Burp MCP "Not connected" | launch Burp (MCP tab: Enabled ON, host 127.0.0.1 port 9876) **before** `pi-hunt`; the bridge now talks to Burp's SSE server directly (no proxy jar) |
| GitHub MCP 401 / credential expired | refresh the token in `~/.pi/secrets/github_mcp.env` and relaunch |
| HackerOne 401 | same token pair in `~/.pi/secrets/h1_api.env` *and* `~/.config/pihunt/h1.env`; test: `curl -su "$H1_USER:$H1_API" https://api.hackerone.com/v1/me` |
| scope loaders return empty results | usually an expired platform token — verify each curl check; empty scope silently degrades the hunt |
| `pi-hunt: missing coordinator prompt` | steering file missing — restore `~/.pi/agent/steering/bugbounty-autoflow.md` |
| RAG search empty / model missing | `pihunt-rag ingest` to rebuild; it falls back to an offline embedder if the model isn't downloaded |
| Nuclei templates won't update (`-update-templates` silently exits) | the projectdiscovery CDN may be blocked on your network — refresh via `git clone --depth 1 https://github.com/projectdiscovery/nuclei-templates` and replace `~/.local/nuclei-templates` |
| Node too old | `bootstrap.sh` installs Node 22 via NodeSource on apt; the harness also runs on Node 25+ |

---

## FAQ

**Is this safe to run against any site?** No. Only targets you own or are authorized to test under a bug-bounty scope. See the warning at the top.

**Does it submit reports automatically?** No. It produces local, reproducible report folders. You review and submit.

**Do I need all the MCP servers?** No. Memory + RAG + browser-live cover most flows; Burp and Gmail are optional.

**Can I use my own models?** Yes — `pi-agent/models.json` merges extra Kimi models into the built-in `kimi-coding` provider and supports local providers; an **Ollama** placeholder (`localhost:11434`) is pre-wired so a local model can serve as the free mechanical tier once you swap in the real ids.

**Will it run offline?** The RAG falls back to an offline embedder and the Ollama tier is local, but the agents themselves need the Kimi Code API (network).

---

## Contributing

PRs welcome. Good first contributions: new entries in `rag/techniques/techniques.yaml`, new specialist agents in `pi-agent/agents/`, or `cmd-optimizer` rules for more tools. Please keep secrets out of commits (`.gitignore` already excludes `.env`, tokens, and runtime state).

---

## License

[MIT](LICENSE). The retained legacy `kiro-gateway` subtree has its own upstream license.

<div align="center">
<sub>Built for researchers who'd rather design the hunt than babysit the tooling.</sub>
</div>
