## Payload sourcing (Haddix: pull the LATEST, context-matched — never spray a stale list)

Source payloads in this order, then tailor to the exact sink/parser/filter/framework/WAF:
1. **Curated RAG library first** (fast, offline, context-tagged): `pihunt-rag search "<class> <engine/framework> payloads" --source payload -k 5` (add `--kind payload-<class>` when known). Each hit's `ref` is a real file on disk — read it and pick context-appropriate entries.
2. **Thin/stale library or novel target → fetch fresh** via the curator: `pihunt-payload bootstrap` (one-time per box), or `pihunt-payload github swisskyrepo/PayloadsAllTheThings '<class dir>' --class <class>`, or `pihunt-payload fetch <raw-url> --class <class>`, then re-pull from the RAG.
3. **WAF/parser-specific or brand-new bypasses** → return to the coordinator for `@payload-researcher` (current bypasses for the EXACT stack) and have results written back into the payload library so the next hunt reuses them.
