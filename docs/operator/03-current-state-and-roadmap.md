# pi-hunt — Current State & Upgrade Roadmap

> [!IMPORTANT]
> The host-specific measurements below are historical. The provider migration is
> complete: Kimi Code is the default path (`k3` flagship, `k3.1-pro` elite,
> `google-direct/gemini-3.5-flash-lite` mechanical); Kiro gateway assets are retained
> only as legacy/reference material.

_Snapshot: 2026-07-07. This is the stepping-stone document: where pi-hunt stands
today, what was just fixed, and the ranked next upgrades. Update it after each
material change so the next session starts from truth, not memory._

---

## 1. System at a glance

- **Host:** 12 cores / 15 GB RAM (~8 GB free). Bigger than the 4-core/8-GB defaults
  the runner assumes — tuning has been raised to match (see §3).
- **Coordinator:** `pi-hunt` launcher → Kimi Code `kimi-coding/k3`, max reasoning
  (`xhigh`, 60k thinking budget), auto-continue watchdog + compact-on-46 empty-trigger
  enabled.
- **Agents:** 26 specialists installed (`~/.pi/agent/agents/`). Tiering active — 8
  mechanical agents on `google-direct/gemini-3.5-flash-lite`, 16 flagship agents on
  `kimi-coding/k3`, 2 elite agents on `kimi-coding/k3.1-pro`; compaction summarizes
  with `kimi-coding/k3-256k`.
- **MCP servers (7):** browser-live, burp, memory, github (remote), medium,
  pihunt-rag, gmail.
- **Skills (17):** gate green (`make prompts-check`).
- **Provider:** Kimi Code + Google direct (mechanical tier). `kiro-gateway/` remains
  legacy/reference-only and is not started by the default launcher.

### Durable state layers (all must agree)
| Layer | Location | Role |
|---|---|---|
| Reports | `reports/<program>/...` | Source of truth (evidence, finding folders) |
| Casefile | `.pi/casefile.jsonl` via `Case*` tools | Structured ledger, enforced state machine |
| Memory graph | `~/.config/opencode/memory/memory.jsonl` (36 entities) | Cross-session pointers |
| RAG | `~/.pi-hunt-rag/data/rag.db` via `pihunt-rag` | Semantic recall |
| Recon artifacts | `~/hunts/<program>/structured-recon/` | Live recon output |

---

## 2. What changed this session (2026-07-07)

### Fixed — three silent recon-killing defects (details in `01-health-analysis.md` §3)
1. **PATH:** 26 go-based recon tools were invisible to non-interactive shells →
   symlinked into `~/.local/bin` + `~/.profile`. Installed missing `dalfox`. Toolchain
   now 27/27 under a clean PATH.
2. **dnsx parse:** ANSI/timestamp prefix zeroed `hosts_resolved.txt` → added
   `-no-color` + robust parse in `~/.local/bin/pihunt-recon`. (acme run now resolves
   957 hosts; was 0.)
3. **RAG ingest:** `PIHUNT_RAG_REPO` unset → recon never indexed. Wired into
   `~/.config/pihunt/recon.env` **and** the `pihunt-recon.service` systemd unit
   (timer-safe). Verified: `recon` source now in the RAG.

### Configured — the underused capabilities
- **Intigriti token stored** (`~/.pi/secrets/intigriti.env` + config + systemd-clean
  copy), sourced everywhere, validated live (HTTP 200, 205 programs, `finbank` +
  `acme-bounty` accessible).
- **Continuous recon registry populated** — 5 programs registered on the 6h timer:
  acme, finbank, hotelco, cloudco, petmarket (all `fast` mode).
- **Subagent tuning raised** for this box (`~/.pi/secrets/pihunt-tuning.env`):
  concurrency 8, RAM floor 1500 MB, disconfirm + MCP profiles on.

### Persisted knowledge
- 2 new `model-notes` entries (PATH self-heal; two engine bug fixes).
- 2 new memory-graph entities (intigriti-token stored; recon-registry active).

---

## 3. Current tuning (effective values)

`~/.pi/secrets/pihunt-tuning.env`:
```
PI_SUBAGENT_MAX_CONCURRENCY=8
PI_SUBAGENT_MAX_QUEUE=256
PI_SUBAGENT_RAM_FLOOR_MB=1500
PI_SUBAGENT_RAM_WAIT_MS=300000
PI_SUBAGENT_DISCONFIRM=1
PI_SUBAGENT_MCP_PROFILES=1
```

---

## 4. RAG contents (baseline to grow from)

`pihunt-rag stats` → 107 chunks:
`findings 25 · memory 35 · techniques 23 · session 12 · recon 8 · model-notes 4`.

- **findings (25):** prior confirmed/retained work — the coordinator recalls this at
  startup so it doesn't re-hunt swept surfaces.
- **techniques (23):** how top hunters attack each class + chain patterns.
- **recon (8, growing):** current live-host tables + NEW-since-last-run diffs. Grows
  every timer run now that ingest is fixed.

---

## 5. Casefile state (work in flight)

_Your own casefile lives in `.pi/casefile.jsonl` and never leaves your machine —
this section is an example of how to summarize it here so a fresh session starts
from truth. Keep it at counts + clusters; do not paste finding details into docs._

Example shape:

```
N ledger entries: X confirmed · Y investigating · Z killed · R reported · B blocked.

Report-ready / high-priority (operator submits; pi-hunt never auto-submits):
- <case_id> (severity) — one-line summary (program/platform)

Active investigation clusters:
- <weakness family> (<case_id>, <case_id>)
```

---

## 6. Known limitations (honest boundaries)

- **Asset-type ceiling:** strong on web / API / source review / AI-LLM / wildcard
  recon. Thin/unsupported: native mobile runtime, bare-metal/hardware, binary RE,
  credentialed cloud-posture, on-chain contracts.
- **The "No result" cliff:** a subagent that ends on a tool call / times out / exhausts
  turns returns nothing. Mitigated by checkpoint-as-you-go + restart-on-empty, but it's
  still the dominant throughput leak.
- **Continuous-learning loop is dormant:** `instincts.jsonl` effectively empty; the
  `INSTINCT:`/`DEADEND:`/`CHAIN:` tagging isn't producing promoted memory yet.
- **Recon `--fast` caps:** passive subdomains capped at 5000, resolve at 3000 (env:
  `RECON_SUBS_CAP`, `RECON_RESOLVE_CAP`). Big programs (acme: 140k passive subs) are
  sampled, not exhaustive, in fast mode — run `--deep` manually for full coverage.
- **X MCP public-only:** `XACTIONS_SESSION_COOKIE` unset.

---

## 7. Upgrade roadmap (ranked by leverage)

**Tier 1 — highest leverage**
1. **Revive the continuous-learning loop.** Make specialists actually emit
   `INSTINCT:`/`DEADEND:`/`CHAIN:` tagged lines and confirm the promotion threshold
   fires. This is what turns dozens of hunts into compounding advantage. Start by
   auditing why `instincts.jsonl` stays empty (agents not emitting vs. promoter not
   ingesting).
2. **Harden the "No result" defense at the runner level.** A watchdog that snapshots a
   subagent's partial `reports/` writes and auto-restarts on empty return would recover
   the single biggest source of lost work.
3. **Auto-register scope-loaded programs for continuous recon.** When a hunt loads
   scope, add the program to `pihunt-recon-reg` automatically so recon is always warm.

**Tier 2 — coverage & currency**
4. **Deep-recon scheduling for priority programs.** A separate weekly `--deep` timer
   (full subdomain brute + port scan + visual) for the top 2–3 active programs, keeping
   `--fast` on the 6h cadence for the rest.
5. **Wire `deep-research` (live N-day intel) into the recon→specialist handoff
   automatically** on every framework/version fingerprint, writing
   `reports/<p>/live-intel/<stack>.md`.
6. **authz-matrix as a first-class artifact.** Auto-provision + persist
   `authz-matrix.json` whenever auth is in scope, and pass its path into every hunter.

**Tier 3 — ergonomics & hygiene**
7. **Align recon output root** — decide between `~/hunts/` (current) and `reports/`, and
   make the manifest/memory pointers consistent so subagents never look in the wrong place.
8. **Secret-management consolidation** — single loader that emits both `export` and
   systemd-clean flavours from one source, to avoid the two-file drift documented in §3.4
   of the health doc.
9. **Instrument the recon engine** — emit a machine-readable per-stage summary
   (`manifest.json` counts) so the health sweep can assert "stage N produced > 0"
   automatically instead of eyeballing the log.

---

## 8. How to use this document

- **Before a session:** skim §1–§3 to confirm the environment matches, then run the
  health sweep in `01-health-analysis.md` §2.
- **After a material change (fix, new tool, new program, tuning):** update §2, §3, §4,
  §5 with fresh `pihunt-rag stats` / `pihunt-recon-reg list` / casefile counts so this
  stays the single source of truth.
- **When planning an upgrade:** pull the next item from §7; move it to §2 once shipped.
