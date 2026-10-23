# pi-hunt RAG + Knowledge Graph

Semantic retrieval layer for the pi-hunt bug-bounty stack. It makes four bodies
of knowledge **searchable by meaning** (not just substring), so the coordinator
and every specialist subagent can recall how to attack a class, find prior work
on a program, and reuse hard-won heuristics.

## What's indexed

| source | what it is | how it gets there |
|--------|-----------|-------------------|
| `techniques` | curated techniques top hunters use, per vuln class (SSRF→IMDS, OAuth ATO, IDOR/BOLA, race, cache, RCE, XSS, smuggling, takeover, LLM, recon, triage) | `techniques/techniques.yaml` |
| `memory` | the **Memory MCP knowledge graph** (`memory.jsonl`) — every entity becomes a semantic chunk | auto from the live graph |
| `findings` | your **past report folders** (title + description + impact + triage verdict) | scans `~/**/reports/**` |
| `model-notes` | reusable heuristics the **model records for future hunts** | `~/.pi-hunt-rag/data/model-notes.md` |

## Architecture (fits the box: numpy + sqlite3, no torch/faiss/chroma)

```
text ──► embedder.py ──► 256-d vector ──► store.py (SQLite BLOB) ──► numpy cosine ──► top-k
            │
            ├─ model2vec potion-base-8M   (real static semantics, ~30MB, CPU/numpy, no torch)
            └─ hashed char-ngram fallback (zero download, always works offline)
```

- **Vectorization**: `pihunt_rag/embedder.py`. Prefers model2vec (local snapshot at
  `~/.pi-hunt-rag/data/hf/potion-base-8M`); transparently falls back to a pure-numpy
  hashed n-gram embedding if the model isn't present. The active backend + dim are
  stored in the DB; a backend change is detected and asks for a `reindex` instead of
  silently mixing vector spaces.
- **Store**: `pihunt_rag/store.py`. One SQLite DB (`~/.pi-hunt-rag/data/rag.db`),
  embeddings as float32 BLOBs, exact cosine via a single numpy matmul (sub-ms at our
  scale). Filter by `source`, `kind`, `program`.
- **Ingest**: `pihunt_rag/ingest.py`. Idempotent per source (stable chunk ids).
- **CLI**: `pihunt_rag/cli.py` → `pihunt-rag` wrapper on PATH.
- **MCP server**: `mcp-servers/pihunt-rag-mcp/server.mjs` (zero-dep Node stdio JSON-RPC),
  deployed to `~/opencode/pihunt-rag-mcp/server.mjs`, wired into `~/.kiro/settings/mcp.json`.

## Install

```bash
./rag/install-rag.sh              # venv + model + MCP server + wire mcp.json + build index
./rag/install-rag.sh --no-model   # skip the 30MB model; use hashed-ngram fallback
./rag/install-rag.sh --dry-run    # show actions, change nothing
```

## CLI usage

```bash
pihunt-rag search "ssrf reaching cloud metadata" -k 5
pihunt-rag search "oauth account takeover" --source techniques
pihunt-rag search "what did I find on datacamp" --program datacamp --source findings
pihunt-rag stats
pihunt-rag ingest                 # rebuild everything
pihunt-rag ingest --source memory # refresh just the knowledge graph
pihunt-rag reindex                # force full rebuild (after embedder change)

# record a heuristic for future hunts (also indexed immediately):
pihunt-rag record "## Prefer write BOLA over read" "Write BOLA scores higher; always try PUT/PATCH/DELETE with a foreign id, not just GET."

# add a structured entity to the Memory graph + index it:
pihunt-rag graph-add "acme|api.acme.com|idor|authn|rest" finding-candidate "PATCH /orders/{id} accepts foreign id" "negative control: other tenant 403 on GET"
```

## MCP tools (available to pi + every subagent after a pi restart)

- `rag_search { query, k?, source?, kind?, program? }` — semantic recall
- `rag_record_technique { title, body }` — persist a learned heuristic for future use
- `rag_graph_add { name, entityType, observations[] }` — add to the knowledge graph + index
- `rag_ingest { source? }` — re-index
- `rag_stats {}` — backend, dim, counts

## How it plugs into the hunt workflow

- **At hunt start / per surface**: `rag_search` the vuln class to load top-hacker
  techniques, signals, and pitfalls before testing.
- **Recall prior work**: `rag_search --program <handle>` surfaces your past findings and
  recon for that target (dedupe, re-use chains).
- **Persist learning**: when a hunt teaches a reusable trick, `rag_record_technique`; when
  a concrete lead is found, `rag_graph_add` (mirrors the existing Memory MCP discipline,
  and now it's semantically retrievable).
- The Memory MCP graph stays the live write target; this RAG indexes it for meaning-based
  recall on top of the substring `search_nodes`.

## Maintenance

- After editing `techniques.yaml`: `pihunt-rag ingest --source techniques`.
- After many new findings: `pihunt-rag ingest --source findings`.
- The Memory graph is re-indexed automatically by `rag_graph_add`; bulk external edits →
  `pihunt-rag ingest --source memory`.
- Re-running `ingest` for a source fully replaces that source's chunks (no duplicates).
