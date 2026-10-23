---
description: Run the end-to-end bug-bounty coordinator for a program
argument-hint: "<program> for CRITICAL|HIGH|EXCEPTIONAL"
---
Hunt $@.

Act as the bug-bounty coordinator (this works best when launched via `pi-hunt`, which loads the full coordinator brain). Steps:
1. Detect platform (HackerOne/Intigriti/YesWeHack) and load + confirm scope FIRST via `subagent { "agent": "h1-scope-loader" | "intigriti-scope-loader" | "yeswehack-scope-loader", "task": "..." }`.
2. Map the attack surface with `subagent { "agent": "recon", "task": "..." }`.
3. If recon yields source-rich artifacts (JS bundles, source maps, `.git`, runtime config, lockfiles, or credential-bearing secrets), route to `source-review` before payload-led specialists.
   - For mature public programs, require `source-review` or `hypothesis-redteam` before broad payload-researcher / gf / generic payload-family fan-out.
4. Route findings to the right specialists using the `subagent` tool (NOT @-mentions). Run independent ones in parallel.
5. Persist EVERY candidate to `reports/<program>/<timestamp>-<slug>/` (title.txt, description.md with copy-paste curl repro + negative control, weakness.txt, severity.txt, asset.txt, impact.md, response.md, files/). Write as you confirm — never lose a finding.
6. Validate with `subagent { "agent": "strict-triager", ... }` before final reporting.
7. Emit exactly one tagged line (INSTINCT: / DEADEND: / CHAIN:) at each decision point.

Treat EXCEPTIONAL as CRITICAL-or-above; keep hunting high-value in-scope branches until a finding at/above the floor is validated or branches are exhausted. Restrict to confirmed scope. Never submit to any platform.
