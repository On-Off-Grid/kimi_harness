# Reverse-Engineering pi's Anthropic Streaming Client + Agent Loop

Target: `@earendil-works/pi-coding-agent` (installed at
`/home/<user>/.local/lib/node_modules/@earendil-works/pi-coding-agent`).

The real logic lives in two sibling packages bundled under that package's
`node_modules`:
- `@earendil-works/pi-ai` — the provider/streaming layer (Anthropic SSE client).
- `@earendil-works/pi-agent-core` — the agent loop (continue-vs-stop decision).

All paths below are relative to:
`/home/<user>/.local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/`

---

## STATUS: COMPLETE — all 4 questions answered with verified line citations.

## FINDING A — Which SSE events pi parses at all (anthropic.js)

File: `pi-ai/dist/providers/anthropic.js`

### A.1 Whitelist of SSE event types (lines 132-145)
```js
const ANTHROPIC_MESSAGE_EVENTS = new Set([
    "message_start",
    "message_delta",
    "message_stop",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
]);
```
In `iterateAnthropicEvents` (~line 268):
```js
if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
    continue;   // any other SSE event type is DROPPED
}
```
- `event: error` → throws `new Error(sse.data)`.
- A `ping` event is dropped (not in the set) — harmless.
- **Consequence:** the SSE *event name* must be one of those six. Custom event
  names will be ignored. Standard Anthropic names are fine.

### A.2 Stream-completion guard (~line 285)
```js
if (sawMessageStart && !sawMessageEnd) {
    throw new Error("Anthropic stream ended before message_stop");
}
```
- A `message_start` event MUST be matched by a `message_stop` event or the whole
  turn throws (becomes stopReason "error"). So both bookends are mandatory.

---

## FINDING B — server_tool_use / web_search_tool_result are DROPPED

File: `pi-ai/dist/providers/anthropic.js`, in `content_block_start` handler
(~lines 360-430).

The handler has branches ONLY for:
- `event.content_block.type === "text"`      → pushes a `text` block
- `event.content_block.type === "thinking"`  → pushes a `thinking` block
- `event.content_block.type === "redacted_thinking"` → pushes a `thinking` block
- `event.content_block.type === "tool_use"`  → pushes a `toolCall` block

There is **NO branch** for `server_tool_use` and **NO branch** for
`web_search_tool_result` (nor `web_search_result`, `citations`, etc). They fall
through with no `else`, so:
- No content block is created in `output.content`.
- `content_block_delta` for those indices finds no matching block
  (`blocks.findIndex((b) => b.index === event.index)` returns -1) and is ignored.
- `content_block_stop` for those indices finds no block and is ignored.

=> **CONFIRMED: pi does NOT support Anthropic native server-side web_search.**
It silently discards `server_tool_use` and `web_search_tool_result` blocks. Only
`text` and `thinking` survive into the stored assistant message. (Matches the
user's empirical proof.)

Grep over the entire installed tree confirms the strings `server_tool_use` and
`web_search_tool_result` appear NOWHERE in any dist .js. (see checkpoint 2)

---

## FINDING C — stop_reason mapping (anthropic.js mapStopReason, ~line 940)

```js
function mapStopReason(reason, stopDetails) {
    switch (reason) {
        case "end_turn":      return { stopReason: "stop" };
        case "max_tokens":    return { stopReason: "length" };
        case "tool_use":      return { stopReason: "toolUse" };
        case "refusal":       return { stopReason: "error", errorMessage: ... };
        case "pause_turn":    return { stopReason: "stop" }; // "Stop is good enough -> resubmit"
        case "stop_sequence": return { stopReason: "stop" };
        case "sensitive":     return { stopReason: "error" };
        default: throw new Error(`Unhandled stop reason: ${reason}`);
    }
}
```
Set in the `message_delta` handler:
```js
else if (event.type === "message_delta") {
    if (event.delta.stop_reason) {
        const stopReasonResult = mapStopReason(event.delta.stop_reason, event.delta.stop_details);
        output.stopReason = stopReasonResult.stopReason;
        ...
```
So the Anthropic wire `stop_reason` maps to pi's internal `stopReason`:
- `end_turn`  -> `"stop"`
- `tool_use`  -> `"toolUse"`
- `pause_turn`-> `"stop"`

Internal `stopReason` is what the agent loop reads (see FINDING D next).

NOTE: An unknown/custom stop_reason string (anything not in the switch) THROWS
=> turn becomes an error. Must use one of the known wire values.

---

## FINDING D — *** THE CORE ANSWER *** Agent loop continue-vs-stop is driven by
## the presence of `toolCall` content blocks, NOT by `stop_reason`.

File: `pi-agent-core/dist/agent-loop.js`, function `runLoop` (~lines 86-175).

The loop structure:
```js
while (true) {                       // outer loop (follow-up messages)
  let hasMoreToolCalls = true;
  while (hasMoreToolCalls || pendingMessages.length > 0) {   // inner loop
    ...
    const message = await streamAssistantResponse(...);   // one completion
    newMessages.push(message);

    // (1) ONLY stopReason check in the whole loop:
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      await emit({ type: "turn_end", ... });
      await emit({ type: "agent_end", messages: newMessages });
      return;                          // hard stop on error/abort only
    }

    // (2) continue decision is based on toolCall BLOCKS, not stop_reason:
    const toolCalls = message.content.filter((c) => c.type === "toolCall");
    hasMoreToolCalls = false;
    if (toolCalls.length > 0) {
      const executedToolBatch = await executeToolCalls(...);
      toolResults.push(...executedToolBatch.messages);
      hasMoreToolCalls = !executedToolBatch.terminate;     // keep looping
      for (const result of toolResults) {
        currentContext.messages.push(result);
        newMessages.push(result);
      }
    }
    await emit({ type: "turn_end", message, toolResults });
    ...
    if (await config.shouldStopAfterTurn?.({...})) { agent_end; return; }
    pendingMessages = (await config.getSteeringMessages?.()) || [];
  }
  // inner loop exited => agent would stop. Check follow-up queue:
  const followUpMessages = (await config.getFollowUpMessages?.()) || [];
  if (followUpMessages.length > 0) { pendingMessages = followUpMessages; continue; }
  break;
}
await emit({ type: "agent_end", messages: newMessages });
```

Key consequences (verified by grep: in agent-loop.js the ONLY stopReason
reference is line 107, the `=== "error" || === "aborted"` check):

- `stopReason` values `"stop"` (end_turn), `"toolUse"` (tool_use), `"length"`
  (max_tokens) are **treated identically** by the loop. The loop does NOT look
  at stop_reason to decide whether to continue.
- The loop continues **iff** the assistant message contained at least one
  `toolCall` content block AND the executed batch did not request terminate.
- `executeToolCalls` builds `toolResult` messages and pushes them into context.
  Those tool results are what make the NEXT completion happen (inner loop
  re-enters because `hasMoreToolCalls` is true).

### ANSWER to question (1):
`stop_reason=tool_use` with NO client `toolCall` block (only server_tool_use +
text, which pi already drops):
- `message.stopReason` becomes `"toolUse"` — but that value is never inspected.
- `message.content.filter(type==="toolCall")` = **[]** (empty), because
  server_tool_use is dropped and produces no `toolCall` block.
- `toolCalls.length === 0` => `hasMoreToolCalls` stays `false`.
- No tool results are produced, so nothing new is appended to context.
- Inner loop condition `hasMoreToolCalls || pendingMessages.length>0` is false
  => inner loop exits. Follow-up queue is empty in headless `-p` => outer loop
  breaks => `agent_end`.
=> **pi STOPS. It does NOT continue and does NOT error.** Identical outcome to
  `end_turn`. So switching end_turn→tool_use alone changes nothing in the loop
  (any "follow-up request" the user saw came from a higher layer — see FINDING F).

### ANSWER to question (2): MINIMAL SSE that continues the loop WITHOUT a
### client-executable tool:
There is **no** stop_reason that makes pi resubmit on its own. The loop only
re-enters when there is a `toolResult` message to send back, and a `toolResult`
is only produced by executing a **client `tool_use` block** whose name matches a
tool in `context.tools`. Therefore the ONLY in-loop way to force another
completion is to emit a real client-side `tool_use` block that pi will execute
and whose result is fed back. (Concrete recommended shape in the summary.)

---

## FINDING E — WHY a `tool_use` stop_reason produced "a follow-up request" but
## still no final answer (the unknown-tool path).

This is the higher layer the user actually hit. Two relevant facts:

### E.1 Print mode just prints the LAST assistant message's text blocks.
File: `pi-coding-agent/dist/modes/print-mode.js` (~lines 100-120):
```js
const lastMessage = state.messages[state.messages.length - 1];
if (lastMessage?.role === "assistant") {
  const assistantMsg = lastMessage;
  if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
    console.error(...); exitCode = 1;
  } else {
    for (const content of assistantMsg.content)
      if (content.type === "text") writeRawStdout(`${content.text}\n`);
  }
}
```
`pi -p` text mode prints `text` blocks of the final assistant message only. If
the loop stops on the search turn, the printed text is the `<web_search>` summary
you injected — NOT a synthesized answer. `--mode json` streams every event as
JSON and exits when the run resolves (no special stop logic; same loop).

### E.2 If the model emits a CLIENT `tool_use` block for a tool pi cannot find,
the loop DOES continue — with a synthetic error tool result.
File: `pi-agent-core/dist/agent-loop.js`, `prepareToolCall` (~line 305):
```js
const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
if (!tool) {
  return { kind: "immediate",
           result: createErrorToolResult(`Tool ${toolCall.name} not found`),
           isError: true };
}
```
and `shouldTerminateToolBatch` (~line 280):
```js
function shouldTerminateToolBatch(finalizedCalls) {
  return finalizedCalls.length > 0 &&
         finalizedCalls.every((finalized) => finalized.result.terminate === true);
}
```
An error tool result has `terminate` undefined => batch does NOT terminate =>
`hasMoreToolCalls = true` => the loop sends another completion with a
`tool_result` ("Tool X not found") appended. THIS is the "follow-up request" the
user observed when they set stop_reason=tool_use AND the model text contained a
tool call the gateway mislabeled. But because the only thing fed back is an
error ("not found"), the model has no web results to use, so it still cannot
produce a grounded final answer. Net: extra request, still no answer.

KEY: a follow-up completion only happens when there is a real `toolResult`
message. `server_tool_use` never becomes a `toolCall` block (FINDING B), so it
never yields a `toolResult`, so on its own it never triggers a follow-up.

### E.3 No iteration cap in the loop.
grep for maxIterations/maxTurns/maxSteps in agent-loop.js and agent.js => none.
The loop runs until no toolCall blocks remain (or error/abort). So a sequence of
client tool calls + tool results will keep looping until the model emits an
assistant message with NO toolCall blocks (i.e., the final answer).

---

## FINDING F — Session-level continuation (`agent-session.js`) only fires on
## retryable ERROR, compaction, or queued messages — never on a clean stop.

File: `pi-coding-agent/dist/core/agent-session.js`.
`_runAgentPrompt` (~line 655):
```js
await this.agent.prompt(messages);
while (await this._handlePostAgentRun()) {
  await this.agent.continue();
}
```
`_handlePostAgentRun` (~line 668) returns true (=> `agent.continue()`) only if:
1. `_isRetryableError(msg)` AND `_prepareRetry(msg)` succeeded, OR
2. `_checkCompaction(msg)` (context overflow) returned true, OR
3. `this.agent.hasQueuedMessages()` (steering / follow-up queue non-empty).

`_isRetryableError` (~line 1968) **requires `message.stopReason === "error"`**:
```js
if (message.stopReason !== "error" || !message.errorMessage) return false;
```
So a clean `end_turn`("stop") or `tool_use`("toolUse") with no tool blocks is NOT
retried at the session layer. In headless `pi -p --no-session` the steering /
follow-up queues are empty, so `agent.continue()` is never called for a clean
stop. => The run terminates right after the search turn. (Matches the user's
empirical result.)

Also note `agent.continue()` -> `runContinuation()` -> `runAgentLoopContinue`,
which THROWS "Cannot continue from message role: assistant" if the last message
is an assistant message with no queued user/toolResult message. So you cannot
"just resubmit" after a clean assistant stop without adding a user/toolResult
message.

---

## FINDING G — What pi PERSISTS from the assistant message (drops the rest).

File: `pi-ai/dist/providers/anthropic.js`, `convertMessages` assistant branch
(~lines 690-770). When pi sends history BACK to the API it only emits, per
assistant message:
- `text` blocks (non-empty)
- `thinking` blocks (with signature, else downgraded to text)
- `tool_use` blocks (from internal `toolCall`)
There is no path that emits `server_tool_use` or `web_search_tool_result`
because those block types never exist in `output.content` (FINDING B). So even
across turns, web search results are not retained. Confirms the user's proof
that pi keeps only text+thinking.

---

## EXACT LINE-NUMBER CITATION INDEX (verified)

Base: `/home/<user>/.local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/`

pi-ai/dist/providers/anthropic.js
- 132-145  ANTHROPIC_MESSAGE_EVENTS whitelist (the 6 event names)
- 261-263  `if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) continue;`  (drops unknown events)
- 256-258  `if (sse.event === "error") throw new Error(sse.data);`
- 279-281  `if (sawMessageStart && !sawMessageEnd) throw "ended before message_stop"`
- 359-367  content_block_start: type === "text"  -> push text block
- 368-377  content_block_start: type === "thinking"
- 378-388  content_block_start: type === "redacted_thinking"
- 389-410  content_block_start: type === "tool_use" -> push internal "toolCall" block
           (NO branch for server_tool_use / web_search_tool_result -> dropped)
- 489-518  message_delta: reads event.delta.stop_reason -> mapStopReason -> output.stopReason
- 944-969  mapStopReason: end_turn->stop, max_tokens->length, tool_use->toolUse,
           pause_turn->stop, refusal/sensitive->error, default-> THROW

pi-agent-core/dist/agent-loop.js
- 84       outer `while (true)` (follow-up loop)
- 85       `let hasMoreToolCalls = true;`
- 87       inner `while (hasMoreToolCalls || pendingMessages.length > 0)`
- 104      `const message = await streamAssistantResponse(...)`
- 107-111  ONLY stopReason check: `=== "error" || === "aborted"` -> agent_end/return
- 113      `const toolCalls = message.content.filter((c) => c.type === "toolCall")`
- 116-122  if toolCalls.length>0: execute, `hasMoreToolCalls = !executedToolBatch.terminate`, push toolResults
- 145-153  `if (await config.shouldStopAfterTurn?.(...)) { agent_end; return; }`
- 157-162  follow-up queue drain -> continue outer loop, else break
- 344-346  shouldTerminateToolBatch: terminate only if EVERY result.terminate === true
- 361-367  prepareToolCall: tool not found -> immediate error result (isError true, terminate undefined)

pi-agent-core/dist/agent.js
- 246-247  continue(): if last msg is assistant + queues empty -> throw "Cannot continue from message role: assistant"
- 268-272  runContinuation -> runAgentLoopContinue

pi-coding-agent/dist/modes/print-mode.js
- 102-114  text mode prints only `text` blocks of the LAST assistant message;
           error/aborted -> stderr + exit 1
- 80-83    json mode: writeRawStdout(JSON.stringify(event)) for every event

pi-coding-agent/dist/core/agent-session.js
- 656-664  _runAgentPrompt: `await agent.prompt(messages); while (_handlePostAgentRun()) agent.continue();`
- 667-690  _handlePostAgentRun: continue only if retryable error / compaction / hasQueuedMessages
- 827      prompt() awaits _runAgentPrompt (so `pi -p` blocks until agent_end)
- 1968-1981 _isRetryableError: requires stopReason === "error"

==========================================================================
## RECOMMENDED FIX (gateway "Path B" -> continue after server-side web_search)
==========================================================================

ROOT CAUSE: pi's continue-vs-stop decision ignores `stop_reason`. It loops again
ONLY when the assistant turn contains a CLIENT `tool_use` content block whose
name matches a tool pi advertised in the request, because executing that tool is
what produces a `tool_result` that gets fed into the next completion. pi drops
`server_tool_use` / `web_search_tool_result` entirely, and an `end_turn` or a
`tool_use` stop_reason with no client tool block both make the loop stop.

So the gateway must STOP emulating Anthropic's *server-side* web search (Path B)
as the final turn, and instead emulate a *client-side* tool round-trip that pi
itself drives. Two viable shapes:

------------------------------------------------------------------
### OPTION 1 (RECOMMENDED, robust): expose web_search as a CLIENT tool and let
### pi run the round-trip. The gateway resolves the search on the SECOND request.
------------------------------------------------------------------
This works WITH pi's loop instead of against it. No pi changes needed.

Preconditions: pi must send a tool named e.g. `web_search` in `params.tools`
(i.e. the subagent must have such a tool registered). If pi does NOT advertise a
web_search tool, see Option 2.

Turn 1 (model wants to search) — emit a normal CLIENT tool_use block:
```
event: message_start
data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"...","content":[],"stop_reason":null,"usage":{"input_tokens":N,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me search."}}
event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_ws_1","name":"web_search","input":{}}}
event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"query\":\"...\"}"}}
event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":M}}
event: message_stop
data: {"type":"message_stop"}
```
pi executes its `web_search` tool -> produces a `tool_result` -> sends Turn 2
request automatically. The gateway sees the tool_result + does the real search
OR (if the tool runs client-side) the client tool already returned results.

Turn 2 request arrives at the gateway with a `tool_result` for `toolu_ws_1`.
The gateway forwards to upstream WITH the results in context; upstream emits the
final grounded answer ending in `stop_reason:"end_turn"`. pi sees no tool blocks
-> loop stops -> prints the final answer. DONE.

Caveat: requires a real client-side `web_search` tool to exist in the subagent.
The tool's job can be trivial (echo the query) because the GATEWAY injects the
actual search results when it sees the follow-up request — but pi must still have
a tool by that name or `prepareToolCall` returns "Tool web_search not found"
(still loops once, but feeds back only an error -> no grounded answer).

------------------------------------------------------------------
### OPTION 2 (no pi tool available): fold web results into TEXT on a SINGLE turn
### and end with end_turn. Do the search BEFORE the model's final generation.
------------------------------------------------------------------
Because pi keeps only text+thinking, the only channel that survives is text.
So the gateway should, server-side:
  1. Detect the model's intent to search (its first upstream pass).
  2. Resolve the web_search upstream.
  3. Re-prompt upstream WITH the results, so upstream produces a FINAL
     grounded answer.
  4. Stream to pi a SINGLE assistant turn containing ONLY that final answer as
     text (optionally a `<web_search>` digest first), ending with
     `stop_reason:"end_turn"`.
i.e. the gateway hides the entire search round-trip and emits one finished
answer. pi stops (correctly) and prints the grounded answer.

This is the simplest correct behavior for headless `pi -p`: never surface the
search as a separate stopping turn; only emit the final synthesized text.

------------------------------------------------------------------
### WHAT DOES NOT WORK (verified against the code)
------------------------------------------------------------------
- Emitting `server_tool_use` + `web_search_tool_result` blocks: pi DROPS them
  (anthropic.js has no content_block_start branch for them). Lines 359-410.
- Setting `stop_reason:"tool_use"` while emitting ONLY a server_tool_use block
  (no client tool_use block): produces zero `toolCall` blocks -> loop treats it
  exactly like end_turn and STOPS. (agent-loop.js 113-122.)
- Relying on a custom stop_reason to signal "continue": mapStopReason THROWS on
  unknown values (anthropic.js default branch, lines 963-965) -> turn errors out.
- Expecting the session layer to auto-resubmit after a clean stop: it only
  resubmits on retryable *errors*, compaction, or queued messages
  (agent-session.js 667-690, 1968-1981). Headless `-p` has none of these.
- Emitting a `tool_use` for a tool pi did NOT advertise: pi continues ONE turn
  but feeds back only "Tool X not found", so no grounded answer.

------------------------------------------------------------------
### RUNTIME PATH CONFIRMATION
------------------------------------------------------------------
The default streaming path actually used by the agent loop:
- agent-loop.js:186  `const streamFunction = streamFn || streamSimple;`
- pi-ai register-builtins.js:204-206  api "anthropic-messages" -> stream: streamAnthropic,
  streamSimple: streamSimpleAnthropic
- streamSimpleAnthropic delegates to streamAnthropic (anthropic.js streamSimpleAnthropic).
So the content_block drop logic + mapStopReason + the loop's toolCall-driven
continuation are ALL on the real runtime path for an Anthropic-API model (which
is what the kiro-gateway presents as). Confirmed, not assumed.

## STATUS: COMPLETE
