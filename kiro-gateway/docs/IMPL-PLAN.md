# kiro-gateway WebSearch Path B → server-side fold-to-text continuation (Option 2)

Engineer-facing implementation plan. Line references are against the working tree at
`/home/<user>/tools/kiro-gateway/kiro/` as read on 2026-06-18.

Goal: when the model calls `web_search` mid-stream (Path B), the gateway must NOT end the
turn. It resolves the search (already done via `call_kiro_mcp_api`), makes a FRESH upstream
Kiro call whose messages = original messages + a synthesized assistant turn (model text-so-far
+ `<web_search>` results) + a short user instruction, and CONTINUES streaming that upstream's
text/thinking/tool_use to the client as the SAME logical Anthropic message (one `message_start`
… one `message_stop`, monotonically increasing content-block indices). Loop if the model
searches again, capped at N rounds. Fully gated behind `WEB_SEARCH_CONTINUE` (default on).

Hard requirement honored throughout: **the patch is a no-op for any turn that does not hit a
Path B `web_search`.** Proof of that property is in §4.

---

## 1. EXACT PLACEMENT — route layer (`stream_wrapper`), not `stream_kiro_to_anthropic`

**Decision: the continuation loop lives in `stream_wrapper` (routes_anthropic.py ~763-965).
`stream_kiro_to_anthropic` only gains a tiny side-channel that (a) signals "a web_search
happened", (b) hands back the query / prebuilt `<web_search>` summary / model text-so-far, and
(c) ends that round's generator cleanly (a bare `return`) without emitting its terminal
`message_delta`/`message_stop`.**

Justification grounded in the actual code:

1. **The single-message lifecycle is owned by `stream_wrapper`, not by the inner generator.**
   `stream_kiro_to_anthropic` emits its own `message_start` (streaming_anthropic.py ~178-195)
   and its own `message_delta`+`message_stop` (~689-701) on *every* invocation.
   `stream_wrapper` already de-duplicates these: it forwards the first `message_start` and turns
   later ones into `ping` heartbeats via the `started` flag (routes_anthropic.py ~790-799), and
   it swallows the trailing `message_delta`/`message_stop` of non-final attempts by buffering
   (`_buf`) chunks that arrive while `got_content` is still `False`. A continuation is, by
   definition, *several* `stream_kiro_to_anthropic` invocations collapsed into ONE client-facing
   message — so it must be orchestrated where that collapse already happens: `stream_wrapper`.

2. **The exact mechanic we need already exists there as flatten-recovery.** flatten-recovery
   (routes_anthropic.py 831-906) already does: `await response.aclose()` → build a different
   payload → `await http_client.request_with_retry("POST", url, _flat_payload, stream=True)` →
   set a flag (`flatten_recovered`) → shift block indices via `_shift_block_index(...)` → resume
   the OUTER `while True` to stream the new response under the same `message_start`. Web_search
   continuation is the identical shape ("fresh upstream call, keep streaming as the same logical
   message, shift indices"). Reusing this proven structure is far lower-risk than building a
   parallel re-entrancy mechanism inside a 600-line translator generator.

3. **`stream_wrapper` already holds every dependency; `stream_kiro_to_anthropic` holds none.**
   Building the continuation payload needs `request_data`, `conversation_id`,
   `profile_arn_for_payload`, `anthropic_to_kiro`, `http_client`, `url` — all in scope in
   `messages()`/`stream_wrapper` (routes_anthropic.py ~660-760, 933). `stream_kiro_to_anthropic`
   receives only `(response, model, model_cache, auth_manager, …, tool_name_map,
   real_input_tokens)` (streaming_anthropic.py 102-119) — it has no HTTP client, URL, request
   object, or conversation id. Threading all of those into a hot per-event generator would be a
   much larger, riskier change and would entangle translation with transport.

4. **Block-index monotonicity across rounds requires state that survives across upstream
   responses.** `stream_kiro_to_anthropic` resets `current_block_index = 0` at the top of every
   invocation (streaming_anthropic.py ~148). Only `stream_wrapper` persists across invocations,
   so the cumulative index base must live there (it already shifts indices for flatten via
   `_shift_block_index`).

5. **Keeping the inner generator pure preserves its other caller.**
   `stream_with_first_token_retry_anthropic` → `stream_processor` also calls
   `stream_kiro_to_anthropic` (streaming_anthropic.py ~937-946) without any continuation context.
   A new **defaulted** `ws_continue_state=None` kwarg keeps that path byte-for-byte unchanged.

---

## 2. Building the continuation upstream payload

Reuse `anthropic_to_kiro` with a synthesized assistant turn. A new module-level helper in
routes_anthropic.py (sibling of `_flatten_request_for_recovery`) clones the validated request,
appends the assistant(results)+user(instruction) pair, and on the final allowed round strips the
`web_search` tool so the model is forced to answer (deterministic termination):

```python
def _build_web_search_continuation_request(request_data, ws_state, force_answer):
    """
    Build an AnthropicMessagesRequest for a web_search continuation round (Option 2).

    messages = original messages
             + assistant: [ model text-so-far (if any) + the <web_search>…</web_search> digest ]
             + user:      [ short instruction to answer using the results above ]

    `force_answer` (set on the round that REACHES the cap) strips the web_search tool so the
    model cannot search again and must produce a grounded answer -> the turn terminates.
    Tool DEFINITIONS are otherwise preserved (web_search stays available), so a continuation
    can itself search again until the cap.
    """
    from kiro.models_anthropic import AnthropicMessage
    rd = request_data.model_copy(deep=True)

    summary = (ws_state.get("summary") or "").strip()
    text_so_far = (ws_state.get("text_so_far") or "").strip()
    assistant_text = (text_so_far + "\n\n" + summary) if text_so_far else summary
    if not assistant_text:
        assistant_text = "(web search returned no results)"

    if force_answer:
        instruction = ("Use the web_search results above to answer my request directly and "
                       "completely. Do not call web_search again.")
    else:
        instruction = ("Use the web_search results above to answer my request. Only call "
                       "web_search again if essential information is still missing.")

    rd.messages = list(rd.messages) + [
        AnthropicMessage(role="assistant", content=[{"type": "text", "text": assistant_text}]),
        AnthropicMessage(role="user", content=[{"type": "text", "text": instruction}]),
    ]

    # x-no-web-search semantics are preserved automatically: web_search is only present in
    # rd.tools because the route injected it (Path B, routes_anthropic.py ~700-720) for a
    # request that did NOT send x-no-web-search. We keep it available so a continuation can
    # search again, EXCEPT on the capped round where we strip it to force termination.
    if force_answer and rd.tools:
        rd.tools = [t for t in rd.tools if getattr(t, "name", None) != "web_search"]

    return rd
```

Why this shape works with `build_kiro_payload` (converters_core.py 1617-1860):
- It splits `merged_messages` into `history = merged_messages[:-1]` and `currentMessage =
  merged_messages[-1]` (converters_core.py ~1719-1735). Our trailing **user** instruction
  becomes `currentMessage.userInputMessage`; the synthesized **assistant** (carrying the
  `<web_search>` digest as plain text) lands in `history` as an `assistantResponseMessage`. That
  is exactly a normal multi-turn conversation, so no special-casing is required.
- `…, user(original question), assistant(results), user(instruction)` alternates correctly for
  `ensure_alternating_roles`/`merge_adjacent_messages` (converters_core.py ~1696-1716). If the
  original happened to end on an assistant turn, the two adjacent assistants merge (text
  concatenates) — still valid.
- The digest is carried as TEXT, which is the only channel pi preserves across turns
  (RE-pi-loop.md Findings B & G), so the continuation model actually receives the results.

`x-no-web-search`: there is no second pass through the route's header handling — we are already
inside `stream_wrapper`. The continuation reuses `request_data.tools`, which only contains
`web_search` when the original request did not opt out. So opt-out requests never inject
web_search → never hit Path B → never enter continuation. Infinite-loop protection is the round
cap (§5), not the header.

### Side-channel populated by `stream_kiro_to_anthropic`
A plain `dict` passed in by `stream_wrapper`. In the Path B branch, right after a successful
`call_kiro_mcp_api` (streaming_anthropic.py ~371-379), BEFORE emitting any
server_tool_use/web_search_tool_result/summary blocks:

```python
                        else:
                            # Option 2 continuation: hand the search back to the route layer,
                            # which will fold results into a fresh upstream call and keep
                            # streaming under the SAME message. End this round cleanly (no
                            # message_delta/message_stop) so the route owns the lifecycle.
                            if ws_continue_state is not None and WEB_SEARCH_CONTINUE:
                                ws_continue_state["searched"] = True
                                ws_continue_state["query"] = query
                                ws_continue_state["summary"] = generate_search_summary(query, results)
                                ws_continue_state["text_so_far"] = full_content
                                logger.info(
                                    f"WebSearch Path B (continue): handoff to route layer "
                                    f"(query={query!r}, text_so_far={len(full_content)} chars)"
                                )
                                return
                            # ---- legacy Path B (flag off / no state): emit blocks as today ----
                            # Emit server_tool_use block
                            ...
```

`return` ends the round's generator; its `finally:` still runs `await response.aclose()`
(streaming_anthropic.py ~733-737), closing round-0's upstream. No terminal events are emitted,
so the route sees the round end with a populated `ws_state` and owns what happens next.

---

## 3. Block-index management (no collisions, monotonic across rounds)

`_shift_block_index` (routes_anthropic.py ~295-313) already re-serializes a `content_block_*`
chunk with its `index` bumped by `by` and is a **no-op when `by == 0`** (its first guard:
`if by == 0 or not _pl …: return chunk`). Today `stream_wrapper` calls it with
`1 if flatten_recovered else 0`. We generalize the shift to a **cumulative base** that grows by
one-past-the-highest-index-emitted at the start of each new round.

New `stream_wrapper` state (initialized with the other flags at routes_anthropic.py 767-771):
- `block_offset = 0` — global base added to every block index coming from `stream_kiro_to_anthropic`.
- `max_idx_seen = -1` — highest GLOBAL (already-shifted) content-block index emitted so far.
- `ws_rounds = 0` — number of web_search continuations performed.
- `active_payload = kiro_payload` — payload used by the empty-retry re-request (so empty-retries
  during a continuation round re-issue the CONTINUATION payload, not the original).

A single forwarding helper centralizes shift + max tracking and is used everywhere a
`stream_kiro_to_anthropic` chunk is forwarded:

```python
                def _fwd(_chunk, _et2, _pl2):
                    # Shift this round's local block index into the global space and track the
                    # high-water mark so the NEXT round starts one past it. No-op when base == 0.
                    nonlocal max_idx_seen
                    _by = block_offset + (1 if flatten_recovered else 0)
                    _out = _shift_block_index(_chunk, _et2, _pl2, _by)
                    if _et2 in ("content_block_start", "content_block_delta", "content_block_stop") \
                            and _pl2 and "index" in _pl2:
                        try:
                            _gi = int(_pl2.get("index", 0)) + _by
                            if _gi > max_idx_seen:
                                max_idx_seen = _gi
                        except Exception:
                            pass
                    return _out
```

- At the start of each continuation round: `block_offset = max_idx_seen + 1`. Round 0 emits
  global indices `0..k` (base 0) → `max_idx_seen = k` → round 1 streams at base `k+1`, etc.
  Strictly monotonic across all rounds.
- `flatten_recovered`'s `+1` is preserved and composes additively (`block_offset +
  (1 if flatten_recovered else 0)`); when no web_search occurred `block_offset == 0`, so the
  shift equals today's `1 if flatten_recovered else 0` — identical wire output.
- `message_delta`/`message_stop` carry no `index`; `_shift_block_index` ignores them. Only the
  final round emits them (continuation rounds `return` first), so exactly one of each reaches the
  client.

flatten-recovery interaction (kept trivially safe): the flatten block (routes_anthropic.py
831-906) is gated to run only when `block_offset == 0` (i.e. not on a web_search continuation
round). Since no existing traffic ever sets `block_offset > 0`, this is a no-op for today's
behavior, and it removes the only index-collision corner (flatten's hard-coded index-0 "fixing"
block colliding with already-emitted web_search blocks). The terminal placeholder index is made
base-aware: `_ph_idx = block_offset + (1 if flatten_status_shown else 0)` (identical to today
when `block_offset == 0`).

---

## 4. Exactly one `message_start` / one `message_stop`

- **`message_start`**: unchanged. The existing `started` gate (routes_anthropic.py ~790-799)
  forwards the first and converts later ones to `ping`. Round 0 forwards it; every continuation
  round's `message_start` becomes a heartbeat.
- **`message_stop` (and `message_delta`)**: a continuation round ends via the new `return` in
  `stream_kiro_to_anthropic` BEFORE its terminal `message_delta`/`message_stop` are emitted, so
  intermediate rounds contribute none. Only the FINAL round (the model answers without searching,
  or with web_search stripped on the capped round) runs to the bottom of
  `stream_kiro_to_anthropic` and emits the single `message_delta`+`message_stop`, which pass
  through normally. Net: one bookend pair.

**No-op proof for non-web_search traffic:** `ws_state` only gains `"searched"` when
`ws_continue_state is not None and WEB_SEARCH_CONTINUE` AND a `web_search` tool call is actually
intercepted. For any turn without Path B web_search, `ws_state` stays `{}`, the continuation
branch is never entered, `ws_rounds`/`block_offset` stay `0`, `_fwd` calls
`_shift_block_index(..., 0)` which returns the chunk unchanged, and `active_payload` stays
`kiro_payload`. The flatten gate `block_offset == 0` is always true, so flatten behaves exactly
as today. The inner generator's new branch is dead unless `ws_continue_state` is non-None
(only `stream_wrapper` passes it, and only when the flag is on).

---

## 5. Round cap + termination

- `WEB_SEARCH_MAX_ROUNDS` (new env, default `5`) → `max_ws_rounds = max(1, min(20,
  WEB_SEARCH_MAX_ROUNDS))` next to `max_empty_retries`/`max_flatten_retries`
  (routes_anthropic.py 756-761).
- Each continuation increments `ws_rounds`. The continuation that REACHES the cap is built with
  `force_answer=True`, which **strips `web_search` from `rd.tools`** → the next round cannot
  search → it must answer → it runs to `message_stop` → the turn terminates with a grounded
  answer (not a truncated mid-search state).
- Defensive belt-and-suspenders: the continuation condition is
  `WEB_SEARCH_CONTINUE and ws_state.get("searched") and ws_rounds < max_ws_rounds`. If a
  (tool-stripped) round somehow still reports a search — it can't, since the tool isn't
  advertised — the `else` branch emits the last digest as a text block at `block_offset` plus
  `message_delta(end_turn)`+`message_stop` and breaks, so the stream is always well-formed.
- A build/HTTP failure during continuation degrades the same way (digest-as-text + clean end),
  never crashing the stream.

---

## 6. Gating (`WEB_SEARCH_CONTINUE`, default on)

`WEB_SEARCH_CONTINUE` already exists (config.py 641). When **off**, `stream_wrapper` passes
`ws_continue_state=None`, so `stream_kiro_to_anthropic` falls through to the legacy Path B
(emit server_tool_use/web_search_tool_result/`<web_search>` text + `continue`) exactly as today,
and the route never attempts continuation. Flip the env var to disable instantly. Add
`WEB_SEARCH_MAX_ROUNDS` to config.py and import both constants where used.

---

## 7. Exact code edits

### 7.1 `kiro/config.py` — add the round cap (after line 641, the `WEB_SEARCH_CONTINUE` def)

```python
# Maximum number of server-side web_search → continuation rounds within a single logical
# assistant message (Option 2 fold-to-text). Each round resolves a web_search and re-prompts
# upstream with the results folded in as text; the round that reaches this cap strips the
# web_search tool so the model must answer (deterministic termination). Default 5.
WEB_SEARCH_MAX_ROUNDS: int = int(os.getenv("WEB_SEARCH_MAX_ROUNDS", "5"))
```

### 7.2 `kiro/streaming_anthropic.py`

**(a) import the flag — line 53**
```python
# OLD
from kiro.config import FIRST_TOKEN_TIMEOUT, FIRST_TOKEN_MAX_RETRIES, FAKE_REASONING_HANDLING
# NEW
from kiro.config import FIRST_TOKEN_TIMEOUT, FIRST_TOKEN_MAX_RETRIES, FAKE_REASONING_HANDLING, WEB_SEARCH_CONTINUE
```

**(b) add the side-channel kwarg — signature tail at lines 111-113** (the three-line
anchor below is unique; the same two kwarg lines also appear in
`stream_with_first_token_retry_anthropic` at 769/892 but not as this exact triple)
```python
# OLD (tail of the signature)
    suppress_empty_placeholder: bool = False,
    real_input_tokens: Optional[int] = None,
) -> AsyncGenerator[str, None]:
# NEW
    suppress_empty_placeholder: bool = False,
    real_input_tokens: Optional[int] = None,
    ws_continue_state: Optional[Dict[str, Any]] = None,
) -> AsyncGenerator[str, None]:
```
(`Dict`/`Any`/`Optional` are already imported at line 37:
`from typing import TYPE_CHECKING, AsyncGenerator, Dict, List, Optional, Any`.) Add one line to
the docstring args:
`ws_continue_state: route-owned side channel for WebSearch Path B fold-to-text continuation
(Option 2). When provided and WEB_SEARCH_CONTINUE is on, a web_search call records its query /
summary / text-so-far here and ends the round so the route can continue it.`

**(c) the handoff — Path B branch, the `else:` at line 379 (right after
`mcp_tool_use_id, results = await call_kiro_mcp_api(...)` at line 375 and the
`if results is None:` check at lines 377-378).**
Insert the new block as the FIRST thing under `else:`, before the existing
`# Emit server_tool_use block` comment:
```python
                        if results is None:
                            logger.error("MCP API call failed for web_search (Path B)")
                        else:
                            # ---- Option 2: fold-to-text continuation handoff -------------
                            # Hand the resolved search back to the route layer, which makes a
                            # fresh upstream call (original messages + assistant(text-so-far +
                            # <web_search> digest) + user(instruction)) and keeps streaming under
                            # the SAME logical message. End this round's generator cleanly (no
                            # message_delta/message_stop) so the route owns the lifecycle.
                            if ws_continue_state is not None and WEB_SEARCH_CONTINUE:
                                ws_continue_state["searched"] = True
                                ws_continue_state["query"] = query
                                ws_continue_state["summary"] = generate_search_summary(query, results)
                                ws_continue_state["text_so_far"] = full_content
                                logger.info(
                                    f"WebSearch Path B (continue): handoff to route "
                                    f"(query={query!r}, text_so_far={len(full_content)} chars)"
                                )
                                return
                            # ---- legacy Path B (flag off / collect path): emit blocks ----
                            # Emit server_tool_use block
                            yield format_sse_event("content_block_start", {
                                ...
```
(Everything from `# Emit server_tool_use block` through `web_search_emitted = True` /
`continue  # skip normal tool_use processing` at lines ~380-454 is unchanged.)

### 7.3 `kiro/routes_anthropic.py`

**(a) imports — line 39**
```python
# OLD
from kiro.config import PROXY_API_KEY, WEB_SEARCH_ENABLED, ALLOW_ANY_ANTHROPIC_KEY, KIRO_EMPTY_FLATTEN_RECOVERY
# NEW
from kiro.config import PROXY_API_KEY, WEB_SEARCH_ENABLED, ALLOW_ANY_ANTHROPIC_KEY, KIRO_EMPTY_FLATTEN_RECOVERY
from kiro.config import WEB_SEARCH_CONTINUE, WEB_SEARCH_MAX_ROUNDS
```

**(b) module-level helper — add right after `_flatten_request_for_recovery` (before the
`# --- Security scheme ---` section, ~line 130).** Full function from §2
(`_build_web_search_continuation_request`).

**(c) `stream_wrapper` — new state + helper.** Replace the state-init block
(routes_anthropic.py lines 767-771, the five flag lines ending in `flatten_recovered`):
```python
# OLD
                empty_attempts = 0
                started = False  # whether the single message_start has been emitted
                flatten_attempts = 0  # flatten-recovery attempts used
                flatten_status_shown = False  # whether the "fixing" status was shown
                flatten_recovered = False  # streaming the flattened-recovery attempt (shift block idx +1)
                try:
# NEW
                empty_attempts = 0
                started = False  # whether the single message_start has been emitted
                flatten_attempts = 0  # flatten-recovery attempts used
                flatten_status_shown = False  # whether the "fixing" status was shown
                flatten_recovered = False  # streaming the flattened-recovery attempt (shift block idx +1)
                # --- WebSearch Path B fold-to-text continuation (Option 2) state ---
                block_offset = 0      # cumulative global base added to inner block indices
                max_idx_seen = -1     # highest GLOBAL content-block index emitted so far
                ws_rounds = 0         # number of web_search continuations performed
                active_payload = kiro_payload  # payload used by the empty-retry re-request

                def _fwd(_chunk, _et2, _pl2):
                    # Shift this round's local block index into the global space and track the
                    # high-water mark so the NEXT round starts one past it. No-op when base == 0,
                    # so this is transparent for any turn without a web_search continuation.
                    nonlocal max_idx_seen
                    _by = block_offset + (1 if flatten_recovered else 0)
                    _out = _shift_block_index(_chunk, _et2, _pl2, _by)
                    if _et2 in ("content_block_start", "content_block_delta", "content_block_stop") \
                            and _pl2 and "index" in _pl2:
                        try:
                            _gi = int(_pl2.get("index", 0)) + _by
                            if _gi > max_idx_seen:
                                max_idx_seen = _gi
                        except Exception:
                            pass
                    return _out
                try:
```
Add the cap constant next to the other maxima (defined just before `async def stream_wrapper`,
routes_anthropic.py lines 756-761; they are closure-visible inside `stream_wrapper`):
```python
                    max_ws_rounds = max(1, min(20, WEB_SEARCH_MAX_ROUNDS))
```

**(d) per-round `ws_state` + pass it into the inner generator.** Replace the loop head
(routes_anthropic.py lines 772-789):
```python
# OLD
                        suppress = empty_attempts < max_empty_retries
                        got_content = False   # this attempt produced REAL content
                        _buf = []             # sniff buffer until we decide real/placeholder
                        _acc = ""             # accumulated leading text for placeholder sniff
                        async for chunk in stream_kiro_to_anthropic(
                            response,
                            request_data.model,
                            model_cache,
                            auth_manager,
                            request_messages=messages_for_tokenizer,
                            tool_name_map=tool_name_map,
                            suppress_empty_placeholder=suppress,
                            real_input_tokens=real_input_tokens,
                        ):
# NEW
                        suppress = empty_attempts < max_empty_retries
                        got_content = False   # this attempt produced REAL content
                        _buf = []             # sniff buffer until we decide real/placeholder
                        _acc = ""             # accumulated leading text for placeholder sniff
                        ws_state = {}         # per-round WebSearch continuation side-channel
                        async for chunk in stream_kiro_to_anthropic(
                            response,
                            request_data.model,
                            model_cache,
                            auth_manager,
                            request_messages=messages_for_tokenizer,
                            tool_name_map=tool_name_map,
                            suppress_empty_placeholder=suppress,
                            real_input_tokens=real_input_tokens,
                            ws_continue_state=(ws_state if WEB_SEARCH_CONTINUE else None),
                        ):
```

**(e) forward through `_fwd` instead of `_shift_block_index`.** Two sites inside the async-for:

fast path (line 801):
```python
# OLD
                            if got_content:
                                yield _shift_block_index(chunk, _et, _pl, 1 if flatten_recovered else 0)
                                continue
# NEW
                            if got_content:
                                yield _fwd(chunk, _et, _pl)
                                continue
```
buffered flush (lines 822-826):
```python
# OLD
                            if got_content:
                                for _c in _buf:
                                    _cet, _cpl = _sse_parse(_c)
                                    yield _shift_block_index(_c, _cet, _cpl, 1 if flatten_recovered else 0)
                                _buf = []
# NEW
                            if got_content:
                                for _c in _buf:
                                    _cet, _cpl = _sse_parse(_c)
                                    yield _fwd(_c, _cet, _cpl)
                                _buf = []
```

**(f) insert the continuation decision right after the async-for, BEFORE `if got_content:
break` (line 827).**
```python
# OLD
                        if got_content:
                            break
                        # ---- nothing real this attempt ...
# NEW
                        # ---- WebSearch Path B fold-to-text continuation (Option 2) ----------
                        # A web_search was intercepted this round (route owns the lifecycle; the
                        # inner generator returned before its message_stop). Resolve into a fresh
                        # upstream call and keep streaming under the SAME message. Runs before the
                        # got_content/empty logic so a search-only round is never mis-read as empty.
                        if WEB_SEARCH_CONTINUE and ws_state.get("searched"):
                            if ws_rounds < max_ws_rounds:
                                ws_rounds += 1
                                _force = ws_rounds >= max_ws_rounds  # last allowed round -> force answer
                                block_offset = max_idx_seen + 1       # advance global index base
                                try:
                                    _cont_req = _build_web_search_continuation_request(
                                        request_data, ws_state, force_answer=_force
                                    )
                                    active_payload, _ = anthropic_to_kiro(
                                        _cont_req, conversation_id, profile_arn_for_payload
                                    )
                                except Exception as _ce:
                                    logger.warning(f"web_search continuation build failed ({_ce}); ending turn gracefully")
                                    _idx = block_offset
                                    yield 'event: content_block_start\ndata: ' + json.dumps({"type": "content_block_start", "index": _idx, "content_block": {"type": "text", "text": ""}}) + "\n\n"
                                    yield 'event: content_block_delta\ndata: ' + json.dumps({"type": "content_block_delta", "index": _idx, "delta": {"type": "text_delta", "text": ws_state.get("summary") or ""}}) + "\n\n"
                                    yield 'event: content_block_stop\ndata: ' + json.dumps({"type": "content_block_stop", "index": _idx}) + "\n\n"
                                    yield 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}\n\n'
                                    yield 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
                                    break
                                logger.info(f"web_search continuation round {ws_rounds}/{max_ws_rounds} (force_answer={_force}); base index={block_offset}")
                                try:
                                    await response.aclose()
                                except Exception:
                                    pass
                                response = await http_client.request_with_retry("POST", url, active_payload, stream=True)
                                if response.status_code != 200:
                                    try:
                                        _err = (await response.aread()).decode("utf-8", "replace")
                                    except Exception:
                                        _err = "Unknown error"
                                    yield f'event: error\ndata: {json.dumps({"type": "error", "error": {"type": "api_error", "message": _err[:200]}})}\n\n'
                                    break
                                yield _PING  # heartbeat before the continuation round streams
                                continue     # resume OUTER loop to stream the continuation
                            else:
                                # Cap reached and the model still wants to search (defensive; the
                                # capped round strips web_search so this is normally unreachable).
                                # Emit the last digest as text and close the message cleanly.
                                _idx = max_idx_seen + 1
                                yield 'event: content_block_start\ndata: ' + json.dumps({"type": "content_block_start", "index": _idx, "content_block": {"type": "text", "text": ""}}) + "\n\n"
                                yield 'event: content_block_delta\ndata: ' + json.dumps({"type": "content_block_delta", "index": _idx, "delta": {"type": "text_delta", "text": ws_state.get("summary") or ""}}) + "\n\n"
                                yield 'event: content_block_stop\ndata: ' + json.dumps({"type": "content_block_stop", "index": _idx}) + "\n\n"
                                yield 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}\n\n'
                                yield 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
                                logger.info(f"web_search round cap ({max_ws_rounds}) reached; emitted digest and closed")
                                break

                        if got_content:
                            break
                        # ---- nothing real this attempt ...
```

**(g) empty-retry re-request uses `active_payload`** (line 933, the last upstream call inside
the `while True` body):
```python
# OLD
                        response = await http_client.request_with_retry("POST", url, kiro_payload, stream=True)
# NEW
                        response = await http_client.request_with_retry("POST", url, active_payload, stream=True)
```

**(h) gate flatten to base 0 + base-aware placeholder index.** flatten opener (line 847):
```python
# OLD
                            if KIRO_EMPTY_FLATTEN_RECOVERY:
# NEW
                            if KIRO_EMPTY_FLATTEN_RECOVERY and block_offset == 0:
```
placeholder index (line 911):
```python
# OLD
                            _ph_idx = 1 if flatten_status_shown else 0
# NEW
                            _ph_idx = block_offset + (1 if flatten_status_shown else 0)
```

---

## 8. Verification checklist (no exploit; functional review/tests)

1. `python -c "import kiro.routes_anthropic, kiro.streaming_anthropic, kiro.config"` — imports OK.
2. Non-web_search streaming turn: assert byte-identical SSE to pre-patch (block_offset stays 0,
   `_fwd` == `_shift_block_index(...,0)` == passthrough, `ws_state` empty). This is the critical
   regression gate.
3. Single-search turn: round 0 (optional text) + web_search → one continuation → grounded
   answer; assert exactly one `message_start`, one `message_stop`, strictly increasing block
   indices, no `server_tool_use`/`web_search_tool_result` on the wire.
4. Multi-search turn: 2-3 searches then answer; assert monotonic indices and a single bookend
   pair; assert the capped round has `web_search` stripped from the upstream payload.
5. `WEB_SEARCH_CONTINUE=false`: assert legacy Path B (server_tool_use + web_search_tool_result +
   `<web_search>` text, end_turn) — unchanged.
6. flatten path with no web_search: assert unchanged (gate `block_offset == 0` always true).
7. Continuation upstream non-200 / build error: assert graceful digest-as-text + clean
   `message_stop` (no crash, no dangling stream).

---

## Summary

Place the continuation loop in `stream_wrapper` (route layer): it already owns the single
`message_start`/`message_stop` lifecycle, already has the "close upstream → re-request with a
different payload → keep streaming with shifted block indices" machinery (flatten-recovery), and
already holds every dependency needed to build the continuation (`request_data`, `http_client`,
`url`, `conversation_id`, `profile_arn_for_payload`, `anthropic_to_kiro`).
`stream_kiro_to_anthropic` gains only a defaulted `ws_continue_state` side-channel: on a Path B
web_search it records query/summary/text-so-far and `return`s before its terminal events, so the
route can fold the results into a fresh upstream call. A cumulative `block_offset`
(+ `max_idx_seen`) keeps indices monotonic across rounds; `active_payload` keeps empty-retries
correct mid-continuation; `WEB_SEARCH_MAX_ROUNDS` with tool-stripping on the final round
guarantees termination. Everything is gated by `WEB_SEARCH_CONTINUE` (default on) and is a strict
no-op for any turn that never hits Path B web_search (block_offset==0 ⇒ shift is identity, the
new inner branch is dead, flatten unchanged).

**Single biggest risk:** the empty-completion retry/flatten machinery and the new continuation
loop now share `stream_wrapper`'s single `while True` and the mutable `response`/`active_payload`
handles. A continuation round that itself returns transient empties re-enters the empty-retry
path, and the interplay of `block_offset`, `flatten_recovered`, `active_payload`, and `aclose()`
on the reused `response` is the place most likely to produce a dangling/closed-handle bug or a
duplicated/again colliding `message_stop` if an edge path is missed — exactly the class of bug
that previously caused the `'NoneType' object has no attribute 'aiter_bytes'` crash noted in the
flatten code. Mitigations baked in above: flatten is disabled on continuation rounds
(`block_offset == 0` gate), every fresh upstream is guarded for non-200, all terminal/error exits
emit a single well-formed `message_stop`, and the no-op property is preserved for normal traffic
— so the blast radius is confined to the web_search continuation path, which is itself behind a
kill switch.
