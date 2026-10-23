# cmd-optimizer extension

Augments **recon/fuzzing** commands the model (or you) runs with high-quality
wordlists and a couple of sane flags — without slowing down everyday commands.

## What it does

Hooks pi's `tool_call` event for the `bash` tool. For a small allowlist of
discovery tools, when the command is **missing a wordlist** it injects a good
SecLists list chosen by mode, and adds benign defaults when absent:

| tool | default wordlist (first that exists) | mode detection |
|------|--------------------------------------|----------------|
| `ffuf` | raft-large-directories / directory-list-2.3-medium / common | vhost (`-H Host: FUZZ`), param (`?x=FUZZ`), api (`/api`), else dir |
| `feroxbuster` | raft-large-directories | — |
| `gobuster` | dir→raft-large-directories, dns→subdomains-top1m, vhost→subdomains-top1m | sub-command |
| `dirsearch` | raft-large-directories | — |
| `wfuzz` | raft-large-directories | — |
| `dnsx` | subdomains-top1million-110000 | **only** in brute mode (`-d`/`--brute`); resolve mode untouched |

Benign flags added when absent: `ffuf` → `-mc all -t 40 -ac`; `feroxbuster`/`gobuster` → `-t 40`.

## What it deliberately does NOT do

- **Never touches everyday commands.** grep, ls, cat, sed, awk, curl, git, find,
  python, node, jq, echo, etc. exit the logic immediately (the segment's first
  token isn't a known discovery tool), so their latency is unchanged. This was an
  explicit design requirement.
- **Never overrides a wordlist you already chose** (`-w`/`--wordlist` present).
- **Never changes targets, methods, output files, or anything risky.** Only adds a
  wordlist + a couple of throughput/match flags.
- **Idempotent** — a trailing `#cmdopt` marker prevents double-augmentation, and
  re-running an already-augmented command is a no-op.
- **Fail-safe** — any error in the optimizer leaves the original command untouched;
  a missing wordlist path falls through candidates and silently no-ops.

## Config & toggle

- Disable entirely: `PIHUNT_CMDOPT=0`.
- Config file (auto-seeded): `~/.pi-hunt-rag/data/cmdopt.json`
  - `disabledTools`: `["ffuf"]` to stop augmenting a specific tool.
  - `extraTools`: `{"myfuzzer":"dir"}` to add your own tool → wordlist category
    (`dir|word|dns|param|vhost|api|lfi`). Hot-reloaded at most every 30s.

## Files

- `optimize.ts` — pure, unit-tested augmentation logic (no pi imports).
- `index.ts` — thin `tool_call` hook that calls `optimize.ts`.

## Verify

The pure logic has a 14-case test (fuzzing tools augmented correctly by mode,
everyday commands untouched, idempotent, user wordlists preserved, dnsx
resolve-mode skipped). Wordlists resolve against the local SecLists install at
`/usr/share/seclists` with fallbacks to `/usr/share/wordlists`.
