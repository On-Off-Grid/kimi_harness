# TEST PLAN — kiro-gateway `web_search` "Path B" streaming fix

Verification design for the gateway change that makes server-side `web_search`
**continue after the search and stream the model's final grounded answer as one
logical message**, instead of ending the turn on the raw `<web_search>` dump.

- Target: Anthropic `/v1/messages` SSE proxy at `http://127.0.0.1:8790` (`x-api-key: dummy`).
- Harness: `/tmp/websearch-fix/test_websearch.py` (stdlib `urllib` only, matches
  the repo's `tools/find-empty-poison.py` style).
- Status of this document: every request/parse path below was exercised LIVE against
  the current (pre-patch) gateway on 2026-06-18. The bug reproduces deterministically,
  and the harness correctly flags it. See "Live pre-patch baseline" at the end.

---

## 1. The bug, precisely

A headless `pi -p` subagent (e.g. `deep-research`) asks for a web search, the
gateway runs it (Path B), and today the gateway emits the results as a single
`text` block wrapped in `<web_search>...</web_search>` and ends the turn with
wire `stop_reason: tool_use`. pi then **stops** and prints the raw dump.

Why pi stops (from `RE-pi-loop.md`, verified against the installed pi build):

- pi's Anthropic client **drops** `server_tool_use` and `web_search_tool_result`
  blocks entirely — only `text` and `thinking` survive into the stored message.
- pi's agent loop decides continue-vs-stop **solely on the presence of a client
  `toolCall` block**, never on `stop_reason`. A `tool_use` stop with no client
  tool block is treated exactly like `end_turn`: the loop stops.
- So the only content that reaches the user is the `<web_search>` text dump, and
  the run ends with no synthesized answer.

### What "correct" looks like (the contract this plan enforces)

For a single streaming `/v1/messages` request that triggers a web search, the SSE
stream must be **one well-formed logical message** such that:

1. **Exactly one** `message_start` and **exactly one** `message_stop`.
2. Content-block indices are **strictly increasing (monotonic)** and **never
   reused (non-colliding)**; every `content_block_delta`/`content_block_stop`
   refers to a block that was opened; all blocks are closed before `message_stop`.
3. The web-search activity happens first (either real `server_tool_use` +
   `web_search_tool_result` blocks, and/or a `<web_search>` digest in text).
4. **AFTER** the search activity there is a final `text` block that — once any
   `<web_search>...</web_search>` digest is stripped — contains a **real
   synthesized answer**: non-trivial prose and/or the requested `ANSWER:` line,
   **not** just the raw results dump and **not** empty.
5. The final wire `stop_reason` is one pi treats as a **clean finish**:
   `end_turn` (or `stop_sequence`). `tool_use` for a single logical message is the
   **bug signature** here (there is no client tool block, so it just makes pi stop).

End-to-end, `pi --mode json -p --no-session "<prompt>"` must finish with a last
assistant message whose joined `text` is that synthesized answer.

> Note on the digest: the fix MAY keep a `<web_search>` digest for transparency,
> but it MUST be followed by a real answer. The harness strips the digest and
> asserts on the *residual*, so "digest + answer in one block" and "digest block
> then a separate answer block" both pass; "digest only" fails.

---

## 2. Test inventory

| # | Test name (harness)             | Type        | Pre-patch | Post-patch (target) |
|---|---------------------------------|-------------|-----------|---------------------|
| 1 | `validator`                     | raw SSE     | **FAIL**  | PASS                |
| 2 | `e2e_pi_json`                   | end-to-end  | **FAIL**  | PASS                |
| 3 | `regression_no_search`          | regression  | PASS      | PASS (unchanged)    |
| 4a| `edge_no_results`               | edge        | **FAIL**  | PASS                |
| 4b| `edge_back_to_back`             | edge        | **FAIL**  | PASS                |
| 4c| `edge_search_then_client_tool`  | edge        | varies    | PASS                |

"Pre-patch FAIL" is intentional and desirable: it proves the test detects the bug.
The acceptance gate is **all PASS after the patch** (with `regression_no_search`
having stayed PASS the whole time).

---

## 3. Running it

```bash
# SSE + regression + edges (no pi process needed):
python3 /tmp/websearch-fix/test_websearch.py --save /tmp/websearch-fix/evidence

# include the pi-kiro end-to-end test:
python3 /tmp/websearch-fix/test_websearch.py --e2e --save /tmp/websearch-fix/evidence

# one test at a time / list them:
python3 /tmp/websearch-fix/test_websearch.py --only validator
python3 /tmp/websearch-fix/test_websearch.py --list

# tune for load (more retries, bigger backoff):
python3 /tmp/websearch-fix/test_websearch.py -n 8 --backoff 4 --e2e
```

Environment overrides: `KIRO_GATEWAY_URL`, `KIRO_PROXY_API_KEY` (default `dummy`),
`KIRO_TEST_MODEL` (wire, default `claude-opus-4.8`), `PI_BIN` (default `pi-kiro`),
`PI_TEST_MODEL` (default `kiro/claude-opus-4.8:xhigh`).

Exit code: `0` all selected passed, `1` ≥1 failed, `2` setup error (gateway down,
`pi-kiro` missing).

---

## 4. (1) Raw-SSE validator — design

POST a streaming request with `tools=[web_search]` and a prompt that forces a
search, then assert the contract in §1. The validator is `validate_stream(raw)` +
`classify_answer(text)` in the harness; the test wrapper is `test_validator`.

Request body (built by `body(...)`, `stream` forced True):

```json
{
  "model": "claude-opus-4.8",
  "max_tokens": 512,
  "tools": [{"name":"web_search","description":"Search the web ...",
             "input_schema":{"type":"object",
                             "properties":{"query":{"type":"string"}},
                             "required":["query"]}}],
  "messages": [{"role":"user",
    "content":"Search the web for the latest stable Python 3.13.x release version number, then reply with exactly one line starting with ANSWER: and the version."}]
}
```

`validate_stream` parses SSE robustly (ignores `:`-comment heartbeats and `ping`),
reconstructs blocks, and checks:

- `n_message_start == 1` and `n_message_stop == 1`; first event is `message_start`,
  last is `message_stop`.
- **Monotonic, non-colliding indices**: each `content_block_start.index` is an int,
  strictly greater than the previous max, and never reused; deltas/stops only
  reference open blocks; no unclosed blocks remain at `message_stop`.
- The search engaged (`server_tool_use`/`web_search_tool_result` present, or a
  `<web_search>` digest in a text block).
- `classify_answer(post_search_text)` reports `is_answer == True` — i.e. after
  stripping `<web_search>...</web_search>`, the residual has the `ANSWER:` marker
  or ≥20 non-space chars, and is not "digest only".
- `stop_reason in {end_turn, stop_sequence}`.

**Pass/fail:** PASS iff structural checks hold AND search engaged AND
`is_answer` AND clean `stop_reason`. (Pre-patch this fails on the last two:
`only_dump=True`, `stop_reason=tool_use`.)

The exact runnable Python is in `test_websearch.py` (`post_sse`, `parse_sse`,
`validate_stream`, `classify_answer`, `test_validator`). Key excerpt:

```python
def validate_stream(raw):
    events = parse_sse(raw)
    errors = []
    n_start = sum(1 for e in events if e["event"] == "message_start")
    n_stop  = sum(1 for e in events if e["event"] == "message_stop")
    if n_start != 1: errors.append(f"expected exactly 1 message_start, got {n_start}")
    if n_stop  != 1: errors.append(f"expected exactly 1 message_stop, got {n_stop}")
    # ... monotonic/non-colliding index discipline, open/closed tracking ...
    # ... locate last search block, collect text AFTER it as post_search_text ...
    return {... "stop_reason": stop_reason, "post_search_text": post_text, ...}

def classify_answer(text, marker="ANSWER:"):
    residual = re.sub(r"<web_search>.*?</web_search>", "", text or "", flags=re.DOTALL).strip()
    has_marker  = marker in residual
    substantial = len(re.sub(r"\s+", "", residual)) >= 20
    only_dump   = (residual == "") and ("<web_search>" in (text or ""))
    return {"residual": residual, "has_marker": has_marker, "substantial": substantial,
            "only_dump": only_dump, "is_answer": (has_marker or substantial) and not only_dump}
```

---

## 5. (2) End-to-end via `pi-kiro --mode json` — design

Exact command the harness runs (`run_pi_e2e`):

```bash
pi-kiro --model kiro/claude-opus-4.8:xhigh --mode json -p --no-session \
  "Search the web for the latest stable Python 3.13.x release version number, then reply with exactly one line starting with ANSWER: and the version."
```

`pi --mode json` emits **NDJSON** (one JSON object per line). Verified envelope:

- line 1: `{"type":"session", ...}` (session header)
- then `agent_start`, `turn_start`, `message_start/message_update*/message_end`,
  `turn_end`, and finally `{"type":"agent_end","messages":[...]}`.

**Parser** (`parse_pi_json`): take the **last** `agent_end`, then the **last**
`role=="assistant"` message in its `messages[]`, and join that message's
`content[*].text` blocks. Fallbacks: last `turn_end.message`, then last assistant
`message_end`. It returns `(text, stopReason, n_assistant, n_events)`.

> Mapping note: pi's internal `stopReason` is `"stop"`/`"toolUse"`/`"length"`/
> `"error"`/`"aborted"` (not the raw wire `end_turn`). The e2e test asserts on the
> **answer content** and that `stopReason` is not `error`/`aborted`; the wire
> `stop_reason` is asserted in the raw-SSE tests instead. Pre-patch this run shows
> `stopReason: toolUse` with the raw dump as text.

**Pass/fail (`test_e2e`):** PASS iff final assistant text is non-empty, `stopReason`
∉ {error, aborted}, `classify_answer(text).only_dump == False`, and
`is_answer == True`. A soft `WARN` notes whether `ANSWER:` appears outside the dump.

Transient handling: a pi run with ≤2 events or empty assistant text + error/None
stop is retried with exponential backoff (gateway-under-load tolerance).

---

## 6. (3) Regression — normal request, NO web_search

`test_regression` POSTs a plain streaming request (no `tools`, prompt says "Do not
search") and asserts the stream is the same clean single message as before the
patch:

- well-formed (1 start / 1 stop, monotonic non-colliding indices);
- **no** `server_tool_use`/`web_search_tool_result` blocks;
- **no** `<web_search>` digest leaked into any text block;
- `stop_reason in {end_turn, stop_sequence}`;
- non-empty answer text.

This is the "byte-for-byte unaffected" guard, expressed structurally (exact bytes
vary by model sampling, so we assert structural identity + clean finish + no
search artifacts rather than a literal byte diff). **Must PASS both pre- and
post-patch.** A regression in the fix that makes the gateway inject search into
every turn would flip this to FAIL.

---

## 7. (4) Negative / edge probes

### 4a `edge_no_results` — a query with no useful results
Prompt asks to search a nonsense token and answer `ANSWER: NO_RESULTS` if nothing
useful. **Assert:** the stream is still a well-formed single message ending in a
clean `stop_reason` (no hang, no malformed stream, no dangling `tool_use`). We do
**not** demand a "good" answer here — only graceful, well-formed completion. This
catches a fix that only handles the happy path and crashes/derails on empty
results.

### 4b `edge_back_to_back` — two searches in one turn
Prompt needs a Python version **and** a Node.js version. **Assert:** still exactly
**one** logical message (1 start / 1 stop, monotonic non-colliding indices across
both searches) AND a final synthesized answer AND clean `stop_reason`. This catches
a fix that emits a second `message_start`/`message_stop` (splitting the turn) or
that collides block indices across the second search.

### 4c `edge_search_then_client_tool` — search then a REAL client tool
Tools include `web_search` **and** a trivial client tool `record_version`. Prompt:
search, then call `record_version` with the version (don't answer in text).
**Assert** one of two legitimate outcomes:
- a real client `tool_use` block for `record_version` **with** `stop_reason:
  tool_use` (correct — pi would execute it and continue), **or**
- the model answered in text with a clean `stop_reason` and a synthesized answer.

This is the guard that the fix **does not swallow genuine client tool calls** while
"continuing after search". A fix that force-rewrites every post-search turn to
`end_turn` text would break real tool use and fail here.

---

## 8. Pass/fail criteria — consolidated

A test PASSes only if all its asserts hold; the suite passes iff every selected
test passes (harness exit 0).

| Test | PASS criteria |
|------|---------------|
| `validator` | 1×start/1×stop · monotonic non-colliding indices · all blocks closed · search engaged · `is_answer` on post-search text (digest stripped) · `stop_reason ∈ {end_turn, stop_sequence}` |
| `e2e_pi_json` | final assistant text non-empty · `stopReason ∉ {error,aborted}` · `only_dump == False` · `is_answer == True` (ideally contains `ANSWER:` outside any dump) |
| `regression_no_search` | well-formed single message · no `server_tool_use`/`web_search_tool_result` · no `<web_search>` in text · `stop_reason ∈ {end_turn, stop_sequence}` · non-empty text |
| `edge_no_results` | well-formed single message · `stop_reason ∈ {end_turn, stop_sequence}` (graceful) |
| `edge_back_to_back` | exactly one logical message · `is_answer` on post-search text · clean `stop_reason` |
| `edge_search_then_client_tool` | (client `tool_use` block + `stop_reason: tool_use`) OR (clean `stop_reason` + synthesized text answer) |

### Acceptance gate for shipping the patch
1. `regression_no_search` PASS (was PASS pre-patch — no collateral change).
2. `validator` PASS — raw stream now ends in a synthesized answer with `end_turn`.
3. `e2e_pi_json` PASS — `pi -p` prints a real answer derived from the search.
4. `edge_no_results`, `edge_back_to_back`, `edge_search_then_client_tool` PASS.
5. Re-run the suite ≥3× (load variance); all green each time.

---

## 9. Load tolerance (504s / "Streaming failed after N attempts")

The gateway can be busy. Observed transient shapes: HTTP `504`, or HTTP `200` with
body `{"detail":"Streaming failed after 5 attempts. Unknown error."}`, or an empty
body, or an SSE stream containing only `event: error`. The harness treats all of
these as **transient** and retries with exponential backoff (`post_sse` /
`_is_transient_body`; pi e2e via `run_pi_e2e`). Defaults: 6 retries, base backoff
3s (capped 30s), small `max_tokens` (40–600). Tune with `-n` / `--backoff`. A real
malformed-but-non-transient stream (e.g. two `message_start`s) is **not** retried —
it is a genuine FAIL.

---

## 10. Live pre-patch baseline (evidence captured 2026-06-18)

Run against the current gateway BEFORE the fix, proving the harness discriminates:

```
== validator ==
   blocks=[0:thinking, 1:server_tool_use, 2:web_search_tool_result, 3:text]  stop_reason=tool_use
   PASS exactly one message_start/message_stop
   PASS web_search path engaged
   FAIL no synthesized answer after search (only_dump=True)
   FAIL stop_reason='tool_use' is not a clean finish
   -> FAIL                      # EXPECTED pre-patch

== regression_no_search ==
   blocks=[0:text]  stop_reason=end_turn
   PASS single well-formed message / no search blocks / no digest / end_turn / non-empty
   -> PASS                      # unaffected path

== e2e_pi_json ==
   events=50  assistant_msgs=1  stopReason=toolUse
   final text = '\n<web_search>\nSearch results for "latest stable Python 3.13 ...'
   FAIL final text is ONLY the raw <web_search> dump (the bug)
   -> FAIL                      # EXPECTED pre-patch

== edge_no_results ==
   blocks=[0:thinking,1:server_tool_use,2:web_search_tool_result,3:text]  stop_reason=tool_use
   PASS well-formed single message
   FAIL stop_reason='tool_use' (must finish cleanly even with no results)
   -> FAIL                      # EXPECTED pre-patch
```

The raw stream block order today is `thinking → server_tool_use →
web_search_tool_result → text(<web_search> dump)`, ending `</web_search>\n` with
wire `stop_reason: tool_use`. After the fix, the final `text` must instead be a
synthesized answer and the stream must end `end_turn` (the digest may remain before
the answer). When the fix lands, re-run `python3 test_websearch.py --e2e --save
/tmp/websearch-fix/evidence` and confirm every test flips to/stays PASS.

Raw artifacts from each run are saved under `--save DIR` (e.g.
`validator.attempt1.txt`, `e2e_pi_json.attempt1.ndjson`) for inclusion as evidence.
