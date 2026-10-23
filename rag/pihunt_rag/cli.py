"""
cli.py — command line for the pi-hunt RAG.

  pihunt-rag ingest                 # (re)build the whole index from all sources
  pihunt-rag ingest --source memory # refresh one source
  pihunt-rag reindex                # force full rebuild (use after backend change)
  pihunt-rag search "query" [-k 8] [--source techniques] [--kind technique] [--program x] [--json]
  pihunt-rag stats
  pihunt-rag record "## Title" "body text"   # append a model note and index it
  pihunt-rag graph-add NAME TYPE OBS...       # add an entity to the Memory MCP graph + index
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .embedder import get_embedder
from .ingest import (MODEL_NOTES, MEMORY_JSONL, ingest_all, ingest_findings,
                     ingest_memory, ingest_model_notes, ingest_techniques)
from .store import VectorStore


def _ingest_one(store, source):
    fn = {"techniques": ingest_techniques, "memory": ingest_memory,
          "findings": ingest_findings, "model-notes": ingest_model_notes}.get(source)
    if not fn:
        sys.exit(f"unknown source '{source}'")
    return {source: fn(store)}


def cmd_ingest(args):
    store = VectorStore()
    res = _ingest_one(store, args.source) if args.source else ingest_all(store)
    print(json.dumps(res, indent=2))
    print(json.dumps(store.stats(), indent=2))


def cmd_reindex(args):
    store = VectorStore()
    # backend may have changed; reset meta to current backend then rebuild
    eb = get_embedder()
    store.db.execute("DELETE FROM chunks")
    store.db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('backend',?)", (eb.name,))
    store.db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('dim',?)", (str(eb.dim),))
    store.db.commit()
    store._cache = None
    print(json.dumps(ingest_all(store), indent=2))
    print(json.dumps(store.stats(), indent=2))


def cmd_search(args):
    store = VectorStore()
    hits = store.search(args.query, k=args.k, source=args.source,
                        kind=args.kind, program=args.program)
    if args.json:
        print(json.dumps(hits, indent=2))
        return
    if not hits:
        print("(no results)")
        return
    for h in hits:
        print(f"\n[{h['score']:.3f}] {h['source']}/{h['kind']}  {h.get('title') or h.get('ref')}")
        if h.get("program"):
            print(f"    program: {h['program']}")
        if h.get("ref"):
            print(f"    ref: {h['ref']}")
        snippet = " ".join(h["text"].split())[:400]
        print(f"    {snippet}")


def cmd_stats(args):
    print(json.dumps(VectorStore().stats(), indent=2))


def cmd_record(args):
    title = args.title if args.title.startswith("#") else f"## {args.title}"
    block = f"\n\n{title}\n{args.body}\n"
    MODEL_NOTES.parent.mkdir(parents=True, exist_ok=True)
    with open(MODEL_NOTES, "a") as f:
        f.write(block)
    n = ingest_model_notes(VectorStore())
    print(f"recorded note + reindexed model-notes ({n} chunks): {title}")


def cmd_graph_add(args):
    """Append an entity to the Memory MCP JSONL graph and index it for search."""
    entity = {"type": "entity", "name": args.name,
              "entityType": args.entity_type, "observations": args.obs}
    MEMORY_JSONL.parent.mkdir(parents=True, exist_ok=True)
    with open(MEMORY_JSONL, "a") as f:
        f.write(json.dumps(entity, ensure_ascii=False) + "\n")
    n = ingest_memory(VectorStore())
    print(f"added entity '{args.name}' to graph + reindexed memory ({n} chunks)")


def cmd_session_add(args):
    """Persist a cross-session summary into the RAG (source='session'), program-keyed."""
    import hashlib, time
    from .ingest import _sid
    store = VectorStore()
    prog = (args.key or "default").lower()
    cid = _sid("session", prog, args.title, hashlib.blake2b(args.body.encode(), digest_size=6).hexdigest())
    store.upsert([{
        "id": cid, "source": "session", "kind": "session-summary",
        "program": prog, "ref": args.cwd or prog, "title": args.title,
        "text": f"{args.title}\n{args.body}", "metadata": {"cwd": args.cwd, "ts": time.time()},
    }])
    # cap retention: keep newest N session summaries per key
    keep = int(args.keep or 12)
    rows = store.db.execute(
        "SELECT id FROM chunks WHERE source='session' AND program=? ORDER BY updated DESC", (prog,)
    ).fetchall()
    if len(rows) > keep:
        old = [r[0] for r in rows[keep:]]
        store.db.executemany("DELETE FROM chunks WHERE id=?", [(i,) for i in old])
        store.db.commit(); store._cache = None
    print(f"session summary stored for '{prog}' (id {cid[:8]}); retained newest {keep}")


def cmd_wordlist_add(args):
    """Index a curated wordlist into the RAG (source='wordlist') so the model can
    semantically find the right list for a tech stack / vuln context. Stores the
    list's PATH + metadata + a sample (not the whole list)."""
    import hashlib, os
    from .ingest import _sid
    store = VectorStore()
    path = args.path
    lines = total = 0; sample = ""
    if os.path.isfile(path):
        try:
            with open(path, errors="replace") as f:
                head = []
                for i, ln in enumerate(f):
                    total += 1
                    if i < 40: head.append(ln.rstrip("\n"))
            sample = "\n".join(head)
        except Exception:
            pass
    tags = args.tags or ""
    title = args.title or os.path.basename(path)
    text = (f"WORDLIST: {title}\nPath: {path}\nContext/tags: {tags}\n"
            f"Use-case: {args.use or ''}\nEntries: {total}\n"
            f"Source: {args.origin or 'local'}\nSample terms:\n{sample}")
    cid = _sid("wordlist", path)
    store.upsert([{
        "id": cid, "source": "wordlist", "kind": "wordlist",
        "program": (args.program or "").lower() or None, "ref": path, "title": title,
        "text": text, "metadata": {"path": path, "entries": total, "tags": tags,
                                    "use": args.use, "origin": args.origin},
    }])
    print(f"indexed wordlist '{title}' ({total} entries) -> {path}")


def cmd_payload_add(args):
    """Index a payload set into the RAG (source='payload') so a hunter can pull the
    right payloads for a vuln class + exact context (sink/filter/WAF/framework).
    Stores PATH + class + context tags + a representative sample of the payloads."""
    import os
    from .ingest import _sid
    store = VectorStore()
    path = args.path
    total = 0; sample = ""
    if os.path.isfile(path):
        try:
            head = []
            with open(path, errors="replace") as f:
                for i, ln in enumerate(f):
                    total += 1
                    if i < 60:
                        head.append(ln.rstrip("\n"))
            sample = "\n".join(head)
        except Exception:
            pass
    vclass = (args.vclass or "").lower()
    tags = args.tags or ""
    title = args.title or os.path.basename(path)
    text = (f"PAYLOADS: {title}\nClass: {vclass}\nContext/tags: {tags}\n"
            f"Use-case: {args.use or ''}\nCount: {total}\nPath: {path}\n"
            f"Source: {args.origin or 'local'}\nSample payloads:\n{sample}")
    cid = _sid("payload", path)
    store.upsert([{
        "id": cid, "source": "payload", "kind": f"payload-{vclass or 'generic'}",
        "program": (args.program or "").lower() or None, "ref": path, "title": title,
        "text": text, "metadata": {"path": path, "count": total, "class": vclass,
                                    "tags": tags, "use": args.use, "origin": args.origin},
    }])
    print(f"indexed payloads '{title}' class={vclass or 'generic'} ({total}) -> {path}")


def main(argv=None):
    p = argparse.ArgumentParser(prog="pihunt-rag", description="pi-hunt RAG / knowledge graph")
    sub = p.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("ingest"); pi.add_argument("--source"); pi.set_defaults(fn=cmd_ingest)
    sub.add_parser("reindex").set_defaults(fn=cmd_reindex)

    ps = sub.add_parser("search")
    ps.add_argument("query"); ps.add_argument("-k", type=int, default=8)
    ps.add_argument("--source"); ps.add_argument("--kind"); ps.add_argument("--program")
    ps.add_argument("--json", action="store_true"); ps.set_defaults(fn=cmd_search)

    sub.add_parser("stats").set_defaults(fn=cmd_stats)

    pr = sub.add_parser("record"); pr.add_argument("title"); pr.add_argument("body")
    pr.set_defaults(fn=cmd_record)

    pg = sub.add_parser("graph-add")
    pg.add_argument("name"); pg.add_argument("entity_type"); pg.add_argument("obs", nargs="+")
    pg.set_defaults(fn=cmd_graph_add)

    pw = sub.add_parser("wordlist-add")
    pw.add_argument("--path", required=True, help="path to the wordlist file on disk")
    pw.add_argument("--title", default="")
    pw.add_argument("--tags", default="", help="comma tags, e.g. 'iis,aspx,content-discovery'")
    pw.add_argument("--use", default="", help="when to use it, e.g. 'IIS/.NET dir discovery'")
    pw.add_argument("--origin", default="local", help="seclists|assetnote|github:<repo>|local|generated")
    pw.add_argument("--program", default="")
    pw.set_defaults(fn=cmd_wordlist_add)

    pp = sub.add_parser("payload-add")
    pp.add_argument("--path", required=True, help="path to the payload file on disk")
    pp.add_argument("--vclass", default="", help="vuln class: xss|sqli|ssrf|ssti|lfi|rce|xxe|redirect|...")
    pp.add_argument("--title", default="")
    pp.add_argument("--tags", default="", help="context tags, e.g. 'xss,dom,attr,waf-cloudflare'")
    pp.add_argument("--use", default="", help="when to use, e.g. 'reflected XSS in HTML attribute'")
    pp.add_argument("--origin", default="local", help="seclists|github:<repo>|portswigger|local|generated")
    pp.add_argument("--program", default="")
    pp.set_defaults(fn=cmd_payload_add)

    pse = sub.add_parser("session-add")
    pse.add_argument("--key", required=True, help="program/project key, e.g. session-<cwd-basename>")
    pse.add_argument("--title", required=True)
    pse.add_argument("--body", required=True)
    pse.add_argument("--cwd", default="")
    pse.add_argument("--keep", default="12")
    pse.set_defaults(fn=cmd_session_add)

    args = p.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
