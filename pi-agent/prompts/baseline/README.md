# baseline/ — pre-refactor snapshots + token accounting

This directory records the **before** state of the fleet prompt refactor so the numbers are
auditable after the fact.

## tokens.json (authoritative)

`tokens.json` is the machine-readable before/after record, generated from the deploy-time
backups (`.bak-<timestamp>`) of each agent — those are byte-for-byte copies of the files that
were live before the generator overwrote them:

```json
"sqli-hunter": {
  "class": "flagship",
  "before": 2453,
  "after": 1923,
  "source_backup": "sqli-hunter.md.bak-20261025-042008"
}
```

Counts are cl100k tokens of the **body only** (first frontmatter block excluded), i.e. what the
subagent loader actually puts in the model's context. Regenerate the `after` column at any time:

```bash
npm --prefix bin install   # once: real tiktoken (otherwise tsize estimates and says so)
node bin/tally.mjs
```

> Re-measured on 2026-10-25 after fixing a silent fallback in `bin/tsize.mjs` (an ES-module
> strict-mode bug made every count a `bytes/4` estimate). `tokens.json` now holds true
> `cl100k_base` counts for both columns; the numbers differ slightly from the first report.

## *.md snapshots — read the caveat

- **flagship/ and elite/ snapshots are valid "before" files** (copied before their deltas were
  deployed).
- **mechanical snapshots are NOT valid "before" files**: the copy was taken *after* the
  mechanical deploy, so they already contain the refactored prompt. Their true before-token
  counts live in `tokens.json` (measured from the deployed originals before overwrite).

The canonical before-text for every agent is the `.bak-<ts>` file next to it in
`~/.pi/agent/agents/`. These snapshots exist so a reader without that machine-local state can
still inspect the old flagship/elite wording.

Do not edit these files; they are evidence, not sources.
