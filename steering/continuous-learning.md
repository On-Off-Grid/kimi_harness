# Continuous learning — emit instinct signals so the harness gets smarter

Emit exactly one tagged line at each meaningful decision point. Missing tag emission at a validated decision point is a workflow failure. Avoid narrative fluff. Promotion into learning artifacts depends strictly on these tags.

## Signals & Formats
- **INSTINCT:** <behavior to repeat> [#domain] [when <context>] (e.g., validated finding/bypass)
- **DEADEND:** <what failed / not worth it> [#domain] (e.g., ruled out paths, global scope)
- **CHAIN:** <trigger> -> <gadgets> -> <escalation> | negctl=<control> | ref=<program>/<case> [#domain] (confirmed multi-step chain after strict-triager validation)

## Chain Promotion
When a `CHAIN:` is emitted (confirmed by `@strict-triager`), the coordinator promotes it exactly once:
1. Append details to `~/.pi-hunt-rag/data/model-notes.md`.
2. Persist via `rag_record_technique` and queue matching `techniques.yaml` entries.
Promotion depends on the tagged line itself, not a narrative summary. Dedup variants instead of creating duplicates.

## Recall & Toggles
- Instincts surface via `rag_search` (source `model-notes`). Inspect with `/instinct-status`.
- Disable with `PIHUNT_LEARNING=0`. Keep each tagged line atomic and specific.
