#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test_websearch.py — verification harness for the kiro-gateway web_search "Path B"
streaming fix.

WHAT IS BEING FIXED
-------------------
The gateway intercepts the model's `web_search` tool call (Path B), runs the Kiro
MCP search, and today emits the raw results as a single `<web_search>...</web_search>`
TEXT block, then ends the turn (`stop_reason: tool_use`). Because pi keeps only
text/thinking and decides continue-vs-stop on the presence of a *client* toolCall
block (never on stop_reason), a headless `pi -p` subagent STOPS right there and
prints the raw dump instead of a synthesized answer.

The patch must make the gateway CONTINUE after the search and stream the model's
final grounded answer as ONE logical assistant message that ends cleanly
(`stop_reason: end_turn`), so pi prints a real answer.

WHAT "CORRECT" LOOKS LIKE (the contract this harness enforces)
--------------------------------------------------------------
Raw SSE for a single streaming /v1/messages request that triggers web_search:
  * exactly one `message_start` and exactly one `message_stop`
  * content-block indices are strictly increasing (monotonic) and never reused
    (non-colliding); every delta/stop references an open block; all blocks closed
    by message_stop
  * AFTER the web_search activity (server_tool_use / web_search_tool_result, or a
    `<web_search>` digest), there is a final `text` block whose content — once the
    `<web_search>...</web_search>` digest is stripped — is a real synthesized answer
    (non-trivial prose and/or the requested ANSWER: marker), NOT just the raw dump
  * the final `stop_reason` is one pi treats as a CLEAN finish: `end_turn`
    (or `stop_sequence`). `tool_use` here is the BUG signature for a single
    logical message.

End-to-end (pi drives the loop): `pi-kiro --mode json -p --no-session "<prompt>"`
must finish with a last assistant message whose text is a real answer derived from
the search — not the raw `<web_search>` dump and not empty.

STYLE: stdlib `urllib` only (matches tools/find-empty-poison.py). No third-party deps.

USAGE
-----
  python3 test_websearch.py                 # run all SSE/regression/edge tests (no e2e)
  python3 test_websearch.py --e2e           # also run the pi-kiro end-to-end test
  python3 test_websearch.py --only validator # run one test by name
  python3 test_websearch.py --list          # list test names
  python3 test_websearch.py --save DIR       # dump raw streams/json to DIR for evidence
  python3 test_websearch.py -n 6 --backoff 3 # retries per request / base backoff secs

EXIT CODE: 0 = all selected tests passed; 1 = at least one failed; 2 = harness/setup error.

The gateway may be under load (504 / "Streaming failed after N attempts"). Every
request retries with exponential backoff and uses small max_tokens.
"""

import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

# --------------------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------------------
GATEWAY = os.environ.get("KIRO_GATEWAY_URL", "http://127.0.0.1:8790").rstrip("/")
ENDPOINT = GATEWAY + "/v1/messages"
API_KEY = os.environ.get("KIRO_PROXY_API_KEY", "dummy")  # x-api-key: dummy works
WIRE_MODEL = os.environ.get("KIRO_TEST_MODEL", "claude-opus-4.8")     # raw /v1/messages
PI_BIN = os.environ.get("PI_BIN", "pi-kiro")
PI_MODEL = os.environ.get("PI_TEST_MODEL", "kiro/claude-opus-4.8:xhigh")  # e2e

# Marker we ask the model to start its final line with — a strong "synthesized" signal.
ANSWER_MARKER = "ANSWER:"

# Retry/backoff knobs (overridable via CLI).
DEFAULT_RETRIES = 6
DEFAULT_BACKOFF = 3.0      # seconds, exponential, capped
BACKOFF_CAP = 30.0
HTTP_TIMEOUT = 150         # seconds per attempt (web_search round-trip can be slow)
PI_TIMEOUT = 300           # seconds for an e2e pi run


# --------------------------------------------------------------------------------------
# SSE transport with retry/backoff
# --------------------------------------------------------------------------------------
def _is_transient_body(status, raw):
    """A 200 with the gateway's JSON error envelope, or any 5xx, is transient."""
    if status and status >= 500:
        return True
    head = (raw or "").lstrip()[:400]
    if not head:
        return True  # empty body == nothing streamed; retry
    # Gateway load envelope: {"detail":"Streaming failed after 5 attempts. ..."}
    if head.startswith("{"):
        try:
            obj = json.loads(raw)
        except Exception:
            obj = None
        if isinstance(obj, dict):
            det = (obj.get("detail") or "") + json.dumps(obj.get("error", ""))
            if "Streaming failed" in det or "try again" in det.lower() or "overload" in det.lower():
                return True
            # Any pure-JSON error object (no SSE) on a stream request is a failure.
            if "type" in obj and obj.get("type") == "error":
                return True
            if "detail" in obj:
                return True
    # An SSE stream that is ONLY an error event is transient.
    if "event: error" in head and "event: message_start" not in (raw or ""):
        return True
    return False


def post_sse(body, retries=DEFAULT_RETRIES, backoff=DEFAULT_BACKOFF, timeout=HTTP_TIMEOUT,
             label="", save_path=None):
    """
    POST a streaming request and return (raw_text, attempts).

    Retries on connection errors, 5xx, and the gateway's "Streaming failed"/empty
    envelopes with exponential backoff. Raises RuntimeError if all attempts are
    transient failures.
    """
    payload = dict(body)
    payload["stream"] = True
    data = json.dumps(payload).encode("utf-8")
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(
                ENDPOINT, data=data,
                headers={
                    "content-type": "application/json",
                    "x-api-key": API_KEY,
                    "anthropic-version": "2023-06-01",
                    "accept": "text/event-stream",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=timeout) as r:
                status = r.getcode()
                raw = r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            status = e.code
            try:
                raw = e.read().decode("utf-8", "replace")
            except Exception:
                raw = ""
            last_err = f"HTTP {status}: {raw[:160]}"
        except (urllib.error.URLError, socket.timeout, ConnectionError, OSError) as e:
            status, raw = None, ""
            last_err = f"{type(e).__name__}: {e}"
        else:
            if not _is_transient_body(status, raw):
                if save_path:
                    _save(save_path, f"{label or 'sse'}.attempt{attempt}.txt", raw)
                return raw, attempt
            last_err = f"transient (status={status}): {(raw or '').strip()[:160]}"

        if attempt < retries:
            delay = min(backoff * (2 ** (attempt - 1)), BACKOFF_CAP)
            print(f"    [{label}] attempt {attempt}/{retries} transient ({last_err}); "
                  f"backoff {delay:.1f}s", file=sys.stderr)
            time.sleep(delay)
    raise RuntimeError(f"[{label}] all {retries} attempts failed; last: {last_err}")


# --------------------------------------------------------------------------------------
# SSE parsing + structural validation
# --------------------------------------------------------------------------------------
def parse_sse(raw):
    """
    Parse an Anthropic SSE byte stream into a list of {event, data} dicts.

    - SSE comment lines (": ...") and 'ping' events are ignored (heartbeats).
    - `data:` JSON is parsed; non-JSON data is kept as a string.
    """
    events = []
    cur_event = None
    data_lines = []

    def flush():
        nonlocal cur_event, data_lines
        if cur_event is None and not data_lines:
            return
        data_str = "\n".join(data_lines).strip()
        obj = None
        if data_str:
            try:
                obj = json.loads(data_str)
            except Exception:
                obj = data_str
        ev = cur_event or (obj.get("type") if isinstance(obj, dict) else None)
        if ev and ev != "ping":
            events.append({"event": ev, "data": obj})
        cur_event, data_lines = None, []

    for line in raw.splitlines():
        if line == "":
            flush()
            continue
        if line.startswith(":"):          # SSE comment / heartbeat
            continue
        if line.startswith("event:"):
            cur_event = line[len("event:"):].strip()
        elif line.startswith("data:"):
            data_lines.append(line[len("data:"):].strip())
    flush()
    return events


def strip_websearch_digest(text):
    """Remove every <web_search>...</web_search> digest block, return the residual."""
    return re.sub(r"<web_search>.*?</web_search>", "", text or "", flags=re.DOTALL)


def classify_answer(text, marker=ANSWER_MARKER):
    """Decide whether `text` is a real synthesized answer vs. just the raw dump."""
    residual = strip_websearch_digest(text).strip()
    nonspace = re.sub(r"\s+", "", residual)
    has_marker = bool(marker) and (marker in residual)
    substantial = len(nonspace) >= 20
    only_dump = (residual == "") and ("<web_search>" in (text or ""))
    return {
        "residual": residual,
        "has_marker": has_marker,
        "substantial": substantial,
        "only_dump": only_dump,
        "is_answer": (has_marker or substantial) and not only_dump,
    }


def validate_stream(raw):
    """
    Structurally validate a single-logical-message SSE stream for pi.

    Returns a dict:
      ok                 : bool (structural well-formedness only)
      errors             : list[str] structural violations
      n_message_start    : int
      n_message_stop     : int
      blocks             : ordered list of {index, type, text}
      stop_reason        : final wire stop_reason (str|None)
      has_server_tool_use, has_web_search_result : bool
      post_search_text   : concatenated text of text-blocks AFTER the last search block
      first_text_after_search_index : int|None
    """
    events = parse_sse(raw)
    errors = []

    n_start = sum(1 for e in events if e["event"] == "message_start")
    n_stop = sum(1 for e in events if e["event"] == "message_stop")
    if n_start != 1:
        errors.append(f"expected exactly 1 message_start, got {n_start}")
    if n_stop != 1:
        errors.append(f"expected exactly 1 message_stop, got {n_stop}")

    # order: message_start first, message_stop last
    ev_names = [e["event"] for e in events]
    if ev_names and ev_names[0] != "message_start":
        errors.append(f"first event is {ev_names[0]!r}, expected message_start")
    if ev_names and ev_names[-1] != "message_stop":
        errors.append(f"last event is {ev_names[-1]!r}, expected message_stop")

    # block index discipline
    started = {}          # index -> type
    order = []            # indices in start order
    open_blocks = set()
    last_started = -1
    blocks = {}           # index -> {"type":..., "text": ...}
    stop_reason = None
    saw_start = False

    for e in events:
        ev, d = e["event"], e["data"]
        if not isinstance(d, dict):
            if ev == "error":
                errors.append(f"stream carried an error event: {str(d)[:160]}")
            continue
        if ev == "message_start":
            saw_start = True
        elif ev == "content_block_start":
            if not saw_start:
                errors.append("content_block_start before message_start")
            idx = d.get("index")
            cb = d.get("content_block") or {}
            btype = cb.get("type")
            if idx in started:
                errors.append(f"colliding content-block index reused: {idx}")
            if idx is None or not isinstance(idx, int):
                errors.append(f"content_block_start missing integer index: {idx!r}")
            else:
                if idx <= last_started:
                    errors.append(f"non-monotonic content-block index: {idx} after {last_started}")
                last_started = max(last_started, idx)
            started[idx] = btype
            order.append(idx)
            open_blocks.add(idx)
            seed = ""
            if btype == "text":
                seed = cb.get("text", "") or ""
            blocks[idx] = {"type": btype, "text": seed}
        elif ev == "content_block_delta":
            idx = d.get("index")
            if idx not in open_blocks:
                errors.append(f"content_block_delta for non-open index {idx}")
            delta = d.get("delta") or {}
            if delta.get("type") == "text_delta":
                blocks.setdefault(idx, {"type": "text", "text": ""})
                blocks[idx]["text"] += delta.get("text", "") or ""
        elif ev == "content_block_stop":
            idx = d.get("index")
            if idx not in open_blocks:
                errors.append(f"content_block_stop for non-open index {idx}")
            else:
                open_blocks.discard(idx)
        elif ev == "message_delta":
            sr = ((d.get("delta") or {}).get("stop_reason"))
            if sr:
                stop_reason = sr
        elif ev == "message_stop":
            if open_blocks:
                errors.append(f"message_stop with unclosed blocks: {sorted(open_blocks)}")

    block_list = [{"index": i, "type": blocks[i]["type"], "text": blocks[i]["text"]}
                  for i in sorted(blocks)]

    has_stu = any(b["type"] == "server_tool_use" for b in block_list)
    has_wsr = any(b["type"] == "web_search_tool_result" for b in block_list)

    # locate the last "search" block (server_tool_use or web_search_tool_result),
    # else fall back to the last text block that contains a <web_search> digest.
    search_idxs = [b["index"] for b in block_list
                   if b["type"] in ("server_tool_use", "web_search_tool_result")]
    if not search_idxs:
        search_idxs = [b["index"] for b in block_list
                       if b["type"] == "text" and "<web_search>" in (b["text"] or "")]
    last_search_idx = max(search_idxs) if search_idxs else None

    post_text = ""
    first_after = None
    for b in block_list:
        if b["type"] != "text":
            continue
        if last_search_idx is None or b["index"] > last_search_idx:
            if first_after is None and (last_search_idx is not None):
                first_after = b["index"]
            post_text += b["text"]
    # If the digest and answer share ONE text block (gateway folds them), include it.
    if last_search_idx is not None and not post_text:
        for b in block_list:
            if b["type"] == "text" and b["index"] == last_search_idx and "<web_search>" in (b["text"] or ""):
                post_text += b["text"]

    return {
        "ok": not errors,
        "errors": errors,
        "events": events,
        "n_message_start": n_start,
        "n_message_stop": n_stop,
        "blocks": block_list,
        "stop_reason": stop_reason,
        "has_server_tool_use": has_stu,
        "has_web_search_result": has_wsr,
        "post_search_text": post_text,
        "first_text_after_search_index": first_after,
    }


# --------------------------------------------------------------------------------------
# Request builders
# --------------------------------------------------------------------------------------
WS_TOOL = {
    "name": "web_search",
    "description": "Search the web for current information. Use when you need up-to-date data.",
    "input_schema": {
        "type": "object",
        "properties": {"query": {"type": "string", "description": "Search query"}},
        "required": ["query"],
    },
}

# A trivial CLIENT tool used to verify a real tool call still works after a search.
CLIENT_TOOL = {
    "name": "record_version",
    "description": "Record a software version string the user asked about.",
    "input_schema": {
        "type": "object",
        "properties": {"version": {"type": "string", "description": "the version, e.g. 3.13.14"}},
        "required": ["version"],
    },
}


def msg(text):
    return [{"role": "user", "content": text}]


def body(messages, tools=None, max_tokens=512):
    b = {"model": WIRE_MODEL, "max_tokens": max_tokens, "messages": messages}
    if tools is not None:
        b["tools"] = tools
    return b


# --------------------------------------------------------------------------------------
# Tests (each returns (name, passed: bool, lines: list[str]))
# --------------------------------------------------------------------------------------
def _fmt_blocks(v):
    return ", ".join(f"{b['index']}:{b['type']}" for b in v["blocks"])


def test_validator(args):
    """(1) Raw-SSE validator: a web_search request must yield a well-formed single
    message ending in a synthesized answer (end_turn), not the raw dump."""
    name = "validator"
    out = []
    b = body(
        msg(f"Search the web for the latest stable Python 3.13.x release version number, "
            f"then reply with exactly one line starting with {ANSWER_MARKER} and the version."),
        tools=[WS_TOOL], max_tokens=512,
    )
    raw, attempts = post_sse(b, retries=args.retries, backoff=args.backoff,
                             label=name, save_path=args.save)
    v = validate_stream(raw)
    out.append(f"attempts={attempts}  blocks=[{_fmt_blocks(v)}]  stop_reason={v['stop_reason']}")

    passed = True
    # structural
    if not v["ok"]:
        passed = False
        out += [f"STRUCT FAIL: {e}" for e in v["errors"]]
    if v["n_message_start"] == 1 and v["n_message_stop"] == 1:
        out.append("PASS exactly one message_start/message_stop")
    else:
        passed = False
    # search actually happened (Path B engaged)
    if v["has_server_tool_use"] or v["has_web_search_result"] or "<web_search>" in (v["post_search_text"] or "") \
       or any("<web_search>" in (b2["text"] or "") for b2 in v["blocks"] if b2["type"] == "text"):
        out.append("PASS web_search path engaged (server_tool_use/result or <web_search> present)")
    else:
        passed = False
        out.append("FAIL web_search path did NOT engage — prompt did not trigger a search")
    # final synthesized answer AFTER the search
    ans = classify_answer(v["post_search_text"])
    if ans["is_answer"]:
        out.append(f"PASS final synthesized answer present (marker={ans['has_marker']}, "
                   f"prose_len={len(ans['residual'])}): {ans['residual'][:160]!r}")
    else:
        passed = False
        out.append("FAIL no synthesized answer after search "
                   f"(only_dump={ans['only_dump']}); post_search_text[:200]="
                   f"{(v['post_search_text'] or '')[:200]!r}")
    # clean finish
    if v["stop_reason"] in ("end_turn", "stop_sequence"):
        out.append(f"PASS clean finish stop_reason={v['stop_reason']}")
    else:
        passed = False
        out.append(f"FAIL stop_reason={v['stop_reason']!r} is not a clean finish "
                   f"(end_turn expected; 'tool_use' is the bug signature)")
    return name, passed, out


def test_regression(args):
    """(3) Regression: a normal request with NO web_search must be a clean, well-formed
    single message with NO server-tool/web_search blocks and end_turn."""
    name = "regression_no_search"
    out = []
    b = body(msg(f"Reply with exactly one line starting with {ANSWER_MARKER} and the word PONG. "
                 f"Do not search."), tools=None, max_tokens=40)
    raw, attempts = post_sse(b, retries=args.retries, backoff=args.backoff,
                             label=name, save_path=args.save)
    v = validate_stream(raw)
    out.append(f"attempts={attempts}  blocks=[{_fmt_blocks(v)}]  stop_reason={v['stop_reason']}")

    passed = v["ok"]
    if not v["ok"]:
        out += [f"STRUCT FAIL: {e}" for e in v["errors"]]
    if v["n_message_start"] == 1 and v["n_message_stop"] == 1:
        out.append("PASS single well-formed message")
    else:
        passed = False
    if v["has_server_tool_use"] or v["has_web_search_result"]:
        passed = False
        out.append("FAIL web_search blocks leaked into a non-search request")
    else:
        out.append("PASS no server_tool_use / web_search_tool_result blocks")
    if any("<web_search>" in (b2["text"] or "") for b2 in v["blocks"] if b2["type"] == "text"):
        passed = False
        out.append("FAIL <web_search> digest leaked into a non-search request")
    else:
        out.append("PASS no <web_search> digest in text")
    if v["stop_reason"] in ("end_turn", "stop_sequence"):
        out.append(f"PASS clean finish stop_reason={v['stop_reason']}")
    else:
        passed = False
        out.append(f"FAIL stop_reason={v['stop_reason']!r}")
    # answer present (model complied)
    txt = "".join(b2["text"] for b2 in v["blocks"] if b2["type"] == "text")
    if txt.strip():
        out.append(f"PASS non-empty answer: {txt.strip()[:80]!r}")
    else:
        passed = False
        out.append("FAIL empty answer")
    return name, passed, out


def test_no_results(args):
    """(4a) Edge: a query that returns no/!useful results must still produce a
    well-formed single message ending end_turn (graceful, no malformed stream)."""
    name = "edge_no_results"
    out = []
    nonsense = "zzqxwv-" + "kqjxzv9w8e7r6t5y4u3i2o1p-nonexistent-term-" * 2
    b = body(
        msg(f"Search the web for '{nonsense}'. If there are no useful results, reply with "
            f"exactly one line starting with {ANSWER_MARKER} NO_RESULTS."),
        tools=[WS_TOOL], max_tokens=300,
    )
    raw, attempts = post_sse(b, retries=args.retries, backoff=args.backoff,
                             label=name, save_path=args.save)
    v = validate_stream(raw)
    out.append(f"attempts={attempts}  blocks=[{_fmt_blocks(v)}]  stop_reason={v['stop_reason']}")
    passed = v["ok"] and v["n_message_start"] == 1 and v["n_message_stop"] == 1
    if not v["ok"]:
        out += [f"STRUCT FAIL: {e}" for e in v["errors"]]
    else:
        out.append("PASS well-formed single message")
    if v["stop_reason"] in ("end_turn", "stop_sequence"):
        out.append(f"PASS clean finish stop_reason={v['stop_reason']}")
    else:
        passed = False
        out.append(f"FAIL stop_reason={v['stop_reason']!r} (must finish cleanly even with no results)")
    # We do NOT require a "good" answer here — only that the stream is well-formed and
    # does not hang or end on the raw dump with a dangling tool_use.
    ans = classify_answer(v["post_search_text"])
    out.append(f"note: synthesized_answer={ans['is_answer']} only_dump={ans['only_dump']} "
               f"residual[:120]={ans['residual'][:120]!r}")
    return name, passed, out


def test_back_to_back(args):
    """(4b) Edge: a prompt needing TWO searches must still be ONE well-formed logical
    message with a final synthesized answer and end_turn."""
    name = "edge_back_to_back"
    out = []
    b = body(
        msg("First search the web for the latest stable Python 3.13.x version, then search "
            "the web for the latest stable Node.js LTS version. Then reply with exactly one "
            f"line starting with {ANSWER_MARKER} that gives BOTH version numbers."),
        tools=[WS_TOOL], max_tokens=600,
    )
    raw, attempts = post_sse(b, retries=args.retries, backoff=args.backoff,
                             label=name, save_path=args.save)
    v = validate_stream(raw)
    out.append(f"attempts={attempts}  blocks=[{_fmt_blocks(v)}]  stop_reason={v['stop_reason']}")
    passed = v["ok"]
    if not v["ok"]:
        out += [f"STRUCT FAIL: {e}" for e in v["errors"]]
    if not (v["n_message_start"] == 1 and v["n_message_stop"] == 1):
        passed = False
        out.append("FAIL not exactly one logical message")
    else:
        out.append("PASS exactly one logical message across multiple searches")
    ans = classify_answer(v["post_search_text"])
    if ans["is_answer"]:
        out.append(f"PASS synthesized answer present: {ans['residual'][:160]!r}")
    else:
        passed = False
        out.append(f"FAIL no synthesized answer (only_dump={ans['only_dump']})")
    if v["stop_reason"] in ("end_turn", "stop_sequence"):
        out.append(f"PASS clean finish stop_reason={v['stop_reason']}")
    else:
        passed = False
        out.append(f"FAIL stop_reason={v['stop_reason']!r}")
    return name, passed, out


def test_search_then_tool(args):
    """(4c) Edge: a search followed by a REAL client tool call. The fix must NOT swallow
    a genuine client tool_use. Here a legitimate finish is stop_reason=tool_use WITH a
    client tool_use block for `record_version` (pi would execute it and continue)."""
    name = "edge_search_then_client_tool"
    out = []
    b = body(
        msg("Search the web for the latest stable Python 3.13.x version number. Once you "
            "know it, call the record_version tool with that version. Do not answer in text."),
        tools=[WS_TOOL, CLIENT_TOOL], max_tokens=400,
    )
    raw, attempts = post_sse(b, retries=args.retries, backoff=args.backoff,
                             label=name, save_path=args.save)
    v = validate_stream(raw)
    out.append(f"attempts={attempts}  blocks=[{_fmt_blocks(v)}]  stop_reason={v['stop_reason']}")
    passed = v["ok"] and v["n_message_start"] == 1 and v["n_message_stop"] == 1
    if not v["ok"]:
        out += [f"STRUCT FAIL: {e}" for e in v["errors"]]
    # Did a real client tool_use block for record_version appear?
    tool_blocks = [b2 for b2 in v["blocks"] if b2["type"] == "tool_use"]
    has_client_tool = bool(tool_blocks)
    if has_client_tool and v["stop_reason"] == "tool_use":
        out.append("PASS real client tool_use emitted with stop_reason=tool_use "
                   "(pi will execute record_version and continue — correct)")
    elif v["stop_reason"] in ("end_turn", "stop_sequence") and classify_answer(v["post_search_text"])["is_answer"]:
        # Acceptable alternative: model answered in text instead of calling the tool.
        out.append("PASS model synthesized a text answer instead of calling the tool "
                   "(acceptable; stop_reason clean)")
    else:
        passed = False
        out.append(f"FAIL neither a client tool_use (+tool_use stop) nor a clean text answer; "
                   f"stop_reason={v['stop_reason']!r} tool_blocks={len(tool_blocks)}")
    out.append("note: this test guards against the fix swallowing genuine client tool calls.")
    return name, passed, out


# --------------------------------------------------------------------------------------
# (2) End-to-end via pi-kiro --mode json
# --------------------------------------------------------------------------------------
def parse_pi_json(stdout):
    """
    Extract the final assistant message text + stopReason from `pi --mode json` NDJSON.

    Envelope (verified): line 1 = {"type":"session",...}; then agent_start/turn_start/
    message_*; final {"type":"agent_end","messages":[...]}. We take the last agent_end,
    then the last role=='assistant' message, joining its text blocks. Fallbacks:
    last turn_end.message, then last assistant message_end.
    """
    events = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except Exception:
            continue

    def text_of(message):
        if not isinstance(message, dict):
            return ""
        return "".join(c.get("text", "") for c in (message.get("content") or [])
                       if isinstance(c, dict) and c.get("type") == "text")

    # primary: last agent_end -> last assistant message
    for e in reversed(events):
        if e.get("type") == "agent_end":
            assts = [m for m in (e.get("messages") or []) if m.get("role") == "assistant"]
            if assts:
                return text_of(assts[-1]), assts[-1].get("stopReason"), len(assts), len(events)
    # fallback: last turn_end / message_end with assistant
    for e in reversed(events):
        if e.get("type") in ("turn_end", "message_end"):
            m = e.get("message") or {}
            if m.get("role") == "assistant":
                return text_of(m), m.get("stopReason"), 1, len(events)
    return "", None, 0, len(events)


def run_pi_e2e(prompt, retries, backoff, save_path=None, label="e2e"):
    """Run pi-kiro --mode json -p --no-session, with retry on transient/empty output."""
    if shutil.which(PI_BIN) is None:
        raise RuntimeError(f"{PI_BIN} not found on PATH")
    cmd = [PI_BIN, "--model", PI_MODEL, "--mode", "json", "-p", "--no-session", prompt]
    last = ""
    for attempt in range(1, retries + 1):
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=PI_TIMEOUT)
        except subprocess.TimeoutExpired:
            last = "pi timed out"
            if attempt < retries:
                time.sleep(min(backoff * (2 ** (attempt - 1)), BACKOFF_CAP))
            continue
        out = proc.stdout or ""
        if save_path:
            _save(save_path, f"{label}.attempt{attempt}.ndjson", out)
            _save(save_path, f"{label}.attempt{attempt}.stderr.txt", proc.stderr or "")
        text, stop_reason, n_assist, n_events = parse_pi_json(out)
        # transient if pi produced no events or errored before any assistant text
        if n_events <= 2 or (not text and stop_reason in (None, "error", "aborted")):
            last = f"empty/failed run (events={n_events}, stop={stop_reason})"
            if attempt < retries:
                d = min(backoff * (2 ** (attempt - 1)), BACKOFF_CAP)
                print(f"    [{label}] attempt {attempt}/{retries} {last}; backoff {d:.1f}s",
                      file=sys.stderr)
                time.sleep(d)
            continue
        return {"text": text, "stop_reason": stop_reason, "n_assistant": n_assist,
                "n_events": n_events, "attempts": attempt, "raw": out}
    raise RuntimeError(f"[{label}] all {retries} pi runs failed; last: {last}")


def test_e2e(args):
    """(2) End-to-end: pi must finish with a real synthesized answer derived from the
    search, not the raw <web_search> dump and not empty."""
    name = "e2e_pi_json"
    out = []
    prompt = (f"Search the web for the latest stable Python 3.13.x release version number, "
              f"then reply with exactly one line starting with {ANSWER_MARKER} and the version.")
    res = run_pi_e2e(prompt, retries=args.retries, backoff=args.backoff,
                     save_path=args.save, label=name)
    text = res["text"]
    out.append(f"attempts={res['attempts']}  events={res['n_events']}  "
               f"assistant_msgs={res['n_assistant']}  stopReason={res['stop_reason']}")
    out.append(f"final assistant text[:200]={text[:200]!r}")

    passed = True
    if not text.strip():
        passed = False
        out.append("FAIL final assistant text is EMPTY")
    if res["stop_reason"] in ("error", "aborted"):
        passed = False
        out.append(f"FAIL pi finished with stopReason={res['stop_reason']}")
    ans = classify_answer(text)
    if ans["only_dump"]:
        passed = False
        out.append("FAIL final text is ONLY the raw <web_search> dump (the bug)")
    elif ans["is_answer"]:
        out.append(f"PASS real synthesized answer (marker={ans['has_marker']}, "
                   f"prose_len={len(ans['residual'])}): {ans['residual'][:160]!r}")
    else:
        passed = False
        out.append(f"FAIL no synthesized answer; residual[:160]={ans['residual'][:160]!r}")
    # Strong recommended signal
    if ANSWER_MARKER in text and ANSWER_MARKER in ans["residual"]:
        out.append(f"PASS contains {ANSWER_MARKER} marker outside any dump")
    else:
        out.append(f"WARN {ANSWER_MARKER} marker not found outside dump (soft check)")
    return name, passed, out


# --------------------------------------------------------------------------------------
# Runner
# --------------------------------------------------------------------------------------
ALL_TESTS = {
    "validator": test_validator,
    "regression_no_search": test_regression,
    "edge_no_results": test_no_results,
    "edge_back_to_back": test_back_to_back,
    "edge_search_then_client_tool": test_search_then_tool,
    "e2e_pi_json": test_e2e,            # only when --e2e
}
SSE_TESTS = ["validator", "regression_no_search", "edge_no_results",
             "edge_back_to_back", "edge_search_then_client_tool"]


def _save(dirpath, name, content):
    try:
        os.makedirs(dirpath, exist_ok=True)
        with open(os.path.join(dirpath, name), "w", encoding="utf-8") as f:
            f.write(content)
    except Exception as e:
        print(f"    [save] could not write {name}: {e}", file=sys.stderr)


def preflight():
    """Confirm the gateway is reachable before running (clear setup error if not)."""
    try:
        req = urllib.request.Request(GATEWAY + "/health", headers={"x-api-key": API_KEY})
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.getcode() == 200
    except Exception as e:
        print(f"PREFLIGHT: gateway health check failed at {GATEWAY}/health: {e}", file=sys.stderr)
        return False


def main():
    ap = argparse.ArgumentParser(description="kiro-gateway web_search Path B fix verifier")
    ap.add_argument("--e2e", action="store_true", help="also run the pi-kiro end-to-end test")
    ap.add_argument("--only", help="run a single test by name (see --list)")
    ap.add_argument("--list", action="store_true", help="list test names and exit")
    ap.add_argument("--save", help="directory to dump raw streams / pi json for evidence")
    ap.add_argument("-n", "--retries", type=int, default=DEFAULT_RETRIES,
                    help=f"retries per request (default {DEFAULT_RETRIES})")
    ap.add_argument("--backoff", type=float, default=DEFAULT_BACKOFF,
                    help=f"base backoff seconds (default {DEFAULT_BACKOFF})")
    args = ap.parse_args()

    if args.list:
        for k in ALL_TESTS:
            tag = " (needs --e2e)" if k == "e2e_pi_json" else ""
            print(f"  {k}{tag}")
        return 0

    if args.only:
        if args.only not in ALL_TESTS:
            print(f"unknown test {args.only!r}; use --list", file=sys.stderr)
            return 2
        selected = [args.only]
    else:
        selected = list(SSE_TESTS) + (["e2e_pi_json"] if args.e2e else [])

    if not preflight():
        print("Gateway not reachable — aborting (start it with: pi-kiro, or "
              "cd kiro-gateway && python main.py --port 8790).", file=sys.stderr)
        return 2

    print(f"# kiro-gateway web_search verifier")
    print(f"# endpoint={ENDPOINT}  wire_model={WIRE_MODEL}  pi_model={PI_MODEL}")
    print(f"# retries={args.retries} backoff={args.backoff}s  save={args.save or '-'}\n")

    results = []
    for tname in selected:
        print(f"== {tname} ==")
        try:
            name, passed, lines = ALL_TESTS[tname](args)
        except Exception as e:
            name, passed, lines = tname, False, [f"ERROR: {type(e).__name__}: {e}"]
        for ln in lines:
            print(f"   {ln}")
        print(f"   -> {'PASS' if passed else 'FAIL'}\n")
        results.append((name, passed))

    print("================ SUMMARY ================")
    width = max(len(n) for n, _ in results)
    for n, p in results:
        print(f"  {n.ljust(width)}  {'PASS' if p else 'FAIL'}")
    n_pass = sum(1 for _, p in results if p)
    print(f"  {'-' * (width + 8)}")
    print(f"  {n_pass}/{len(results)} passed")
    return 0 if n_pass == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
