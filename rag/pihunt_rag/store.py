"""
store.py — SQLite-backed vector store for the pi-hunt RAG.

Design choices (fit the box: numpy + stdlib sqlite3, no faiss/chroma, 12G disk):
  * One SQLite DB at $PIHUNT_RAG_HOME/data/rag.db.
  * Each chunk row stores: id, source, kind, ref (path/url/entity), title,
    text, metadata (JSON), and the embedding as a float32 BLOB.
  * Search loads the embedding matrix once (cached, invalidated on writes) and
    does exact cosine via a single numpy matmul. At our scale (thousands of
    chunks) this is sub-millisecond and far simpler than an ANN index.
  * A `meta` table records the embedding backend + dim. If the active embedder
    differs from what the DB was built with, search refuses to mix spaces and
    asks for a reindex.

The store is generic: techniques, past findings, recon notes, and the Memory
MCP graph all land here as `chunks` with a `kind` discriminator.
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path

import numpy as np

from .embedder import embed, get_embedder

RAG_HOME = Path(os.environ.get("PIHUNT_RAG_HOME", str(Path.home() / ".pi-hunt-rag")))
DB_PATH = Path(os.environ.get("PIHUNT_RAG_DB", str(RAG_HOME / "data" / "rag.db")))

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS chunks (
    id        TEXT PRIMARY KEY,
    source    TEXT NOT NULL,           -- techniques | findings | recon | memory | model-notes | manual
    kind      TEXT NOT NULL,           -- technique | finding | note | playbook | model-note ...
    ref       TEXT,                    -- file path, url, or memory entity name
    program   TEXT,                    -- optional program handle
    title     TEXT,
    text      TEXT NOT NULL,
    metadata  TEXT,                    -- JSON blob
    dim       INTEGER NOT NULL,
    vec       BLOB NOT NULL,           -- float32 little-endian
    updated   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_source  ON chunks(source);
CREATE INDEX IF NOT EXISTS idx_chunks_kind    ON chunks(kind);
CREATE INDEX IF NOT EXISTS idx_chunks_program ON chunks(program);
"""


class VectorStore:
    def __init__(self, path: Path | str = DB_PATH):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(self.path))
        self.db.executescript(_SCHEMA)
        self.db.commit()
        self._cache = None  # (ids, mat)
        eb = get_embedder()
        self._set_meta_if_absent("backend", eb.name)
        self._set_meta_if_absent("dim", str(eb.dim))

    # ---- meta -------------------------------------------------------------
    def _set_meta_if_absent(self, k, v):
        cur = self.db.execute("SELECT value FROM meta WHERE key=?", (k,)).fetchone()
        if cur is None:
            self.db.execute("INSERT INTO meta(key,value) VALUES(?,?)", (k, v))
            self.db.commit()

    def get_meta(self, k):
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (k,)).fetchone()
        return row[0] if row else None

    def backend_matches(self) -> bool:
        return self.get_meta("backend") == get_embedder().name

    # ---- writes -----------------------------------------------------------
    def upsert(self, chunks: list[dict]) -> int:
        """chunks: dicts with id, source, kind, text, and optional ref/program/title/metadata."""
        if not chunks:
            return 0
        eb = get_embedder()
        vecs = embed([c["text"] for c in chunks])
        now = time.time()
        rows = []
        for c, v in zip(chunks, vecs):
            rows.append((
                c["id"], c["source"], c.get("kind", "note"), c.get("ref"),
                c.get("program"), c.get("title"), c["text"],
                json.dumps(c.get("metadata", {}), ensure_ascii=False),
                eb.dim, np.asarray(v, dtype=np.float32).tobytes(), now,
            ))
        self.db.executemany(
            "INSERT OR REPLACE INTO chunks"
            "(id,source,kind,ref,program,title,text,metadata,dim,vec,updated)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?)", rows)
        self.db.commit()
        self._cache = None
        return len(rows)

    def delete_source(self, source: str) -> int:
        n = self.db.execute("DELETE FROM chunks WHERE source=?", (source,)).rowcount
        self.db.commit()
        self._cache = None
        return n

    # ---- search -----------------------------------------------------------
    def _load_matrix(self, where_sql="", params=()):
        q = "SELECT id, vec FROM chunks"
        if where_sql:
            q += " WHERE " + where_sql
        rows = self.db.execute(q, params).fetchall()
        if not rows:
            return [], np.zeros((0, 1), dtype=np.float32)
        ids = [r[0] for r in rows]
        mat = np.stack([np.frombuffer(r[1], dtype=np.float32) for r in rows])
        return ids, mat

    def search(self, query: str, k: int = 8, source: str | None = None,
               kind: str | None = None, program: str | None = None) -> list[dict]:
        if not self.backend_matches():
            raise RuntimeError(
                f"embedding backend changed (db={self.get_meta('backend')} "
                f"now={get_embedder().name}); run `pihunt-rag reindex`")
        clauses, params = [], []
        if source:
            clauses.append("source=?"); params.append(source)
        if kind:
            clauses.append("kind=?"); params.append(kind)
        if program:
            clauses.append("program=?"); params.append(program)
        where = " AND ".join(clauses)
        ids, mat = self._load_matrix(where, tuple(params))
        if not ids:
            return []
        qv = embed([query])[0].astype(np.float32)
        sims = mat @ qv  # all vectors are L2-normalized => dot == cosine
        top = np.argsort(-sims)[:k]
        out = []
        for i in top:
            cid = ids[int(i)]
            row = self.db.execute(
                "SELECT source,kind,ref,program,title,text,metadata FROM chunks WHERE id=?",
                (cid,)).fetchone()
            out.append({
                "id": cid, "score": float(sims[int(i)]),
                "source": row[0], "kind": row[1], "ref": row[2], "program": row[3],
                "title": row[4], "text": row[5],
                "metadata": json.loads(row[6] or "{}"),
            })
        return out

    def stats(self) -> dict:
        cur = self.db.execute("SELECT source, COUNT(*) FROM chunks GROUP BY source").fetchall()
        return {
            "db": str(self.path),
            "backend": self.get_meta("backend"),
            "dim": self.get_meta("dim"),
            "total": self.db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0],
            "by_source": {s: n for s, n in cur},
        }
