#!/usr/bin/env python3
"""
find-empty-poison.py — locate the EXACT content that makes opus-4.8 (via the kiro
gateway) return an empty completion.

Root cause (proven 2026-06-18, deterministic gateway replay + bisection): opus-4.8
returns zero-output completions when the request context carries long, high-entropy
OPAQUE TOKENS (base64url / JWT / hex / signed-URL / error blobs) in tool_result or
large tool_use bodies. The effect is cumulative and worsens with repeated copies.
A ~430-char browser_live `errorId=` blob duplicated across two page-list results gave
5/5 empty; eliding it gave 0/5; same length but low-entropy ('AAAA') gave 0/5.

This script does two things:

  1. SCAN (default): statically scan a captured request body for the high-entropy
     opaque tokens that are the likely poison, ranked by risk. No network needed.
     Works on a kiro_debug capture dir, a request_body.json, or any Anthropic-style
     messages JSON.

  2. BISECT (--bisect): actively confirm by replaying against the gateway. Replays
     the request as-is (expects empty), then re-tests with each suspect token elided
     to prove which one(s) flip it to OK. Requires the gateway running.

Usage:
  find-empty-poison.py <path>                 # scan a request_body.json or capture dir
  find-empty-poison.py --latest               # scan newest empty capture in /tmp/kiro_debug
  find-empty-poison.py <path> --bisect        # confirm by replay against the gateway
  find-empty-poison.py --latest --bisect -n 5 # replay each variant 5x

Exit code 0 = scan/bisect completed; 2 = no suspects found; 3 = input error.
"""
import argparse
import copy
import glob
import json
import math
import os
import re
import sys
import urllib.request

GATEWAY = os.environ.get("KIRO_GATEWAY_URL", "http://127.0.0.1:8790") + "/v1/messages"
DEBUG_DIR = os.environ.get("DEBUG_DIR", "/tmp/kiro_debug")

# Same opaque-run detector the gateway sanitizer uses (kept in sync intentionally).
OPAQUE_CHARS = r"[A-Za-z0-9_\-/+=.]"


def shannon_entropy(s: str) -> float:
    if not s:
        return 0.0
    counts = {}
    for ch in s:
        counts[ch] = counts.get(ch, 0) + 1
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in counts.values())


def looks_opaque(tok: str) -> bool:
    has_upper = any(c.isupper() for c in tok)
    has_lower = any(c.islower() for c in tok)
    has_digit = any(c.isdigit() for c in tok)
    classes = sum((has_upper, has_lower, has_digit))
    if tok.count(".") == 2 and all(seg and len(seg) >= 8 for seg in tok.split(".")):
        return True  # JWT
    return classes >= 2 and shannon_entropy(tok) >= 3.5


def iter_text_blocks(messages):
    """Yield (msg_index, block_kind, setter) for every text-bearing block so we can
    read and (for bisect) rewrite content in place."""
    for i, m in enumerate(messages):
        c = m.get("content")
        if isinstance(c, str):
            yield i, "text", ("str", None)
        elif isinstance(c, list):
            for j, b in enumerate(c):
                if not isinstance(b, dict):
                    continue
                t = b.get("type")
                if t in ("text", "thinking"):
                    yield i, t, ("block", j)
                elif t == "tool_result":
                    yield i, "tool_result", ("block", j)
                elif t == "tool_use":
                    yield i, "tool_use", ("block", j)


def block_text(messages, i, ref):
    kind, j = ref
    m = messages[i]
    if kind == "str":
        return m.get("content", "")
    b = m["content"][j]
    t = b.get("type")
    if t == "text":
        return b.get("text", "")
    if t == "thinking":
        return b.get("thinking", b.get("text", ""))
    if t == "tool_result":
        cc = b.get("content", "")
        return cc if isinstance(cc, str) else json.dumps(cc)
    if t == "tool_use":
        return json.dumps(b.get("input", {}))
    return ""


def find_suspects(messages):
    """Return ranked list of suspect opaque tokens across all messages."""
    candidate_re = re.compile(OPAQUE_CHARS + "{40,}")
    seen = {}  # token -> dict(count, locations, entropy, len)
    for i, kind, ref in iter_text_blocks(messages):
        text = block_text(messages, i, ref)
        if not text:
            continue
        for mtok in candidate_re.finditer(text):
            tok = mtok.group(0)
            if not looks_opaque(tok):
                continue
            rec = seen.setdefault(
                tok,
                {"token": tok, "len": len(tok), "entropy": round(shannon_entropy(tok), 2),
                 "count": 0, "locations": []},
            )
            rec["count"] += 1
            rec["locations"].append(f"msg[{i}].{kind}")
    suspects = list(seen.values())
    # Risk score: longer + more copies + higher entropy = more likely poison.
    for s in suspects:
        s["risk"] = round(s["len"] * s["count"] * (s["entropy"] / 6.0), 1)
    suspects.sort(key=lambda s: s["risk"], reverse=True)
    return suspects


def orphan_tool_uses(messages):
    """Detect tool_use blocks with no matching tool_result (a SEPARATE empty trigger:
    compaction can cut mid-pair). Returns list of orphaned ids."""
    pending = {}
    for i, m in enumerate(messages):
        for b in (m.get("content") or []):
            if isinstance(b, dict):
                if b.get("type") == "tool_use":
                    pending[b.get("id")] = i
                elif b.get("type") == "tool_result":
                    pending.pop(b.get("tool_use_id"), None)
    return [(tid, idx) for tid, idx in pending.items()]


def load_request(path):
    if os.path.isdir(path):
        for name in ("request_body.json", "kiro_request_body.json"):
            p = os.path.join(path, name)
            if os.path.isfile(p):
                path = p
                break
        else:
            raise FileNotFoundError(f"no request_body.json in {path}")
    with open(path) as f:
        data = json.load(f)
    if "messages" not in data:
        raise ValueError(f"{path} has no 'messages' (not an Anthropic request body)")
    return data, path


def latest_empty_capture():
    """Find the newest kiro_debug capture whose app_logs show an empty completion."""
    best = None
    for d in sorted(glob.glob(os.path.join(DEBUG_DIR, "req_*")), key=os.path.getmtime, reverse=True):
        lg = os.path.join(d, "app_logs.txt")
        if os.path.isfile(lg):
            try:
                txt = open(lg, errors="replace").read()
            except OSError:
                continue
            if "Empty completion" in txt or "emitted placeholder" in txt:
                return d
            if best is None:
                best = d
    return best


def elide_in_request(data, token, keep=12):
    out = copy.deepcopy(data)
    marker = f"{token[:keep]}\u2026<ELIDED>\u2026{token[-keep:]}"
    def fix(s):
        return s.replace(token, marker) if isinstance(s, str) else s
    for m in out.get("messages", []):
        c = m.get("content")
        if isinstance(c, str):
            m["content"] = fix(c)
        elif isinstance(c, list):
            for b in c:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text" and isinstance(b.get("text"), str):
                    b["text"] = fix(b["text"])
                elif b.get("type") == "tool_result" and isinstance(b.get("content"), str):
                    b["content"] = fix(b["content"])
                elif b.get("type") == "tool_use":
                    b["input"] = json.loads(fix(json.dumps(b.get("input", {}))))
    return out


def replay(data, n=3):
    """Replay request n times; return (empties, total)."""
    body = copy.deepcopy(data)
    body["stream"] = False
    body.setdefault("max_tokens", 300)
    empties = 0
    for _ in range(n):
        req = urllib.request.Request(
            GATEWAY, data=json.dumps(body).encode(),
            headers={"content-type": "application/json", "x-api-key": "dummy"},
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                resp = json.load(r)
        except Exception as e:  # noqa
            print(f"    replay error: {e}", file=sys.stderr)
            continue
        c = resp.get("content", [])
        txt = "".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
        tc = [b for b in c if isinstance(b, dict) and b.get("type") == "tool_use"]
        empty = (len(txt.strip()) == 0 or txt.strip() in ("(no output)", "(empty placeholder)")) and not tc
        if empty:
            empties += 1
    return empties, n


def main():
    ap = argparse.ArgumentParser(description="Locate the exact content causing opus-4.8 empty completions.")
    ap.add_argument("path", nargs="?", help="request_body.json or a kiro_debug capture dir")
    ap.add_argument("--latest", action="store_true", help="scan newest empty capture in $DEBUG_DIR")
    ap.add_argument("--bisect", action="store_true", help="confirm by replaying against the gateway")
    ap.add_argument("-n", type=int, default=3, help="replays per variant in --bisect (default 3)")
    ap.add_argument("--top", type=int, default=10, help="show top N suspects (default 10)")
    args = ap.parse_args()

    if args.latest:
        path = latest_empty_capture()
        if not path:
            print(f"no captures in {DEBUG_DIR}", file=sys.stderr)
            return 3
        print(f"[latest empty capture] {path}")
    elif args.path:
        path = args.path
    else:
        ap.print_help()
        return 3

    try:
        data, resolved = load_request(path)
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        return 3

    messages = data["messages"]
    print(f"[loaded] {resolved}")
    print(f"[messages] {len(messages)} | model={data.get('model','?')}")

    # Orphaned tool_use check (independent empty trigger).
    orphans = orphan_tool_uses(messages)
    if orphans:
        print(f"\n⚠ ORPHANED tool_use (no matching tool_result) — a SEPARATE empty trigger:")
        for tid, idx in orphans:
            print(f"    msg[{idx}] tool_use id={tid}  (compaction likely cut mid-pair)")

    suspects = find_suspects(messages)
    if not suspects:
        print("\nNo high-entropy opaque-token suspects found.")
        if orphans:
            print("But orphaned tool_use present — fix pairing (that is the likely cause).")
            return 0
        print("The empty may be caused by something else; widen the scan or use --bisect.")
        return 2

    print(f"\n[suspects] {len(suspects)} high-entropy opaque token(s), ranked by risk:")
    print(f"  {'risk':>8}  {'len':>5}  {'copies':>6}  {'entropy':>7}  locations / preview")
    for s in suspects[: args.top]:
        prev = s["token"][:24] + "…" + s["token"][-8:]
        locs = ",".join(s["locations"][:4]) + ("…" if len(s["locations"]) > 4 else "")
        print(f"  {s['risk']:>8}  {s['len']:>5}  {s['count']:>6}  {s['entropy']:>7}  {locs}")
        print(f"            ↳ {prev}")

    if not args.bisect:
        print("\nRe-run with --bisect to CONFIRM which suspect flips the result (needs gateway up).")
        return 0

    # Active confirmation.
    print(f"\n[bisect] replaying against {GATEWAY} ({args.n}x each)…")
    base_empty, base_n = replay(data, args.n)
    print(f"  baseline (as captured): {base_empty}/{base_n} empty")
    if base_empty == 0:
        print("  baseline did NOT reproduce empty — gateway may already be eliding it,")
        print("  or the trigger is load-dependent. Try more -n, or disable ELIDE_HIGH_ENTROPY_TOKENS to repro.")
        return 0
    confirmed = []
    for s in suspects[: args.top]:
        variant = elide_in_request(data, s["token"])
        e, n = replay(variant, args.n)
        flipped = e < base_empty
        tag = "  <<< POISON (eliding this FIXES it)" if e == 0 else ("  (reduces empties)" if flipped else "")
        print(f"  elide {s['token'][:20]}… (len {s['len']}, x{s['count']}): {e}/{n} empty{tag}")
        if e == 0:
            confirmed.append(s)
    print()
    if confirmed:
        print(f"✅ CONFIRMED POISON ({len(confirmed)}): eliding the following makes the request complete:")
        for s in confirmed:
            print(f"    len={s['len']} copies={s['count']} entropy={s['entropy']} @ {','.join(s['locations'][:6])}")
            print(f"      token: {s['token']}")
        print("\nThe gateway's ELIDE_HIGH_ENTROPY_TOKENS handles these automatically once enabled.")
    else:
        print("No single suspect fully fixed it — the empty is likely CUMULATIVE across several.")
        print("Try eliding the top-K together, or lower ELIDE_HIGH_ENTROPY_MIN_LEN in the gateway.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
