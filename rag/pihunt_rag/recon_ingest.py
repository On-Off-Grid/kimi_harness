"""
recon_ingest.py — ingest a program's structured-recon artifacts into the RAG.

Called by recon-engine.sh after each run:  python -m pihunt_rag.recon_ingest <program> <recon_dir>

Produces compact, semantically-searchable chunks under source="recon", keyed by
program, so the model can ask e.g. "live hosts and tech for acme" or "new
subdomains and takeover candidates" and pull the current recon state. Large
lists are summarized + bucketed (not dumped) to keep the vector store lean; the
full files stay on disk and each chunk's `ref` points at them.

Re-running replaces this program's recon chunks (delete-by-prefix then upsert),
so the index always reflects the latest run.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

from .store import VectorStore
from .ingest import _sid


def _read(p: Path, limit_lines=400):
    try:
        lines = p.read_text(errors="replace").splitlines()
    except Exception:
        return [], 0
    return lines[:limit_lines], len(lines)


def _sample(lines, n=60):
    return "\n".join(lines[:n])


def ingest_recon(program: str, recon_dir: str, store: VectorStore | None = None) -> dict:
    store = store or VectorStore()
    d = Path(recon_dir)
    if not d.exists():
        return {"error": f"recon dir not found: {recon_dir}"}

    prog = program.lower()
    # remove this program's prior recon chunks (delete by id prefix via source+program)
    store.db.execute("DELETE FROM chunks WHERE source='recon' AND program=?", (prog,))
    store.db.commit()
    store._cache = None

    chunks = []

    def add(name, kind, title, text, ref):
        chunks.append({
            "id": _sid("recon", prog, name),
            "source": "recon", "kind": kind, "program": prog,
            "ref": ref, "title": title, "text": text[:8000],
            "metadata": {"program": prog, "artifact": name},
        })

    # manifest (the index pointer)
    man = d / "manifest.md"
    if man.exists():
        add("manifest", "recon-manifest", f"{program} recon manifest (latest run)",
            f"Recon manifest for program {program}.\n" + man.read_text(errors="replace"),
            str(man))

    # subdomains (all + live + NEW)
    for fname, kind, label in [
        ("subdomains_all.txt", "recon-subdomains", "all known subdomains"),
        ("subdomains_live.txt", "recon-live-hosts", "live HTTP hosts"),
        ("NEW_subdomains_all.txt", "recon-new", "NEW subdomains since last run"),
        ("NEW_subdomains_live.txt", "recon-new", "NEW live hosts since last run"),
    ]:
        f = d / fname
        lines, total = _read(f)
        if total:
            add(fname, kind, f"{program}: {label} ({total})",
                f"{program} {label} — {total} entries (full list: {f}).\n"
                f"Sample:\n{_sample(lines, 80)}", str(f))

    # wide-scope infra (Haddix): owned ASN/IP-space, cloud-cert SAN harvest, ports
    f = d / "owned_cidrs.txt"
    lines, total = _read(f)
    if total:
        add("owned_cidrs.txt", "recon-infra", f"{program}: owned IP ranges / ASN CIDRs ({total})",
            f"{program} owned IP space (ASN/CIDR) — {total} ranges (full: {f}). "
            f"Pivot: port-scan these for non-cloud assets, reverse-DNS, cert SANs.\n" + "\n".join(lines[:120]), str(f))
    f = d / "cloud_cert_names.txt"
    lines, total = _read(f, limit_lines=5000)
    if total:
        add("cloud_cert_names.txt", "recon-infra", f"{program}: cloud TLS cert names (CN/SAN) ({total})",
            f"{program} hostnames harvested from TLS certs on owned/cloud IP ranges ({total}) — new apex/subdomain leads.\n"
            + "\n".join(lines[:150]), str(f))
    for pf in ("ports.txt", "ports_passive.txt"):
        f = d / pf
        lines, total = _read(f, limit_lines=4000)
        if total:
            add(pf, "recon-ports", f"{program}: open ports / services ({total})",
                f"{program} open ports/services from {pf} ({total}) — non-80/443 services are high-signal.\n"
                + "\n".join(lines[:150]), str(f))
            break

    # resolved DNS + takeover
    f = d / "takeover_candidates.txt"
    lines, total = _read(f)
    if total:
        add("takeover_candidates.txt", "recon-takeover",
            f"{program}: subdomain-takeover candidates ({total})",
            f"{program} dangling-CNAME / takeover candidates ({total}). Verify provider-specific claimability before reporting.\n"
            + "\n".join(lines[:60]), str(f))

    # tech stack / live host table
    f = d / "tech-stack.md"
    if f.exists():
        add("tech-stack.md", "recon-tech", f"{program}: tech stack + live host table",
            f"{program} live hosts with status/title/tech/server/CDN.\n" + f.read_text(errors="replace")[:7000],
            str(f))

    # urls (bucketed by interesting extensions/keywords)
    f = d / "urls.txt"
    lines, total = _read(f, limit_lines=20000)
    if total:
        interesting = [u for u in lines if any(k in u.lower() for k in
                       ("api", "admin", "graphql", "upload", "redirect", "callback",
                        "token", "oauth", "debug", "internal", "config", ".json", "=" ))][:120]
        add("urls.txt", "recon-urls", f"{program}: collected URLs ({total})",
            f"{program} collected URLs — {total} total (full: {f}). High-signal sample:\n"
            + "\n".join(interesting), str(f))

    # params
    f = d / "params.txt"
    lines, total = _read(f, limit_lines=5000)
    if total:
        add("params.txt", "recon-params", f"{program}: discovered parameters ({total})",
            f"{program} discovered request parameters ({total}) — test for IDOR/SSRF/injection/redirect.\n"
            + ", ".join(lines[:300]), str(f))

    # content discovery
    f = d / "content_discovery.txt"
    lines, total = _read(f, limit_lines=3000)
    if total:
        add("content_discovery.txt", "recon-content", f"{program}: content discovery hits ({total})",
            f"{program} ffuf content-discovery hits ({total}).\n" + "\n".join(lines[:150]), str(f))

    # js secrets
    f = d / "js_secrets.txt"
    lines, total = _read(f)
    if total:
        add("js_secrets.txt", "recon-secrets", f"{program}: JS secret/endpoint signals ({total})",
            f"{program} secret/endpoint signals mined from JS ({total}) — VALIDATE each before reporting.\n"
            + "\n".join(lines[:80]), str(f))

    n = store.upsert(chunks)
    return {"program": prog, "recon_chunks": n, "artifacts": len(chunks)}


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: python -m pihunt_rag.recon_ingest <program> <recon_dir>")
        sys.exit(1)
    print(ingest_recon(sys.argv[1], sys.argv[2]))
