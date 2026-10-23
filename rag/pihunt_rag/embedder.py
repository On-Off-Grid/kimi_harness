"""
embedder.py — pluggable text embedding for the pi-hunt RAG.

Priority order (first that works wins), so the system is offline-first and
never hard-fails:

  1. model2vec StaticModel (potion-base-8M) — real static semantic embeddings,
     pure-numpy inference, ~30MB, no torch. Loaded from the local snapshot in
     $PIHUNT_RAG_HOME/data/hf/potion-base-8M when present.
  2. Hashed character n-gram TF vector — zero dependencies beyond numpy, zero
     download. Lower quality but always available; keeps search working on a
     fresh box before any model is fetched.

The active backend and its dimension are recorded so the vector store can
detect a backend change and trigger a re-index instead of mixing spaces.
"""
from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

import numpy as np

RAG_HOME = Path(os.environ.get("PIHUNT_RAG_HOME", str(Path.home() / ".pi-hunt-rag")))
_LOCAL_MODEL = RAG_HOME / "data" / "hf" / "potion-base-8M"
_HASH_DIM = 1024  # fallback vector dimension

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _normalize(text: str) -> str:
    return (text or "").lower().strip()


def _l2(mat: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(mat, axis=-1, keepdims=True)
    n[n == 0] = 1.0
    return mat / n


class _Model2VecBackend:
    name = "model2vec:potion-base-8M"

    def __init__(self) -> None:
        from model2vec import StaticModel  # lazy import

        src = str(_LOCAL_MODEL) if _LOCAL_MODEL.exists() else "minishlab/potion-base-8M"
        self._m = StaticModel.from_pretrained(src)
        self.dim = int(self._m.encode(["probe"]).shape[1])

    def encode(self, texts: list[str]) -> np.ndarray:
        vecs = np.asarray(self._m.encode([_normalize(t) for t in texts]), dtype=np.float32)
        return _l2(vecs)


class _HashedNGramBackend:
    """Char 3/4/5-gram + word unigram hashed into a fixed vector. numpy only."""

    name = "hashed-ngram"

    def __init__(self, dim: int = _HASH_DIM) -> None:
        self.dim = dim

    def _feats(self, text: str):
        t = _normalize(text)
        for w in _TOKEN_RE.findall(t):
            yield f"w:{w}"
        s = re.sub(r"\s+", " ", t)
        for n in (3, 4, 5):
            for i in range(len(s) - n + 1):
                yield s[i : i + n]

    def encode(self, texts: list[str]) -> np.ndarray:
        out = np.zeros((len(texts), self.dim), dtype=np.float32)
        for r, text in enumerate(texts):
            for f in self._feats(text):
                h = int.from_bytes(hashlib.blake2b(f.encode(), digest_size=8).digest(), "little")
                idx = h % self.dim
                sign = 1.0 if (h >> 63) & 1 else -1.0
                out[r, idx] += sign
        return _l2(out)


_BACKEND = None


def get_embedder(force_fallback: bool = False):
    global _BACKEND
    if _BACKEND is not None:
        return _BACKEND
    if not force_fallback:
        try:
            _BACKEND = _Model2VecBackend()
            return _BACKEND
        except Exception as e:  # noqa: BLE001
            print(f"[embedder] model2vec unavailable ({type(e).__name__}: {str(e)[:80]}); "
                  f"falling back to hashed-ngram")
    _BACKEND = _HashedNGramBackend()
    return _BACKEND


def embed(texts: list[str], force_fallback: bool = False) -> np.ndarray:
    if isinstance(texts, str):
        texts = [texts]
    return get_embedder(force_fallback).encode(texts)


if __name__ == "__main__":
    eb = get_embedder()
    v = embed(["SSRF to cloud metadata", "stored XSS via display name", "OAuth open redirect token theft"])
    print(f"backend={eb.name} dim={eb.dim} shape={v.shape}")
    # quick sanity: semantically close pair should beat a random pair
    a = embed(["server side request forgery against 169.254.169.254"])[0]
    b = embed(["SSRF reaching the AWS metadata endpoint"])[0]
    c = embed(["reflected cross site scripting in the search box"])[0]
    print(f"cos(ssrf,ssrf)={float(a@b):.3f}  cos(ssrf,xss)={float(a@c):.3f}")
