# pi-hunt tooling cheat-sheet — orchestration & recon synthesis

Companion to `pi_hunt_cheat_sheet.md` (that one covers prompting/steering inside the TUI;
this one covers the **model/provider orchestration** and the **recon-synthesis tooling**).
All synthesis tools are program-agnostic: default program `digitalocean`, override with
`--program <name>` or `$PIHUNT_PROGRAM`.

---

## 0. The stack at a glance

| Layer | Tool | Owns |
|---|---|---|
| Launch / drive | `bin/pi-hunt`, `bin/pi-4.8`, `bin/pi-kiro` | start the coordinator + 26 subagents |
| Model/provider orchestration | `bin/pi-tier` | which model each agent class runs on + auto-failover |
| Recon synthesis | `bin/pihunt-gadgets` | rank where to spend the hunt; re-arm killed leads |
| Authz synthesis | `bin/pihunt-authz` | cross-team verb×resource gaps (forgotten-sibling-verb) |
| Data (per program, gitignored) | `reports/<prog>/structured-recon/*.jsonl` | gadget graph, triggers, authz grid |

**Agent classes (26 total):** coordinator + 16 hunters + 8 mechanical + 2 elite (strict-triager, hypothesis-redteam).

---

## ⚠ Deploy model (edit-then-redeploy gotcha)

`pi-hunt`, `pi-4.8`, and `pi-tier` run from `~/.local/bin` as **copies** deployed by `install.sh`.
Editing the repo's `bin/` version does **not** change the command on your `PATH` until you redeploy:

```bash
cp -p bin/pi-tier ~/.local/bin/pi-tier && chmod +x ~/.local/bin/pi-tier   # or re-run install.sh
```
Symptom of a stale copy: a usage error that omits a flag you added (e.g. `pi-tier coord-health`
"usage: …{…|amd-fallback}" with no `coord-health`). Agents/prompts deploy the same way — that is
what the prompt-gate "build drift" check guards.

`pihunt-gadgets` and `pihunt-authz` are **also deployed to `~/.local/bin`** (same redeploy rule after
a repo edit), and they resolve `reports/<prog>/` by walking **up from your current directory** — so run
them from inside the repo (bare `pihunt-gadgets rank`, or `bin/pihunt-gadgets rank`); from outside any
repo they report no data rather than erroring.

---

## 1. Launch & drive

```bash
pi-hunt                                    # interactive TUI; then type: Hunt <program> for CRITICAL
pi-hunt "Hunt digitalocean for CRITICAL"   # interactive, pre-seeded
pi-hunt -p "Hunt digitalocean for CRITICAL"  # headless one-shot (no auto-continue watchdog)
PIHUNT_COORDINATOR_MODEL=openrouter/deepseek/deepseek-v4.1-flash:high pi-hunt   # one-launch coord override
```
- Launch **Burp** (AI-Agent ext on 127.0.0.1:9876) first if you want Burp MCP tools.
- Coordinator model is read at launch from `~/.pi/agent/.coordinator-model` (set via `pi-tier set-coordinator`).
- Auto-continue watchdog is **TUI-only**; toggle live with `/autocontinue off`.
- `pi-4.8 on|off` — Kimi flagship quality toggle; only touches agents already on a Kimi model.
- `pi-kiro` — run pi.dev backed by Kiro (Amazon Q) Claude Opus 4.8.

---

## 2. `pi-tier` — model/provider orchestration

```bash
pi-tier status                 # per-agent model + class counts + fast/hunter/coord refs
pi-tier on                     # apply the 3-tier mapping (mechanical / hunters / elite)
pi-tier off                    # mechanical + hunters -> Kimi flagship fallback
pi-tier set-coordinator <provider/model[:thinking]>   # applies at NEXT launch
pi-tier set-hunter <provider/model>                   # applies at next subagent spawn
pi-tier set-fast <provider/model>                     # mechanical tier
pi-tier set-agent <agent> <provider/model>            # pin one agent (persists across `on`)
pi-tier clear-agent <agent>                           # drop the pin, back to tier default
```
Refs are `provider/model[:thinking]` and must exist in `~/.pi/agent/models.json`.
**Effect applies to NEW spawns**; a coordinator change applies at next launch, elite at next subagent spawn.

### Auto-failover watchers — start these alongside a long hunt
```bash
pi-tier hybrid watch 300 &        # elite pair Kimi<->AMD on Kimi's 5h quota window
pi-tier amd-fallback watch 300 &  # AMD $1/day cap -> OpenRouter, back on reset
pi-tier coord-health watch 120 &  # coordinator provider down -> stage healthy fallback
pi-tier concurrency watch 300 &   # scale PI_SUBAGENT_MAX_CONCURRENCY to # providers up (NEW)
```

**concurrency** scaling: sets `PI_SUBAGENT_MAX_CONCURRENCY` in `pihunt-tuning.env` from how many
providers are usable — all three (OpenRouter+AMD+Kimi) → 6, two → 4, OpenRouter-only or none → 3.
Like the coordinator model it **applies at the next launch**, and the env is read at process start,
so **re-source `pihunt-tuning.env` (or open a new shell) and launch fresh** — resuming a paused
session keeps its old concurrency. `pi-tier concurrency status` shows current vs desired. Note it
counts AMD as "up" only when its `$1/day` budget probe returns 200, so a capped/flapping AMD keeps
you at the conservative value (correct: capped AMD routes to paid OpenRouter via `amd-fallback`).
Status / stop any of them:
```bash
pi-tier hybrid status | amd-fallback status | coord-health status
pi-tier hybrid off    | amd-fallback off    | coord-health off
```
- **coord-health** (the silent-freeze fix): probes the coordinator's current provider; if it's
  down (429/402/401/unreachable) it stages the first *healthy* fallback (OpenRouter→AMD→Kimi) into
  `.coordinator-model` for the **next launch** and logs it loudly. It cannot relaunch the TUI, so a
  live frozen hunt still needs a manual relaunch — but it comes up on a healthy provider.
- Watcher logs: `~/.pi/agent/{hybrid,amd-fallback,coord-health}.log`.
- Workhorse = AMD DeepSeek-V4.1-Flash (free, big-ctx, cap-free over long runs, refusal-free).

---

## 3. `pihunt-gadgets` — where to spend the hunt

```bash
pihunt-gadgets rank       # ranked missing-primitive shopping list (START HERE)
pihunt-gadgets chains     # per-chain composability (what's blocked on what)
pihunt-gadgets triggers   # which re-arm triggers are ARMED vs WAITING
pihunt-gadgets check      # exit 10 if any trigger is ARMED (used by run_recon.py)
pihunt-gadgets report     # write structured-recon/gadgets-report.md
```
**Reading `rank`:** rows are the capabilities no confirmed gadget grants yet, sorted by
(max tier unblocked → actionable-first → #chains). Classes:
- `ACTIONABLE (run the probe)` — a `probe.*` cap: the fleet can get it THIS run. Spend here first.
- `DISCOVER external gadget` — needs recon to find something (a redirect, a ciphertext leak…).
- `PROVISIONING` — an `account.*` cap (tokens/teams).
- `[probed-negative]` tag = already tested false; don't re-hunt the same way.

---

## 4. `pihunt-authz` — cross-team verb gaps

```bash
pihunt-authz gaps    # ranked untested/leaking cells (START HERE)
pihunt-authz grid    # full resource x verb enforcement grid
pihunt-authz report  # write structured-recon/authz-differential-report.md
```
Resource classes, highest priority first:
- **OPEN** — a verb returned `enforced:false` = a confirmed cross-team LEAK.
- **SPLIT** — boundary PROVEN on one verb, sibling verbs UNTESTED = the forgotten-sibling-verb bug. **Hunt these.**
- **COLD** — nothing tested yet (triage by surface age).
- **CLEAR** — every verb enforced; park it.

---

## 5. Utilizing the gadget graph

**File:** `reports/<prog>/structured-recon/gadget-graph.jsonl` — one JSON object per line.

### Node shapes
```jsonc
// a gadget you observed (ONLY status:"confirmed" grants capabilities)
{"kind":"gadget","id":"g_x","status":"confirmed","grants":["fetch.docs_mcp_follows_redirect"],
 "observation":"...","evidence":"path/"}
// a probe you ran that came back FALSE (records "don't re-hunt blindly")
{"kind":"gadget","id":"p_x","status":"negative","grants":["probe.firewall_cross_team"],"observation":"404, enforced"}
// an escalation chain: NEEDS capabilities, grants an outcome at a tier
{"kind":"chain","id":"C1","tier":"critical","status":"not_composable","case":"case_...",
 "needs":["fetch.docs_mcp_follows_redirect","redirect.offorigin:docs.digitalocean.com"],
 "grants":["ssrf.do_internal"],"note":"..."}
```
- **Capability = a dotted token.** Class is by prefix: `probe.*` = actionable this run,
  `account.*` = provisioning, anything else = an external gadget to discover.
- **A chain is composable** when every `needs` cap is granted by some `confirmed` gadget. `rank`
  aggregates the unmet needs across all chains → the single primitive that unblocks the most.
- **tier:** critical | high | medium | low | info.

### Re-arm triggers
**File:** `reports/<prog>/structured-recon/rearm-triggers.jsonl`
```jsonc
{"id":"t_x","when_capability":"redirect.offorigin:docs.digitalocean.com",
 "reopen_cases":["case_c523e9711a"],"arms_chains":["C1"],"source":"...","action":"exact next probe"}
```
When a `confirmed` gadget granting `when_capability` appears in the graph, the trigger ARMS:
`pihunt-gadgets check` exits 10 and `run_recon.py` prints the action. That's how a killed/blocked
lead auto-reopens the moment recon finds its missing piece.

### The keep-current loop (the discipline that makes this pay off)
1. Hunter confirms a primitive → add a `gadget` node, `status:"confirmed"`, with its `grants`.
2. Hunter kills a lead → add a `gadget` node, `status:"negative"` (so it isn't re-hunted).
3. New escalation idea → add a `chain` node with its `needs`/`tier`/`grants`.
4. Re-run `pihunt-gadgets rank` + `triggers` and `pihunt-authz gaps` → the next target reranks automatically.

`untested` cells mean "confirm the endpoint still exists, then probe" — not a guaranteed route.

---

## 6. Typical session order

```bash
# 1. orient: what's the highest-leverage target right now?
pihunt-gadgets rank && pihunt-authz gaps

# 2. set routing + start the safety watchers for a long run
pi-tier status
pi-tier hybrid watch 300 &  pi-tier amd-fallback watch 300 &  pi-tier coord-health watch 120 &

# 3. launch the hunt (you drive the TUI) aimed at the top-ranked targets
pi-hunt "Hunt digitalocean for CRITICAL"

# 4. during/after: as hunters confirm/kill, update gadget-graph.jsonl, then re-rank
pihunt-gadgets report && pihunt-authz report
```
Scope/creds of record: `reports/<prog>/structured-recon/scope.md`, `authz-matrix.json` (holds
secrets — never print/commit). Hunt data under `reports/` is gitignored.
