# EDGE-CASE / FAILURE-MODE ANALYSIS — Path B "continuation" patch (kiro-gateway)

Design-time red-team. NO exploitation. Target: patching `stream_kiro_to_anthropic`
(+ route `stream_wrapper`, + `collect_anthropic_response`) so a server-resolved
`web_search` (Path B) does NOT end the turn but RE-CALLS upstream Kiro with the
results folded in, streaming the model's grounded answer as the SAME single
Anthropic SSE message (one `message_start`, one `message_stop`), looping up to N
web_search rounds.

Grounding (verified against the provided source):
- pi parses ONLY `message_start|message_delta|message_stop|content_block_start|
  _delta|_stop`; `message_start` MUST be matched by `message_stop` or pi THROWS
  "Anthropic stream ended before message_stop"; pi DROPS `server_tool_use` /
  `web_search_tool_result`; pi keeps ONLY `text`+`thinking`; pi binds
  `content_block_delta` to its start by `index`; unknown `stop_reason` THROWS
  (mapStopReason default). (RE-pi-loop.md, FINDINGS A/B/D/G.)
- Current Path B (`streaming_anthropic.py` ~L361-453) intercepts a `web_search`
  tool_use, calls MCP, emits server_tool_use + web_search_tool_result + a TEXT
  `<web_search>` summary, sets `web_search_emitted=True`, then `continue`s the
  SAME `parse_kiro_stream` loop (which is already drained → turn ends with only
  the summary). Final `stop_reason = "tool_use" if tool_blocks else "end_turn"`;
  the web_search path does NOT append to `tool_blocks` → today it ends `end_turn`.
- Outer `stream_wrapper` (routes ~L763+) owns: single `message_start` de-dupe
  (`started`; extras → `_PING`), empty-retry (`KIRO_EMPTY_RETRIES`, default 3),
  flatten-recovery (`KIRO_EMPTY_FLATTEN_MAX`, default 4) with a hardcoded index-0
  "fixing" thinking block + `_shift_block_index(+1)` for recovered content,
  GeneratorExit handling, non-200-on-retry handling, `finally: http_client.close()`.
- Config: `WEB_SEARCH_ENABLED` (default true), `WEB_SEARCH_CONTINUE` (default
  true), per-request `x-no-web-search` opt-out (compaction/summarization).
- `generate_search_summary` returns FULL, untruncated snippets by design.

Each case below: FAILURE / LIKELIHOOD / exact GUARD or ASSERTION.

---

## (1) Infinite web_search loop (model keeps searching) — CAP + DEDUPE
- FAILURE: every continuation round the model emits another `web_search`; gateway
  resolves + re-calls; model searches again. Unbounded MCP calls, cost, latency,
  context growth; a headless subagent never terminates. Also the "alternating
  near-identical query" loop (search X, search X', search X, ...).
- LIKELIHOOD: HIGH. opus-4.x researches aggressively; the auto-injected tool
  description invites it; there is NO iteration cap anywhere (RE finding E.3).
- GUARDS:
  - Hard round cap `WEB_SEARCH_MAX_ROUNDS` (default 3, env-tunable). Counter
    `ws_rounds` increments each time a search is RESOLVED and a continuation is
    launched. Invariant `ws_rounds <= WEB_SEARCH_MAX_ROUNDS`.
  - On the LAST permitted round, re-call upstream with the `web_search` tool
    STRIPPED from the payload (model physically cannot call it again). Stripping
    the tool is the robust guard; "asking nicely" is not. Never leave a resolved
    search with no follow-up answer.
  - Dedupe: keep a `set` of normalized queries this turn (lowercase, strip,
    collapse whitespace). A repeated query is served from cache WITHOUT a fresh
    MCP call and increments `dup_count`; after `dup_count >= 2` force-terminate
    continuation (strip tool, fold note "Already searched <q>; answer now").
  - On cap/dedupe termination: ALWAYS close with `message_delta(end_turn)` +
    `message_stop` (fold an optional "(search budget reached)" note). Never stop
    mid-tool.
- ASSERT: `ws_rounds <= WEB_SEARCH_MAX_ROUNDS`; final-round payload contains no
  web_search tool.

## (2) Block-index collisions across rounds — ONE MONOTONIC COUNTER
- FAILURE: pi binds `content_block_delta` to its start by `index`
  (`blocks.findIndex(b=>b.index===event.index)`). If round 2 restarts indices at
  0 (e.g. continuation = fresh `stream_kiro_to_anthropic` call, which sets
  `current_block_index = 0` at L149 and resets `text_block_started` etc.), round
  2's deltas bind to round 1's STALE block, and a second `content_block_start` at
  an already-stopped index is malformed. Corruption or silent content loss.
- LIKELIHOOD: HIGH if continuation is implemented as a per-round generator;
  guaranteed collision on reset.
- GUARDS:
  - `current_block_index` is ONE monotonically increasing int for the LIFETIME of
    the single Anthropic message, shared across all N rounds. NEVER reset between
    rounds. Implement continuation as a loop INSIDE one generator invocation (or
    thread `start_index`→`next_index` in/out of a per-round helper).
  - Per round reset ONLY the block-open booleans (`text_block_started=False`,
    `thinking_block_started=False`, `text_block_index=None`,
    `thinking_block_index=None`, `thinking_signature_emitted=False`) — KEEP the
    counter advancing.
  - Runtime invariant: track `max_started_index`; before each
    `content_block_start`, `assert new_index > max_started_index` then
    `max_started_index = new_index`. `current_block_index` only ever `+= 1`.
  - Compose cleanly with the wrapper's `_shift_block_index(+1)` (flatten): a
    UNIFORM +1 on a monotonic counter stays collision-free; verify the shift is
    applied to continuation blocks too (it is: wrapper shifts every post-content
    chunk while `flatten_recovered`).
- ASSERT: every `content_block_start.index` strictly increasing across the whole
  message; no index reused after its `content_block_stop`.

## (3) Double message_start / missing message_stop — EXACTLY ONE ENVELOPE
- FAILURE:
  - (a) Per-round generators each emit `message_start` (L172) → N starts. pi's
    second `message_start` re-inits `output` and DISCARDS round-1 content (and is
    protocol-illegal).
  - (b) Per-round generators each emit `message_delta`+`message_stop` (L690-703)
    → first `message_stop` finalizes the message; rounds 2..N arrive AFTER
    message_stop (dropped/err); turn ends after round 1 (the very "stuck on
    search" bug).
  - (c) An exception/cap/disconnect between `message_start` and the terminal
    `message_stop` → pi THROWS "stream ended before message_stop".
- LIKELIHOOD: HIGH — central structural risk.
- GUARDS:
  - Refactor so `message_start` (top) and `message_delta`+`message_stop` (bottom)
    live OUTSIDE the per-round loop. Introduce `_stream_one_round(response,...)`
    that yields ONLY `content_block_*` events (NO envelope). Outer fn emits ONE
    envelope and loops the helper.
  - Track `message_started` / `message_stopped` booleans. The terminal emit is
    idempotent: `if message_started and not message_stopped: emit
    message_delta(<final stop_reason>)+message_stop`. Place it in a `finally:`
    that runs on EVERY non-GeneratorExit exit (normal, cap, empty, upstream
    error, timeout).
  - Keep the wrapper's existing `started`→`_PING` de-dupe as a backstop for any
    stray `message_start`.
- ASSERT: over the whole response, `count(message_start)==1` and
  `count(message_stop)==1`; `message_stop` is the LAST event; per-round upstream
  completions emit NEITHER envelope event.

## (4) Continuation round returns EMPTY (opus-4.8 empty bug) — REUSE EMPTY/ FLATTEN
- FAILURE: the re-call (with folded results + bigger structured history) comes
  back zero-output. The existing empty-retry + flatten live in the OUTER wrapper,
  wrapping ROUND 0 only; a continuation re-call issued INSIDE the inner generator
  is DOWNSTREAM of that machinery → an empty round is NOT retried, the turn ends
  with only `<web_search>` (the exact bug we're fixing), or emits a contentless
  `message_stop`. The inner empty-guard "(no output)" (L639-657) could also append
  after a real prior summary → "(no output)" glued to results.
- LIKELIHOOD: MEDIUM-HIGH. Folding a large `<web_search>` block + tool history
  INCREASES structured-content size → MORE empty-prone than round 0 (flatten was
  built for exactly this structural trigger).
- GUARDS:
  - Every upstream round (initial AND continuation) must pass through the SAME
    "non-empty-or-retried-or-flattened" gate. Strongly prefer factoring "obtain a
    non-empty 200 stream for payload P" into a reusable unit used by both round 0
    and continuation, so the empty-bug fix is NOT bypassed exactly when it is most
    likely to fire.
  - If a continuation round is still empty after retries+flatten, DEGRADE to
    "emit the search summary text + end_turn" — never a contentless stop, never
    silent.
  - Suppress the inner "(no output)" placeholder on continuation rounds that
    already produced prior real content (thread the existing
    `suppress_empty_placeholder`).
- ASSERT: a continuation round that ends empty after recovery yields the
  summary+end_turn; placeholder never concatenated onto real content.

## (5) Client disconnect mid-continuation (GeneratorExit) — CLOSE + DON'T YIELD
- FAILURE: client disconnects during the MCP call or the round-2 re-call. Python
  throws `GeneratorExit` at the `yield`. Open upstream httpx response(s) and the
  MCP client leak (CLOSE_WAIT, the issue #54 class). If GeneratorExit is caught
  and the code tries to `yield` the terminal `message_stop`, Python raises
  `RuntimeError: async generator ignored GeneratorExit`.
- LIKELIHOOD: MEDIUM. Long multi-round searches widen the window; headless
  subagent timeouts disconnect.
- GUARDS:
  - The continuation loop owns a `try/finally` that `aclose()`s the ACTIVE round
    upstream response (track it in a closure var) and the MCP client on
    GeneratorExit, then RE-RAISES without yielding.
  - The terminal `message_stop` emit (guard #3) MUST be skipped when the exit
    cause is GeneratorExit/client-disconnect (cannot yield into a closing gen).
  - The wrapper already sets `client_disconnected` + `finally:
    http_client.close()`; ensure per-round responses created inside the
    continuation are visible to that finally (or closed by the inner finally).
- ASSERT: on GeneratorExit, zero further `yield`, all round responses + MCP
  client closed, exception re-raised.

## (6) Upstream non-200 on the continuation call — GRACEFUL END, NOT BARE ERROR
- FAILURE: round-2 re-call returns 403/429/500. We are mid-SSE (message_start +
  maybe a `<web_search>` block already sent); we can't "return an error response".
  If unhandled → exception → wrapper emits `event: error`. pi THROWS on
  `event: error`; and if no `message_stop` follows, pi ALSO throws "ended before
  message_stop" — double failure.
- LIKELIHOOD: MEDIUM. 429 on re-calls; token-refresh races.
- GUARDS:
  - Retry the re-call with backoff (reuse `request_with_retry`, which retries).
  - On retries-exhausted: close any open block, emit `message_delta(end_turn)` +
    `message_stop` (results already streamed are preserved); optionally fold a
    short "(could not continue after search: upstream <code>)" note. NEVER emit a
    bare `event: error` after content without a trailing `message_stop`.
  - Never resume with a dead/None response (same NoneType.aiter_bytes discipline
    the wrapper already documents).
- ASSERT: continuation upstream failure → clean end_turn+message_stop; no bare
  error-after-content; no missing message_stop.

## (7) Token-budget blowup (results folded back each round) — BOUND ROUNDS + CONTEXT
- FAILURE: each round appends prior assistant text + the FULL untruncated
  `<web_search>` results + a new tool_use + new results. Context grows
  superlinearly. Outcomes: upstream rejects (→ #4/#6), large cost, and the
  gateway's `real_input_tokens` is computed ONCE (route L688) and NOT updated, so
  pi's message_start input_tokens is stale-low → context % wrong → under-compact.
- LIKELIHOOD: MEDIUM-HIGH for multi-round (snippets are full-length by design).
- GUARDS:
  - Round cap (#1) is primary.
  - Bound the folded-back context distinctly from the user-facing text: top-K
    results, snippet capped to M chars, for the MODEL-facing continuation payload.
  - Pre-call budget check: count the next continuation payload; if it exceeds
    `model_max − headroom`, do a final NO-TOOL answer round or terminate
    end_turn. Use the live count (not the stale round-0 value) for this gate.
  - Dedupe (#1) prevents re-folding identical results.
- ASSERT: bounded rounds AND bounded folded context; pre-call budget check aborts
  before exceeding `model_max − headroom`.

## (8) Continuation re-triggers web_search auto-injection (recursion) — INJECT ONCE
- FAILURE: if continuation rebuilds the request via the PUBLIC `/v1/messages`
  route (or re-runs the `WEB_SEARCH_ENABLED` block), the tool is re-injected every
  round (guarantees #1) AND Path A detection / tokenizer / x-no-web-search logic
  re-run — full recursion, header semantics lost.
- LIKELIHOOD: MEDIUM (implementation-dependent).
- GUARDS:
  - Continuation re-calls Kiro `/generateAssistantResponse` DIRECTLY with a
    freshly built `kiro_payload` (reuse `anthropic_to_kiro`), NEVER via the public
    route.
  - Auto-inject runs EXACTLY ONCE per client request (round 0). For rounds
    `< cap` reuse the same tool list; on the final round STRIP web_search (#1).
    Never re-run the inject block per round.
  - Re-entrancy flag (`_ws_continuation=True`) short-circuits the inject block if
    any internal re-dispatch is ever introduced.
- ASSERT: inject block executes once per client request; continuation hits Kiro
  directly.

## (9) x-no-web-search header + compaction summary calls — GATE CONTINUATION TOO
- FAILURE: `x-no-web-search` currently only skips INJECTION. If a caller supplies
  their own web_search tool, or the model emits one anyway, the continuation patch
  would FIRE on a compaction/summarization call and fold `<web_search>` text into
  the summary — re-poisoning the next compaction (the exact regression the header
  was added to prevent, now WORSE because it loops).
- LIKELIHOOD: MEDIUM. Compaction is frequent in long sessions.
- GUARDS:
  - Gate the ENTIRE continuation on `WEB_SEARCH_CONTINUE and not _no_ws and
    WEB_SEARCH_ENABLED`. Thread the `_no_ws` decision into
    `stream_kiro_to_anthropic` (new param `web_search_continue: bool`).
  - When `x-no-web-search` is set: do NOT resolve+continue even if a web_search
    tool_use appears; ideally STRIP the tool from the payload so the model can't
    call it at all on summarization calls.
  - Verify the compaction/summarization caller always sends `x-no-web-search`.
- ASSERT: continuation fires iff `WEB_SEARCH_CONTINUE and not _no_ws`; header
  disables BOTH inject AND continuation.

## (10) Thinking-block signature/ordering when continuing — THINKING FIRST, SIGNED
- FAILURE: pi requires a signature on `thinking` (else downgraded to text). If
  round 1 emitted TEXT (`<web_search>` summary) at index k and round 2 begins with
  a `thinking` block at k+1, you have TEXT-before-THINKING within ONE message —
  violates Anthropic thinking-ordering. pi keeps both, but when pi REPLAYS this
  assistant message to the API next turn, the API may reject "thinking after text"
  or strip it; folding wrong-ordered history into the continuation payload can
  make Kiro empty (→ #4). Multiple per-round thinking blocks each need a valid
  signature.
- LIKELIHOOD: MEDIUM. opus thinks often; "summary then answer" naturally produces
  text-before-later-thinking.
- GUARDS:
  - Resolve via the visibility decision (#14): by DEFAULT do NOT stream the raw
    `<web_search>` results as TEXT before the model's thinking. Fold results into
    the continuation PAYLOAD only; stream to pi only the model's grounded
    thinking/text → thinking naturally leads, ordering preserved.
  - Per-round reset of `thinking_block_started/index`, `text_block_started/index`,
    `thinking_signature_emitted`, and fresh `real_reasoning_signature` capture —
    while `current_block_index` stays monotonic (#2).
  - Invariant: no `thinking` `content_block_start` at an index AFTER any `text`
    `content_block_start` within the single message. If the model thinks again
    post-search, either suppress streaming the intermediate summary as text, or
    accept pi's downgrade of unsigned thinking → text. Pick explicitly.
  - When replaying prior thinking into the continuation payload, keep only the
    LAST signed thinking, drop older replayed thinking (mirror
    `_flatten_request_for_recovery`, which already drops replayed thinking).
- ASSERT: at most the leading region is thinking; no thinking-after-text in the
  emitted message; every thinking block signed; per-round thinking state resets,
  index monotonic.

## (11) Real client tool_use after searching — STOP & LET pi DRIVE
- FAILURE: round 2 the model emits a REAL client tool_use (read_file, bash, ...)
  that pi advertises and can execute. If continuation tries to "resolve+continue"
  it (it can only server-resolve web_search), the tool is dropped/hung. If a round
  mixes web_search + a client tool, ordering/ownership is ambiguous.
- LIKELIHOOD: MEDIUM. Agentic models interleave search with file/exec tools.
- GUARDS:
  - Decide AFTER the round's tool calls are known. Partition into
    {web_search (server-resolved)} vs {client tools (pi-executed)}.
  - If ANY client tool_use present: STOP continuing — emit the client tool_use
    block(s) normally, set message stop_reason=`tool_use`, `message_stop`; hand
    control to pi (its loop runs the tool and re-prompts; RE finding D).
  - Continue ONLY when the round's sole tool calls are web_search.
  - Mixed round (web_search + client tool): emit the web_search as a NORMAL client
    tool_use block too (let pi own it) OR resolve+fold then still STOP; do not
    server-resolve-and-continue in a mixed round.
- ASSERT: continuation entered only on web_search-only rounds; any pi-executable
  tool_use → stop_reason=tool_use + message_stop.

## (12) Non-streaming parity (collect_anthropic_response) — MIRROR THE LOOP
- FAILURE: `collect_anthropic_response` (stream=False, route L980) has NO Path B
  interception at all — it just builds text/thinking/tool_use blocks. So
  non-streaming returns a dangling `web_search` tool_use the caller can't fulfill
  (stop_reason=tool_use, stuck), and the continuation fix (streaming-only) leaves
  non-streaming divergent/broken.
- LIKELIHOOD: MEDIUM. Some callers / pi internals / compaction use non-streaming.
- GUARDS:
  - Mirror continuation in `collect_anthropic_response`: on a collected
    web_search tool_call, resolve via MCP, fold, re-call upstream (loop ≤ N),
    return the FINAL grounded answer as one non-streaming message. Reuse the same
    cap/dedupe/empty-retry/budget/client-tool-stop rules.
  - Factor the continuation core into a shared helper used by both paths.
  - Minimum bar if not fully implemented: non-streaming must NOT return a dangling
    web_search tool_use — resolve+fold once and return the grounded answer (or the
    summary), never stop_reason=tool_use on a server tool.
  - Parity test: same conversation → equivalent final text in both modes.
- ASSERT: non-streaming never returns an unfulfilled server web_search tool_use.

## (13) Usage / output_token accounting across rounds — CUMULATIVE, ONE DELTA
- FAILURE: per-round `message_delta` (wrong, #3) double-counts/resets. With one
  final `message_delta`, its `output_tokens` must be the SUM across rounds, not
  the last round's. If the `<web_search>` text is streamed it inflates output and
  becomes input next round. `message_start.input_tokens` is locked at round 0 and
  can't be updated mid-message → pi's context % drifts.
- LIKELIHOOD: LOW-MEDIUM (metering correctness; but wrong input_tokens drives
  over/under-compaction — a real behavior bug, ties to #7).
- GUARDS:
  - Accumulate `output_tokens_total` across rounds; emit ONCE in the final
    `message_delta` (Anthropic message_delta.usage is cumulative for the message).
  - Be consistent about whether folded `<web_search>` text counts as output
    (count it iff streamed visibly; if hidden, exclude from output but know it is
    input next round).
  - input_tokens: accept the locked message_start value; LOG true growing input
    per round and use it for the budget gate (#7). Optionally emit cumulative
    input_tokens in message_delta (verify pi reads it; RE doc confirms it reads
    output_tokens).
- ASSERT: exactly one message_delta; output_tokens = sum of per-round counts.

## (14) Ordering / visibility of <web_search> results — HIDE BY DEFAULT
- DESIGN QUESTION + FAILURE: current Path B streams the raw `<web_search>` summary
  as visible TEXT. With continuation you also stream the grounded answer. Showing
  raw results: clutters output, creates text-before-thinking (#10), is what
  poisons compaction (#9), doubles token surface (#13). Hiding them: clean output,
  correct ordering, no poisoning, but a naive hide loses sources.
- WHAT deep-research NEEDS: it is a headless `-p --no-session` subagent that
  parses the FINAL TEXT. It needs the model to USE the results and produce a
  grounded answer WITH source URLs/citations. A raw `<web_search>` dump as the
  final message (today's bug) is useless to it; it does NOT need the raw block as
  long as the answer carries findings + URLs.
- GUARDS / RECOMMENDATION:
  - DEFAULT: HIDE raw results from the client stream; fold them into the
    continuation PAYLOAD as a synthetic user/tool-role context message to Kiro.
    Stream to pi ONLY the model's grounded thinking/text; one `end_turn` closes
    it. (Fixes #9, #10, #13.)
  - Optionally surface a COMPACT signed THINKING marker ("searched: <q> — N
    results") for transparency without polluting text/compaction.
  - Config/header opt-in for visible raw results when debugging
    (`WEB_SEARCH_SHOW_RESULTS` / `x-show-web-search`), default OFF.
  - For deep-research: in the folded context, instruct the model to include source
    URLs in the answer so citations survive into the parsed final text.
- ASSERT: in continuation mode the raw results are payload-only by default; only
  model-generated thinking/text is streamed; single end_turn closes the message.

---

## LATERAL / NON-TEMPLATE failure modes (beyond the 14 asked)

## (15) Shared mutable request_data corrupted across rounds — DEEP-COPY PER ROUND
- FAILURE: if continuation mutates `request_data.messages` in place to append the
  assistant turn + folded results, later rounds corrupt earlier state, and an
  empty-retry/flatten that rebuilds from `request_data` would include half-built
  continuation history.
- LIKELIHOOD: MEDIUM (easy mistake).
- GUARD: build each continuation payload from an immutable base + appended
  synthetic messages via `request_data.model_copy(deep=True)`; NEVER mutate the
  original. (The flatten helper already uses `model_copy(deep=True)` — follow it.)

## (16) Flatten "fixing" status collides with continuation indices — NEXT-FREE INDEX
- FAILURE: if a continuation round empties and triggers flatten recovery, the
  wrapper emits a "fixing" thinking block HARDCODED at index 0 (routes L862-872)
  and shifts recovered content +1. But continuation already advanced
  `current_block_index` past 0 and emitted blocks at 0..k → the hardcoded index-0
  "fixing" block COLLIDES with already-sent round-1 blocks. This is a NEW
  collision the patch introduces into existing recovery code.
- LIKELIHOOD: MEDIUM (only when continuation + empty + flatten co-occur, but that
  combo is plausible since continuation rounds are empty-prone, #4).
- GUARD: the flatten "fixing" status block (and the `_shift_block_index` base)
  must use the CURRENT next-free index, not hardcoded 0, once any content has been
  emitted this message. Make the recovery index-aware. STRONG must-fix.

## (17) `continue` keeps reading the drained upstream stream — BREAK, NEW ROUND
- FAILURE: today web_search does `continue` on the SAME `parse_kiro_stream` loop
  (L453). For continuation you must BREAK the current round's parse, launch the
  re-call, and start a NEW parse loop. Reusing `continue` reads the already-ended
  upstream → no events → ends with only the summary (the bug persists).
- LIKELIHOOD: HIGH if copied from current code.
- GUARD: explicit round-loop structure; web_search-only round → break inner parse
  → build payload → re-call → new parse loop. Never `continue` the drained stream.

## (18) First-token timeout on continuation rounds — RETRY OR GRACEFUL END
- FAILURE: `parse_kiro_stream(response, first_token_timeout)` raises
  `FirstTokenTimeoutError` if the continuation upstream stalls; round 0 has
  `stream_with_first_token_retry_anthropic`, continuation does not → exception
  mid-message → missing message_stop (#3).
- LIKELIHOOD: MEDIUM.
- GUARD: wrap each continuation round's parse in the same first-token timeout +
  retry; on final failure → graceful end_turn + message_stop (#6 discipline).

## (19) MCP search fails mid-continuation (results is None) — FOLD NOTE, STILL STOP
- FAILURE: current code logs + falls through with NO block when `results is None`
  (L378). In continuation that leaves a resolved-intent with nothing folded; if
  mishandled you can dangle a server_tool_use with no result.
- LIKELIHOOD: MEDIUM (MCP timeouts/5xx).
- GUARD: on MCP failure during continuation, fold a "[search failed]" note into
  the payload and either do ONE final no-tool round or end the message; ALWAYS
  close with message_stop; never dangle a server_tool_use.

## (20) Message-level stop_reason must reflect the LAST round — NO HARDCODE
- FAILURE: hardcoding `end_turn` on the final message is wrong if the last round
  ended on a client tool_use (#11, needs `tool_use`) or max_tokens. An unknown/
  custom stop_reason THROWS in pi's mapStopReason (RE finding C).
- LIKELIHOOD: MEDIUM.
- GUARD: message-level stop_reason = the LAST round's stop_reason, constrained to
  pi's known set (end_turn/tool_use/max_tokens/stop_sequence). Never a custom
  value.

## (21) max_tokens / length truncation mid-continuation — DON'T LOOP A TRUNCATION
- FAILURE: a round hits max_tokens (stop_reason=length) before searching or before
  finishing; blindly continuing loops on a truncated state.
- LIKELIHOOD: LOW-MEDIUM.
- GUARD: if a round ends `length`/`max_tokens`, do NOT auto-continue; close the
  message with that stop_reason (pi maps length→stop and stops cleanly).

## (22) No heartbeat during MCP + re-call gaps — PING THROUGH THE GAP
- FAILURE: MCP resolution + upstream re-call can take many seconds with ZERO bytes
  streamed; clients/intermediary proxies idle-timeout the SSE connection.
- LIKELIHOOD: MEDIUM.
- GUARD: emit `event: ping` periodically during MCP resolution and the
  continuation re-call (mirror the wrapper's `_PING`-during-backoff). pi drops
  ping (harmless).

---

## RANKED MUST-FIX GUARDS BEFORE SHIP

TIER 1 — SHIP-BLOCKERS (pi THROWS / corruption / infinite loop / cost):
1. EXACTLY ONE envelope across all rounds: one `message_start` + one
   `message_delta` + one `message_stop`, emitted on EVERY exit path (normal, cap,
   empty, upstream error, timeout) via an idempotent terminal in `finally:`. (#3,
   #18, #20)
2. ONE monotonic `current_block_index` shared across all rounds; never reset; only
   block-open booleans reset per round; `assert new_index > max_started_index`.
   (#2)
3. HARD round cap `WEB_SEARCH_MAX_ROUNDS` + query dedupe; STRIP the web_search
   tool on the final permitted round; always close with end_turn+message_stop on
   cap/dedupe. (#1)
4. Continuation upstream non-200 / first-token-timeout → retry then GRACEFUL
   end_turn+message_stop with results preserved; NEVER a bare `event: error` after
   content, never a missing message_stop. (#6, #18)
5. Gate the WHOLE continuation on `WEB_SEARCH_CONTINUE and not x-no-web-search`;
   header disables inject AND continuation (no compaction-summary poisoning). (#9)
6. Round-loop must BREAK the drained parse and start a NEW parse per round — not
   `continue` the dead stream. (#17)

TIER 2 — MUST-FIX BEFORE BROAD USE (silent wrongness / known-prone paths):
7. Empty continuation round → route through the SAME empty-retry/flatten as round
   0; degrade to summary+end_turn, never contentless stop; suppress double
   placeholder. (#4)
8. Any pi-executable client tool_use in a round → STOP, emit it, stop_reason=
   tool_use, let pi drive; continue ONLY on web_search-only rounds. (#11)
9. Flatten "fixing" status + `_shift_block_index` must use the NEXT-FREE index, not
   hardcoded 0, once continuation has emitted blocks. (#16)
10. GeneratorExit: close every round's upstream response + MCP client in
    `finally:`; never `yield` after GeneratorExit. (#5)
11. Visibility/ordering: HIDE raw `<web_search>` from the client by default
    (payload-only); preserve thinking-before-text; sign thinking; opt-in to show
    raw. Fixes ordering + poisoning + token bloat together. (#14, #10)

TIER 3 — SHOULD-FIX (correctness / observability / parity):
12. Token-budget ceiling + bounded folded context per round; pre-call budget gate
    aborts before `model_max − headroom`. (#7)
13. Deep-copy request_data per round; continuation hits Kiro directly (no public-
    route recursion, no per-round re-injection). (#15, #8)
14. Cumulative output_tokens in the single message_delta; log growing input. (#13)
15. Non-streaming parity in `collect_anthropic_response` (or at minimum never
    return a dangling server web_search tool_use). (#12)
16. Heartbeat pings during MCP + re-call gaps. (#22)
17. MCP-failure-mid-continuation → fold "[search failed]" note, still close
    message_stop. (#19)
18. Don't auto-continue a length/max_tokens-truncated round. (#21)
