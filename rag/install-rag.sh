#!/usr/bin/env bash
# =============================================================================
# pi-hunt RAG + knowledge-graph installer
#   * Python venv (reuses system numpy) at ~/.pi-hunt-rag/.venv
#   * model2vec static embeddings (potion-base-8M, ~30MB, CPU/numpy, no torch)
#     with a zero-download hashed-ngram fallback baked into the code
#   * SQLite vector store at ~/.pi-hunt-rag/data/rag.db
#   * Node stdio MCP server -> ~/opencode/pihunt-rag-mcp/server.mjs
#   * Ingests: techniques.yaml, the Memory MCP graph, past report findings,
#     and model-notes.md
#
# Safe to re-run. Usage:  ./install-rag.sh   [--no-model]   [--dry-run]
# =============================================================================
set -uo pipefail
SRC="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
H="$HOME"
RAG_HOME="$H/.pi-hunt-rag"
VENV="$RAG_HOME/.venv"
PY="$VENV/bin/python"
MCP_DST="$H/opencode/pihunt-rag-mcp"
NO_MODEL=0; DRY=0
for a in "$@"; do case "$a" in --no-model) NO_MODEL=1;; --dry-run) DRY=1;; esac; done

c(){ printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok(){ printf '   \033[1;32m✓\033[0m %s\n' "$*"; }
warn(){ printf '   \033[1;33m! %s\033[0m\n' "$*"; }
run(){ if [ "$DRY" = 1 ]; then printf '   [dry] %s\n' "$*"; else eval "$@"; fi; }

c "1/5  python venv (+ numpy via system-site-packages)"
command -v python3 >/dev/null || { warn "python3 required"; exit 1; }
run "mkdir -p '$RAG_HOME/data'"
if [ ! -x "$PY" ]; then run "python3 -m venv --system-site-packages '$VENV'"; fi
run "'$PY' -m pip install -q --upgrade pip"
run "'$PY' -m pip install -q pyyaml numpy"
"$PY" -c "import numpy" 2>/dev/null && ok "numpy present" || warn "numpy missing in venv"

c "2/5  embedding model (model2vec potion-base-8M)"
if [ "$NO_MODEL" = 1 ]; then
  warn "skipping model download (--no-model): RAG will use hashed-ngram fallback"
else
  run "'$PY' -m pip install -q model2vec"
  if [ "$DRY" = 0 ]; then
    HF_HOME="$RAG_HOME/data/hf" "$PY" - <<PY 2>/dev/null && ok "potion-base-8M ready (local snapshot)" || warn "model fetch failed — RAG will fall back to hashed-ngram (offline-OK)"
import os
from model2vec import StaticModel
dst = os.path.join("$RAG_HOME","data","hf","potion-base-8M")
m = StaticModel.from_pretrained(dst if os.path.exists(dst) else "minishlab/potion-base-8M")
if not os.path.exists(dst): m.save_pretrained(dst)
PY
  fi
fi

c "3/5  Node MCP server -> $MCP_DST"
run "mkdir -p '$MCP_DST'"
run "cp -p '$SRC/../mcp-servers/pihunt-rag-mcp/server.mjs' '$MCP_DST/server.mjs'"
ok "server.mjs deployed"

c "4/5  wire MCP server into ~/.pi/agent/mcp.json"
MCPJSON="$H/.pi/agent/mcp.json"
if [ "$DRY" = 0 ] && [ -f "$MCPJSON" ]; then
  PIHUNT_RAG_REPO="$SRC" RAG_HOME="$RAG_HOME" MCP_DST="$MCP_DST" "$PY" - "$MCPJSON" <<'PY' && ok "mcp.json updated" || warn "could not patch mcp.json (add the pihunt-rag block manually)"
import json, os, sys
p=sys.argv[1]; d=json.load(open(p)); srv=d.setdefault("mcpServers",{})
srv["pihunt-rag"]={"command":"node","args":[os.path.join(os.environ["MCP_DST"],"server.mjs")],
  "env":{"PIHUNT_RAG_HOME":os.environ["RAG_HOME"],"PIHUNT_RAG_REPO":os.environ["PIHUNT_RAG_REPO"],
         "NODE_OPTIONS":"--max-old-space-size=128"},"timeout":120000}
json.dump(d,open(p,"w"),indent=2); print("ok")
PY
else
  warn "mcp.json not found or dry-run; skipping wire-up"
fi

c "5/5  build the index"
if [ "$DRY" = 0 ]; then
  PIHUNT_RAG_HOME="$RAG_HOME" HF_HOME="$RAG_HOME/data/hf" PYTHONPATH="$SRC" \
    "$PY" -m pihunt_rag.cli ingest && ok "index built" || warn "ingest failed"
fi

cat <<EOF

-----------------------------------------------------------------------------
 pi-hunt RAG installed$([ "$DRY" = 1 ] && echo ' (dry-run)').

 CLI:   $PY -m pihunt_rag.cli search "ssrf to metadata"
        (or add a wrapper on PATH — see rag/README.md)
 MCP:   tools rag_search / rag_record_technique / rag_graph_add / rag_ingest / rag_stats
        (restart pi so it picks up the new mcp.json server)
-----------------------------------------------------------------------------
EOF
