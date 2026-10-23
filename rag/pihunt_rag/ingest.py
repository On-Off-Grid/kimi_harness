"""
ingest.py — populate the pi-hunt RAG vector store from all knowledge sources.

Sources:
  techniques  : the curated techniques.yaml (what top hackers do, by class)
  memory      : the Memory MCP knowledge graph (memory.jsonl) — every entity
                becomes a searchable chunk, so the graph gets semantic search.
  findings    : past report folders under the hunt dirs (title + description +
                impact + triager verdict) — your own prior work, retrievable.
  model-notes : model-notes.md — techniques/heuristics the model learns and
                wants to reuse in future hunts (append-only via `record`).

Each source is re-ingested idempotently (chunk ids are stable), and a source
can be refreshed independently.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path

import yaml

from .store import VectorStore

RAG_HOME = Path(os.environ.get("PIHUNT_RAG_HOME", str(Path.home() / ".pi-hunt-rag")))
REPO_ROOT = Path(__file__).resolve().parents[1]
TECHNIQUES_YAML = REPO_ROOT / "techniques" / "techniques.yaml"
MODEL_NOTES = RAG_HOME / "data" / "model-notes.md"
MEMORY_JSONL = Path(os.environ.get(
    "MEMORY_FILE_PATH", str(Path.home() / ".config" / "opencode" / "memory" / "memory.jsonl")))

# Where to scan for past findings. Override with PIHUNT_REPORTS_GLOBS (colon-sep).
DEFAULT_REPORT_ROOTS = [
    str(Path.home()),  # findings live in ~/<program>/reports/... and ~/Documents/...
]


def _sid(*parts) -> str:
    return hashlib.blake2b("::".join(str(p) for p in parts).encode(), digest_size=12).hexdigest()


# ---- techniques -----------------------------------------------------------
def ingest_techniques(store: VectorStore) -> int:
    if not TECHNIQUES_YAML.exists():
        print(f"[ingest] no techniques file at {TECHNIQUES_YAML}")
        return 0
    data = yaml.safe_load(TECHNIQUES_YAML.read_text())
    chunks = []
    for t in data.get("techniques", []):
        text = (
            f"{t.get('title','')}\nClass: {t.get('class','')}  "
            f"Severity: {t.get('severity','')}  Payout: {t.get('payout','')}\n"
            f"Tags: {', '.join(t.get('tags', []))}\n"
            f"TECHNIQUE: {t.get('technique','').strip()}\n"
            f"SIGNALS: {t.get('signals','').strip()}\n"
            f"PITFALLS: {t.get('pitfalls','').strip()}\n"
            f"REFS: {', '.join(map(str, t.get('refs', [])))}"
        )
        chunks.append({
            "id": _sid("technique", t["id"]),
            "source": "techniques", "kind": "technique",
            "ref": t["id"], "title": t.get("title"),
            "program": None, "text": text,
            "metadata": {"class": t.get("class"), "severity": t.get("severity"),
                          "tags": t.get("tags", []), "payout": t.get("payout")},
        })
    store.delete_source("techniques")
    return store.upsert(chunks)


# ---- memory graph ---------------------------------------------------------
def ingest_memory(store: VectorStore) -> int:
    if not MEMORY_JSONL.exists():
        print(f"[ingest] no memory graph at {MEMORY_JSONL}")
        return 0
    chunks = []
    for line in MEMORY_JSONL.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except json.JSONDecodeError:
            continue
        if o.get("type") != "entity":
            continue
        name = o.get("name", "")
        obs = o.get("observations", []) or []
        if not obs:
            continue
        program = name.split("|")[0] if "|" in name else None
        text = f"{name} [{o.get('entityType','')}]\n" + "\n".join(f"- {x}" for x in obs)
        chunks.append({
            "id": _sid("memory", name),
            "source": "memory", "kind": o.get("entityType", "entity"),
            "ref": name, "title": name, "program": program,
            "text": text[:8000],
            "metadata": {"entityType": o.get("entityType"), "obs_count": len(obs)},
        })
    store.delete_source("memory")
    return store.upsert(chunks)


# ---- past findings on disk ------------------------------------------------
def _read(p: Path, limit=6000) -> str:
    try:
        return p.read_text(errors="replace")[:limit]
    except Exception:
        return ""


def ingest_findings(store: VectorStore, roots=None) -> int:
    roots = roots or [Path(r) for r in os.environ.get(
        "PIHUNT_REPORT_ROOTS", ":".join(DEFAULT_REPORT_ROOTS)).split(":") if r]
    seen = set()
    chunks = []
    for root in roots:
        root = Path(root)
        if not root.exists():
            continue
        for title in root.glob("**/reports/**/title.txt"):
            d = title.parent
            if d in seen:
                continue
            seen.add(d)
            base = d.name
            if re.search(r"scope|recon-?(load|reload|confirm)|^scope-", base, re.I):
                continue  # skip scope/recon artifacts, keep real findings
            t = _read(title, 300).strip()
            desc = _read(d / "description.md")
            impact = _read(d / "impact.md", 2000)
            resp = _read(d / "response.md", 1500)
            sev = _read(d / "severity.txt", 200).strip()
            weak = _read(d / "weakness.txt", 200).strip()
            if not (t or desc):
                continue
            program = None
            m = re.search(r"/reports/([^/]+)/", str(d))
            if m:
                program = m.group(1)
            text = (f"FINDING: {t}\nProgram: {program}\nSeverity: {sev}\nWeakness: {weak}\n"
                    f"{desc}\nIMPACT: {impact}\nTRIAGE: {resp}")
            chunks.append({
                "id": _sid("finding", str(d)),
                "source": "findings", "kind": "finding",
                "ref": str(d), "title": t, "program": program,
                "text": text[:8000],
                "metadata": {"severity": sev, "weakness": weak, "path": str(d)},
            })
    store.delete_source("findings")
    return store.upsert(chunks)


# ---- model notes ----------------------------------------------------------
def ingest_model_notes(store: VectorStore) -> int:
    if not MODEL_NOTES.exists():
        return 0
    text = MODEL_NOTES.read_text()
    # split on '## ' headings into individual notes
    blocks = re.split(r"\n(?=##\s)", text)
    chunks = []
    for b in blocks:
        b = b.strip()
        if len(b) < 20:
            continue
        title = b.splitlines()[0].lstrip("# ").strip()
        chunks.append({
            "id": _sid("model-note", title, hashlib.blake2b(b.encode(), digest_size=6).hexdigest()),
            "source": "model-notes", "kind": "model-note",
            "ref": str(MODEL_NOTES), "title": title, "program": None,
            "text": b[:6000], "metadata": {},
        })
    store.delete_source("model-notes")
    return store.upsert(chunks)


def ingest_all(store: VectorStore | None = None) -> dict:
    store = store or VectorStore()
    res = {
        "techniques": ingest_techniques(store),
        "memory": ingest_memory(store),
        "findings": ingest_findings(store),
        "model-notes": ingest_model_notes(store),
    }
    return res


if __name__ == "__main__":
    s = VectorStore()
    print(ingest_all(s))
    print(s.stats())
