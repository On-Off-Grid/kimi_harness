# continuous-learning

Turns hunt sessions into confidence-scored **instincts** and promotes the strong
ones into the RAG so future hunts recall them automatically.

Adapted from ECC's `continuous-learning-v2` (instinct model + confidence scoring
+ promotion), but pi-native and lean: **no homunculus dir and no background-LLM
observer**. Instincts live in one JSONL under the existing `RAG_HOME`, and
promotion reuses the same `pihunt-rag` store the model already searches.

> **Not the same as `session-memory`.** `session-memory` persists/restores
> *per-session context* ("where we left off"). This extension learns *reusable
> behaviors* ("what works / what's a dead end") across sessions. They are
> complementary and both write through `pihunt-rag`. ECC's separate
> `memory-persistence` hook graph is intentionally **not** ported — `session-memory`
> already covers that lifecycle for the pi/Kiro host.

## What an instinct is

One atomic learned behavior:

```
trigger ("when ...") + action ("do ...") + domain + confidence + evidence
```

`kind` is `do` (a behavior to repeat) or `avoid` (a dead end / false-positive).

## Signals (deterministic, cheap, fail-safe)

**1. Tagged lines in the model's turn text.** Any specialist/coordinator can drop these. Emit exactly one tagged line at each meaningful decision point (missing tag emission is a workflow failure):

- `INSTINCT:`: a behavior that worked (stored as `do` in project scope)
- `DEADEND:`: something that failed / wastes time (stored as `avoid` in global scope)
- `CHAIN:`: confirmed multi-step chain after strict-triager validation (stored as `chain` in techniques/RAG)

Promotion into learning artifacts depends strictly on these tags. Inline hints inside the line are parsed: `#domain` and `when <context>`.

**2. Repeated security-tool commands.** Repeated identical `bash` invocations of an
allowlisted discovery/exploit tool (`ffuf`, `feroxbuster`, `gobuster`, `dirsearch`,
`katana`, `gau`, `httpx`, `dnsx`, `naabu`, `subfinder`, `nuclei`, `sqlmap`,
`dalfox`, `nmap`, `git-dumper`) build a "reuse workflow" instinct. URLs/IPs/`-o`
targets are normalized out so the *shape* of the workflow matches across targets.

## Confidence + promotion

- Starts at **0.40**; **+0.10** per fresh reinforcement (cap **0.95**).
- A contradiction (an `avoid` of the same normalized action as a `do`, or vice
  versa) drops the twin by **0.20** (floor 0.10).
- At **>= threshold** (default **0.70**) an un-promoted instinct is written to the
  RAG `model-notes` exactly once (via `pihunt-rag record`) and marked promoted —
  after which `rag_search` / specialists can recall it. Promotion depends on the
  tagged line itself, not a narrative summary.

## Commands

```
/instinct "<action>" [--domain d] [--when ctx] [--global]   # record/boost (manual, +0.15)
/instinct-status [--all]                                    # list instincts (★ = promoted)
/instinct-promote [<id>|all]                                # force-promote
```

## Toggles

| Env | Default | Purpose |
|---|---|---|
| `PIHUNT_LEARNING=0` | on | disable the extension entirely |
| `PIHUNT_LEARNING_THRESHOLD` | `0.70` | promotion confidence cutoff |
| `PIHUNT_LEARNING_STORE` | `$RAG_HOME/data/instincts.jsonl` | instinct store path |

## Storage

`$RAG_HOME/data/instincts.jsonl` — one JSON instinct per line (id, scope, project,
kind, trigger, action, domain, confidence, count, evidence, promoted, timestamps).
Promoted instincts also land in `$RAG_HOME/data/model-notes.md` via the RAG CLI.

Everything is best-effort: a failure to read/write/promote never throws and never
blocks the session (matches the `session-memory` / `cmd-optimizer` contract).
