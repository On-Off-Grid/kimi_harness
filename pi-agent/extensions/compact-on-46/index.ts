/**
 * Empty-driven auto-compaction via Sonnet 4.6, then resume on Opus 4.8
 * --------------------------------------------------------------------
 * Root cause (proven by concurrent swarm): opus-4.8 returns a zero-output ("empty")
 * completion once a request's INPUT TOKEN VOLUME crosses a soft threshold (the line
 * drifts with upstream load). Sonnet 4.6 is retained as the conservative recovery
 * summarizer rather than using the coordinator model for the large-context summary.
 * pi's built-in auto-compaction only triggers near the context WINDOW (~1M for
 * opus-4.8) — i.e. ~20x ABOVE where 4.8 actually empties — so it never fires in time.
 *
 * This extension closes that gap. It does TWO things:
 *
 *  (A) TRIGGER (turn_end): when a turn comes back as a true empty/placeholder stall
 *      we call ctx.compact() — i.e. an empty completion is treated as "context is in
 *      the 4.8 empty zone, shrink it now" instead of just idling.
 *
 *  (B) SUMMARIZE ON 4.6 (session_before_compact): whichever way compaction is
 *      triggered (our empty-trigger, pi's auto, or /compact), the summary is produced
 *      by Sonnet 4.6 instead of the session model (Opus 4.8).
 *      Otherwise the summarization request itself empties on the large context (the
 *      cambium "Turn prefix summarization failed" / poisoned "(no output)" summary).
 *
 * After compaction the session reloads at reduced token volume and the hunt RESUMES
 * on opus-4.8. No history rewrite, no tool-call-format poisoning (unlike flatten).
 *
 * Gated COMPACT_ON_46 (default on). Trigger gated COMPACT_ON_46_ON_EMPTY (default on).
 */

import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";

const enabled = () => process.env.COMPACT_ON_46 !== "0";
const triggerOnEmpty = () => process.env.COMPACT_ON_46_ON_EMPTY !== "0";

// File-based debug trace (always on; cheap). Tail with: tail -f /tmp/compact-on-46.log
const DLOG_PATH = process.env.COMPACT_ON_46_LOG || "/tmp/compact-on-46.log";
function dlog(...parts: any[]) {
  try {
    const line = `${new Date().toISOString()} [${process.pid}] ${parts
      .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
      .join(" ")}\n`;
    fs.appendFileSync(DLOG_PATH, line);
  } catch {
    /* never crash on logging */
  }
}

const SUMMARIZER_PROVIDER = process.env.COMPACT_ON_46_PROVIDER || "openrouter";
const SUMMARIZER_MODEL = process.env.COMPACT_ON_46_MODEL || "anthropic/claude-sonnet-4.6";
const SUMMARY_MAX_TOKENS = (() => {
  const v = parseInt(process.env.COMPACT_ON_46_MAXTOK || "", 10);
  return Number.isFinite(v) && v >= 1024 && v <= 32000 ? v : 12000;
})();
// Don't compact a tiny context (an empty there is transient, not size-driven) —
// Don't compact a tiny context (an empty there is transient, not size-driven) —
// compacting wouldn't help and would waste a summary. Gate on ACTUAL context size via
// ctx.getContextUsage(), NOT a turn counter: after a session load/rewind the turn count
// resets to 0 while the context is still huge, so a turn-count proxy wrongly skips a
// large context (observed: luxretail emptied at 128k tokens right after a rewind).
// The original Kiro observations placed Opus 4.8 empties around ~30-80k; retain the
// conservative threshold while direct-OpenRouter behavior is established. Compact
// on empty once the context is above this many tokens (well above the floor, so
// compaction actually shrinks it meaningfully). Below it, let the watchdog retry.
const MIN_TOKENS_TO_COMPACT = (() => {
  const v = parseInt(process.env.COMPACT_ON_46_MIN_TOKENS || "", 10);
  return Number.isFinite(v) && v >= 1000 ? v : 50000;
})();

const PLACEHOLDER_RE = /^\s*\((?:no output|empty placeholder|continuing)\)\s*$/i;

function lastText(message: any): string {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b: any) => b && b.type === "text").map((b: any) => b.text || "").join("\n");
  return "";
}
function hasToolCall(message: any): boolean {
  const c = message?.content;
  return Array.isArray(c) && c.some((b: any) => b && (b.type === "toolCall" || b.type === "tool_use"));
}
// A true empty/placeholder turn = no tool call, no progress, and text is empty or a
// provider/extension give-up placeholder.
function isEmptyTurn(message: any, madeProgress: boolean): boolean {
  if (madeProgress) return false;
  if (hasToolCall(message)) return false;
  // CRITICAL: an ERROR or ABORTED turn (504 'Streaming failed after N attempts', network
  // failure, rate-limit exhaustion, user/▶ abort) also has empty text — but it is a TRANSIENT
  // transport failure, NOT the opus-4.8 'emptied on large context' stall that compaction
  // fixes. Compacting on a 504 is wrong (it throws away context for a retryable blip). Only a
  // CLEAN finish (stopReason 'stop'/'end_turn'/'endTurn', or a '(no output)' placeholder)
  // with empty text is a real empty stall. Errors/aborts -> let the watchdog/
  // upstream retry handle them (but see isErrorTurn + the PERSISTENT-504 escalation below).
  const sr = String(message?.stopReason ?? message?.stop_reason ?? "").toLowerCase();
  if (sr === "error" || sr === "aborted" || sr === "abort" || sr === "canceled" || sr === "cancelled") {
    return false;
  }
  const t = (lastText(message) || "").trim();
  return t.length === 0 || PLACEHOLDER_RE.test(t);
}

// An ERROR turn (504 'Streaming failed after N attempts', upstream api_error, network).
// A SINGLE one is transient (the watchdog retries it). But PERSISTENT 504s at a large
// context usually mean opus-4.8 cannot get a 735k-account-saturated request through the
// 429/empty wall — there, compacting to a much smaller context via Sonnet 4.6 (which does
// not empty) is the escape hatch. We count consecutive error turns and escalate to
// compaction once they cross COMPACT_ON_46_ERR_STREAK (operator-requested 504 cap).
function isErrorTurn(message: any, madeProgress: boolean): boolean {
  if (madeProgress) return false;
  if (hasToolCall(message)) return false;
  const sr = String(message?.stopReason ?? message?.stop_reason ?? "").toLowerCase();
  return sr === "error" || sr === "aborted" || sr === "abort" || sr === "canceled" || sr === "cancelled";
}

export default function compactOn46(pi: ExtensionAPI) {
  let compacting = false; // guard: one compaction in flight at a time
  let resumeAfterCompact = false; // set by the empty-trigger; consumed by session_compact
  let restoreWorkingOnResume = false; // set on resume; consumed by agent_start to fix the working-row UI glitch
  // Loop-breaker state: opus-4.8 can empty even on an already-minimal post-compaction
  // context (~60k = coordinator's ~31k tools+sys floor + kept summary + recent turns).
  // Compacting again is futile (nothing left to summarize: session_before_compact comes
  // back msgs:0/prefix:0 and tokens barely move), so a naive "empty -> compact" loops
  // forever. We track the token level we last compacted AT and how many compactions ran
  // since the last time real work happened. If a new empty is not meaningfully smaller
  // than the last compaction, OR we have compacted repeatedly with no progress, we STOP
  // compacting and defer to the watchdog (a plain retry; empties are probabilistic and
  // usually clear on the next attempt at the same size).
  let lastCompactAtTokens = 0; // token level of the most recent empty-triggered compaction
  let consecutiveCompactsNoProgress = 0; // compactions since the last real (tool/progress) turn
  let consecutiveErrorTurns = 0; // consecutive 504/error turns (operator-requested 504->compact cap)
  // STALE-USAGE FIX (luxretail post-compaction stall, proven 2026-06-18): after a successful
  // compaction the real context shrinks (e.g. 211k -> ~42k), but pi's ctx.getContextUsage()
  // "uses last assistant usage when available" and an EMPTY/placeholder turn does NOT refresh
  // that stat — so getContextUsage() keeps returning the STALE pre-compaction value (211k).
  // The loop-breaker then sees stale(211k) ~= lastCompactAtTokens(211k) and WRONGLY concludes
  // "floor reached, no more shrink" and defers forever, even though the real context is now
  // small enough to work. FIX: capture the REAL post-compaction floor from session_before_
  // compact (a reliable signal, not the stale turn_end read) and (a) judge the loop-breaker
  // against that real floor and (b) suppress the stale-read loop-breaker for the FIRST empty
  // after a compaction (until a real, non-empty assistant turn refreshes getContextUsage).
  let postCompactRealTokens = 0; // real context size right AFTER the last successful compaction
  let suppressLoopBreakerUntilRealTurn = false; // set on compaction; cleared by a real refreshing turn
  const MIN_SHRINK = (() => {
    const v = parseInt(process.env.COMPACT_ON_46_MIN_SHRINK || "", 10);
    return Number.isFinite(v) && v >= 1000 ? v : 15000;
  })();
  const MAX_NOPROGRESS_COMPACTS = (() => {
    const v = parseInt(process.env.COMPACT_ON_46_MAX_LOOP || "", 10);
    return Number.isFinite(v) && v >= 1 ? v : 1;
  })();
  // After this many CONSECUTIVE 504/error turns at a large context, escalate to a Sonnet 4.6
  // compaction (operator-requested 504 cap): persistent 504s usually mean opus-4.8 cannot get
  // the large request through the 429/empty wall, and shrinking the context is the escape.
  const ERR_STREAK_TO_COMPACT = (() => {
    const v = parseInt(process.env.COMPACT_ON_46_ERR_STREAK || "", 10);
    return Number.isFinite(v) && v >= 1 ? v : 3;
  })();
  dlog("extension loaded", { enabled: enabled(), triggerOnEmpty: triggerOnEmpty(), minTok: MIN_TOKENS_TO_COMPACT, minShrink: MIN_SHRINK, maxLoop: MAX_NOPROGRESS_COMPACTS });

  // ---- (A) TRIGGER: empty completion -> compact (then resume on 4.8) ----------
  pi.on("turn_end", async (event, ctx) => {
    if (!enabled() || !triggerOnEmpty()) return;
    if (ctx.mode !== "tui") { dlog("turn_end: skip (mode=" + ctx.mode + ")"); return; }
    const msg: any = (event as any)?.message;
    const toolResults = (event as any)?.toolResults;
    const madeProgress = Array.isArray(toolResults) && toolResults.length > 0;
    const emptyTurn = isEmptyTurn(msg, madeProgress);
    dlog("turn_end", { madeProgress, hasToolCall: hasToolCall(msg), emptyTurn, text: (lastText(msg) || "").trim().slice(0, 40) });

    // Only act on a true empty/placeholder stall (no tool call, no progress, empty/
    // placeholder text). Real work and substantive text turns are left alone, and a
    // real (progress) turn resets the loop-breaker.
    if (madeProgress || hasToolCall(msg)) {
      if (consecutiveCompactsNoProgress !== 0 || lastCompactAtTokens !== 0 || consecutiveErrorTurns !== 0 || suppressLoopBreakerUntilRealTurn) {
        dlog("turn_end: real progress, reset loop-breaker + error streak");
      }
      consecutiveCompactsNoProgress = 0;
      lastCompactAtTokens = 0;
      consecutiveErrorTurns = 0;
      // A real (non-empty, tool/progress) assistant turn has now refreshed pi's
      // getContextUsage() with the TRUE post-compaction size, so the stale-read window
      // is over: re-enable the normal loop-breaker.
      suppressLoopBreakerUntilRealTurn = false;
      postCompactRealTokens = 0;
      return;
    }

    // PERSISTENT-504 ESCALATION (operator-requested 504 cap). A single 504/error turn is
    // transient (isEmptyTurn excludes it; the watchdog retries it). But N CONSECUTIVE
    // 504/error turns at a LARGE context usually mean opus-4.8 can't get the big request
    // through the upstream 429/empty wall — there, shrinking via a Sonnet 4.6 compaction is
    // the escape. After ERR_STREAK_TO_COMPACT consecutive errors, fall through into the
    // SAME compaction path used for size-driven empties (size + loop-breaker guards still
    // apply; below-floor errors keep deferring to the watchdog). Coordination with the
    // auto-continue watchdog is unchanged: once we call ctx.compact() pi goes non-idle and
    // the watchdog's (5s-delayed, idle-guarded) error nudge self-suppresses.
    const errorTurn = isErrorTurn(msg, madeProgress);
    if (errorTurn) {
      consecutiveErrorTurns += 1;
      dlog("turn_end: error turn", { consecutiveErrorTurns, threshold: ERR_STREAK_TO_COMPACT });
      if (consecutiveErrorTurns < ERR_STREAK_TO_COMPACT) {
        // not persistent yet — let the watchdog/upstream retry (do NOT compact on a blip)
        return;
      }
      dlog("turn_end: persistent 504/error streak reached -> escalate to Sonnet 4.6 compaction");
      // fall through to the size/loop-breaker-gated compaction path below.
    } else if (!emptyTurn) {
      // substantive-text-no-tool turn (model addressing the user): not our concern.
      consecutiveErrorTurns = 0;
      return;
    }

    if (compacting) { dlog("turn_end: already compacting, skip"); return; }
    // Gate on ACTUAL context size, not a turn counter (survives session load/rewind).
    const usage = ctx.getContextUsage();
    let tokens = usage && typeof usage.tokens === "number" ? usage.tokens : 0;

    // STALE-USAGE WINDOW (luxretail fix): if we just compacted and no real (non-empty)
    // assistant turn has refreshed getContextUsage() yet, `tokens` is the STALE pre-
    // compaction value (empty turns don't refresh it). Trust the REAL post-compaction
    // size we captured at session_before_compact instead, and NEVER let the stale-read
    // loop-breaker fire in this window.
    if (suppressLoopBreakerUntilRealTurn) {
      const realTokens = postCompactRealTokens > 0 ? postCompactRealTokens : tokens;
      dlog("turn_end: empty right after compaction (stale-usage window)", {
        staleTokens: tokens, realPostCompactTokens: realTokens, minTok: MIN_TOKENS_TO_COMPACT,
      });
      // The context was just shrunk by compaction. An empty here is the probabilistic
      // small/medium-context stall, NOT "can't shrink" — a plain retry usually clears it.
      // Defer to the watchdog for a retry and do NOT re-compact (nothing new to summarize
      // until real progress happens). The suppress flag is cleared by the next real turn.
      dlog("turn_end: post-compaction empty -> defer to watchdog (real context already small, retry will clear)");
      return;
    }

    dlog("turn_end: empty stall detected", { tokens, minTok: MIN_TOKENS_TO_COMPACT, lastCompactAtTokens, noProgress: consecutiveCompactsNoProgress });
    if (tokens > 0 && tokens < MIN_TOKENS_TO_COMPACT) {
      // Small context: an empty here is transient, not size-driven. Compacting won't
      // help. Let the watchdog nudge a plain retry instead.
      dlog("turn_end: tokens below floor, defer to watchdog");
      return;
    }
    // LOOP-BREAKER: if we already compacted and this empty is NOT meaningfully smaller
    // than the level we last compacted at, compaction has hit its floor (nothing more
    // to summarize). Compacting again would loop. Stop and defer to the watchdog — a
    // plain retry at the same size usually clears (empties are probabilistic).
    // NOTE: this only runs OUTSIDE the stale-usage window (handled above), so `tokens`
    // here is a fresh getContextUsage() refreshed by a real assistant turn.
    if (
      lastCompactAtTokens > 0 &&
      (tokens >= lastCompactAtTokens - MIN_SHRINK || consecutiveCompactsNoProgress >= MAX_NOPROGRESS_COMPACTS)
    ) {
      dlog("turn_end: compaction floor reached, defer to watchdog (no more shrink possible)", {
        tokens, lastCompactAtTokens, noProgress: consecutiveCompactsNoProgress,
      });
      // Reset so that if real progress later grows the context again, we will compact.
      // Do NOT reset here (we want to keep deferring until progress happens).
      return;
    }
    compacting = true;
    resumeAfterCompact = true; // tell session_compact to kick the hunt forward
    lastCompactAtTokens = tokens;
    consecutiveCompactsNoProgress += 1;
    consecutiveErrorTurns = 0; // escalation consumed; don't immediately re-escalate
    dlog("turn_end: calling ctx.compact()", { resumeAfterCompact, lastCompactAtTokens, noProgress: consecutiveCompactsNoProgress });
    ctx.ui.notify(
      `⚙️ Empty completion (Opus 4.8) at ~${(tokens || 0).toLocaleString()} tok — auto-compacting via Sonnet 4.6 to shrink context, then resuming…`,
      "info",
    );
    ctx.compact({
      customInstructions:
        "Summarize to resume an autonomous bug-bounty hunt with zero loss of operational state.",
      onComplete: async () => {
        compacting = false;
        dlog("ctx.compact onComplete fired");
        // The actual resume is driven by the session_compact lifecycle event (more
        // reliable than this callback: pi has fully finished the compaction + state
        // transition by then). We only clear the in-flight guard here.
      },
      onError: (error: any) => {
        compacting = false;
        resumeAfterCompact = false;
        dlog("ctx.compact onError", { err: String(error?.message || error) });
        ctx.ui.notify(`compact-on-46: trigger compaction failed: ${error?.message || error}`, "warning");
      },
    });
  });

  // ---- (B) SUMMARIZE ON 4.6: customize whatever compaction runs ---------------
  pi.on("session_before_compact", async (event, ctx) => {
    if (!enabled()) return; // default compaction

    const { preparation, signal } = event as any;
    const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;
    dlog("session_before_compact fired", { tokensBefore, msgs: (messagesToSummarize || []).length, prefix: (turnPrefixMessages || []).length, mode: ctx.mode });

    const model = ctx.modelRegistry.find(SUMMARIZER_PROVIDER, SUMMARIZER_MODEL);
    if (!model) {
      ctx.ui.notify(`compact-on-46: ${SUMMARIZER_PROVIDER}/${SUMMARIZER_MODEL} not found — default compaction`, "warning");
      return;
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      ctx.ui.notify(`compact-on-46: auth unavailable for ${SUMMARIZER_MODEL} — default compaction`, "warning");
      return;
    }
    const allMessages = [...(messagesToSummarize || []), ...(turnPrefixMessages || [])];
    if (allMessages.length === 0) return;

    ctx.ui.notify(
      `⚙️ Summarizing ${allMessages.length} msgs (${(tokensBefore || 0).toLocaleString()} tok) on ${SUMMARIZER_MODEL}…`,
      "info",
    );
    const conversationText = serializeConversation(convertToLlm(allMessages));
    const previousContext = previousSummary ? `\n\nPrevious session summary for context:\n${previousSummary}` : "";
    const summaryMessages = [
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text:
              `You are summarizing an autonomous security/bug-bounty hunt so it can continue ` +
              `WITHOUT loss of operational state. The summary REPLACES the older conversation, ` +
              `so it must be self-contained.${previousContext}\n\n` +
              `Capture, in structured markdown:\n` +
              `1. Goal + program/scope (handle, in/out-of-scope assets, severity floor, constraints).\n` +
              `2. Confirmed facts: tech stack, fingerprints, auth flows, endpoints, identities/tokens/cookies in use (reference by name, not raw secret values).\n` +
              `3. Findings: validated, candidate, ruled-out — with exact assets + report paths.\n` +
              `4. Current in-progress test: what is being probed right now + the exact next step.\n` +
              `5. Open leads ranked, and any blockers.\n` +
              `6. Artifact/report file paths and Memory keys already written.\n\n` +
              `Be thorough but compact. Preserve every detail needed to resume the hunt.\n\n` +
              `<conversation>\n${conversationText}\n</conversation>`,
          },
        ],
        timestamp: Date.now(),
      },
    ];
    // Forward only the provider-auth headers; the Kiro-only web-search suppression header
    // is intentionally absent from the direct OpenRouter path.
    const summaryHeaders = { ...(auth.headers || {}) };

    // ROOT-CAUSE FIX (transip stall, proven 2026-06-18): under heavy 429 rate-limiting the
    // Sonnet 4.6 summary call can come back EMPTY. The OLD behavior then `return`ed -> pi
    // ran its DEFAULT Opus 4.8 compaction, which ALSO empties under the same 429 pressure and produces a
    // corrupt near-empty '(no output)'-prefixed summary that barely shrinks context (68k->63k).
    // That strands the session above MIN_TOKENS_TO_COMPACT, the loop-breaker then refuses to
    // re-compact, and the hunt dead-loops on (no output). FIX: (1) retry the 4.6 summary with
    // backoff (the empty is transient — it succeeds once the rate limit clears); (2) if it
    // STILL fails, CANCEL compaction entirely (never fall through to pi's poisoning default)
    // and reset the loop-breaker so the watchdog can retry the original turn cleanly.
    const SUMMARY_TRIES = (() => {
      const v = parseInt(process.env.COMPACT_ON_46_SUMMARY_RETRIES || "", 10);
      return Number.isFinite(v) && v >= 1 && v <= 10 ? v : 4;
    })();
    let summary = "";
    let lastErr: any = null;
    for (let attempt = 1; attempt <= SUMMARY_TRIES; attempt++) {
      if (signal?.aborted) break;
      try {
        const response = await complete(
          model,
          { messages: summaryMessages },
          { apiKey: auth.apiKey, headers: summaryHeaders, maxTokens: SUMMARY_MAX_TOKENS, signal },
        );
        summary = response.content
          .filter((c: any): c is { type: "text"; text: string } => c && c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
        // Treat empty or placeholder output as a failed summarization attempt.
        const trimmed = summary.trim();
        const placeholderish = trimmed.length === 0 || PLACEHOLDER_RE.test(trimmed);
        dlog("session_before_compact: summary attempt", { attempt, len: summary.length, placeholderish, head: trimmed.slice(0, 40) });
        if (!placeholderish) break; // got a real summary
        summary = "";
      } catch (error) {
        lastErr = error;
        dlog("session_before_compact: summary attempt error", { attempt, err: String((error as any)?.message || error) });
        if (signal?.aborted) break;
      }
      if (attempt < SUMMARY_TRIES) {
        // backoff to let 429 rate-limiting clear (1.5s, 3s, 6s, ...)
        await new Promise((r) => setTimeout(r, Math.min(1500 * 2 ** (attempt - 1), 12000)));
      }
    }

    if (summary.trim()) {
      dlog("session_before_compact: summary produced", { len: summary.length, head: summary.slice(0, 50) });
      // STALE-USAGE FIX (luxretail): capture the REAL post-compaction context size now, from
      // reliable signals (summary length + pi's keep-recent budget + the fixed tools/sys
      // floor) — NOT from the stale turn_end getContextUsage() that empty turns can't refresh.
      // After this compaction lands, the next empty must be judged against THIS, so the
      // loop-breaker doesn't mistake a freshly-shrunk small context for "can't shrink".
      const summaryTok = Math.ceil(summary.length / 4);
      const KEEP_RECENT_TOK = (() => {
        const v = parseInt(process.env.COMPACT_ON_46_KEEP_RECENT_TOK || "", 10);
        return Number.isFinite(v) && v >= 0 ? v : 20000; // matches pi settings keepRecentTokens
      })();
      const TOOLS_SYS_FLOOR_TOK = (() => {
        const v = parseInt(process.env.COMPACT_ON_46_TOOLS_SYS_FLOOR_TOK || "", 10);
        return Number.isFinite(v) && v >= 0 ? v : 32000; // coordinator tools(~15.7k)+sys(~15.5k)
      })();
      postCompactRealTokens = summaryTok + KEEP_RECENT_TOK + TOOLS_SYS_FLOOR_TOK;
      suppressLoopBreakerUntilRealTurn = true;
      dlog("session_before_compact: captured real post-compaction floor", {
        tokensBefore, summaryTok, KEEP_RECENT_TOK, TOOLS_SYS_FLOOR_TOK, postCompactRealTokens,
      });
      return {
        compaction: {
          summary,
          firstKeptEntryId,
          tokensBefore,
          details: { summarizer: `${SUMMARIZER_PROVIDER}/${SUMMARIZER_MODEL}` },
        },
      };
    }

    // Sonnet 4.6 summary failed after all retries (almost always transient 429/empty). Do NOT let
    // pi's default Opus 4.8 compaction run — under the same rate-limit it produces a corrupt
    // summary that barely shrinks context and dead-loops the hunt. CANCEL compaction (keep the
    // un-compacted context intact) and RESET the loop-breaker so the watchdog retries the
    // original turn; a later compaction can try again once the rate limit clears.
    if (signal?.aborted) {
      dlog("session_before_compact: aborted; cancel");
    } else {
      dlog("session_before_compact: Sonnet 4.6 summary failed after retries -> CANCEL compaction (avoid poisoned default)", { err: String(lastErr?.message || lastErr || "empty") });
      ctx.ui.notify("compact-on-46: summary unavailable (rate-limited) — skipping compaction, will retry", "warning");
    }
    lastCompactAtTokens = 0;
    consecutiveCompactsNoProgress = 0;
    compacting = false;
    resumeAfterCompact = false;
    // Compaction was cancelled (no summary) -> context did NOT shrink, so there is no
    // stale-usage window to suppress. Clear the flag/floor so the normal loop-breaker
    // stays in effect for the un-compacted (still-large) context.
    suppressLoopBreakerUntilRealTurn = false;
    postCompactRealTokens = 0;
    return { cancel: true };
  });

  // When a compaction lands (any source), clear the in-flight guard. If it was OUR
  // empty-trigger compaction, drive the resume here — this lifecycle event fires after
  // pi has fully finished compacting and saving, so polling for idle is reliable (the
  // onComplete callback raced the state transition and silently dropped the resume,
  // which froze the session at the compaction entry with no follow-up turn).
  pi.on("session_compact", async (_event, ctx) => {
    compacting = false;
    dlog("session_compact fired", { resumeAfterCompact, mode: ctx.mode, fromExtension: (_event as any)?.fromExtension });
    if (!resumeAfterCompact) return; // manual /compact or auto: user/host drives next
    resumeAfterCompact = false;
    if (ctx.mode !== "tui") { dlog("session_compact: skip resume (mode=" + ctx.mode + ")"); return; }
    ctx.ui.notify("✅ Compacted — resuming the hunt on opus-4.8.", "info");
    // Scope-grounded resume (proven in controlled replay to avoid the post-compact
    // empty far better than a vague "continue"): give the model a CONCRETE first
    // action — reload+confirm scope from the platform API — plus the operating frame.
    // The summary (kept as the first message) carries the exact handle/program, so we
    // reference "the program in the summary above" rather than hard-coding it.
    const resumeText =
      "Context was just compacted to recover from an empty completion — your operational " +
      "state is preserved in the summary above. Resume the autonomous hunt now. REQUIRED " +
      "FIRST ACTION: reload and re-confirm scope for the exact program handle named in the " +
      "summary by calling the matching scope-loader subagent (intigriti-scope-loader or " +
      "h1-scope-loader) against the platform API — do not rely on the summary as " +
      "authoritative scope. Then continue the highest-value in-scope lead from the summary. " +
      "Take that scope-reload tool action now; do not reply with prose only.";
    // Use the TOP-LEVEL pi.sendUserMessage — NOT ctx.sendUserMessage (that only exists on
    // command/replaced-session contexts; on an event ctx it is undefined, which is the
    // exact bug that froze the session post-compaction: 'ctx.sendUserMessage is not a
    // function'). pi.sendUserMessage always triggers a turn, so no idle-poll is needed.
    //
    // UI GLITCH FIX (root cause confirmed in pi source): session_compact (this handler) is
    // emitted SYNCHRONOUSLY right BEFORE the UI 'compaction_end' event
    // (agent-session.js: await emit(session_compact) ... then _emit(compaction_end)). The
    // UI's compaction_end handler runs `statusContainer.clear()` (interactive-mode.js),
    // which WIPES the working-loader row. If we send the resume inline here, the resume's
    // agent_start creates the working loader, then compaction_end immediately clears it ->
    // the 'Working' indicator vanishes even though the turn is streaming. FIX: DEFER the
    // resume send to a later tick so compaction_end's statusContainer.clear() runs FIRST;
    // then the resume turn's agent_start creates the loader and it is NOT wiped.
    const sendResume = async () => {
      // REGRESSION FIX (the 'Agent is already processing. Specify streamingBehavior' error):
      // because the resume send is DEFERRED ~150ms (for the UI-glitch fix), pi may have
      // ALREADY started a turn in that window — pi auto-resumes after compaction, or the
      // watchdog nudged. Calling pi.sendUserMessage WITHOUT deliverAs while the agent is
      // streaming THROWS, and pi's runtime logs it as `Extension "<runtime>" error:` BEFORE
      // our catch. So PROBE state first and pick the correct path — never call the bare form
      // while busy:
      //   - idle + nothing queued        -> plain send (clean new turn)
      //   - already processing / pending -> the hunt is ALREADY moving; do NOT double-send.
      //     Only queue a followUp if nothing is pending, so the resume isn't lost; otherwise
      //     skip (the in-flight turn IS the resume).
      let idle = true, pending = false;
      try { idle = ctx.isIdle(); } catch { idle = true; }
      try { pending = ctx.hasPendingMessages(); } catch { pending = false; }
      restoreWorkingOnResume = true;
      try {
        if (idle && !pending) {
          await pi.sendUserMessage(resumeText);
          dlog("session_compact: pi.sendUserMessage OK (deferred, idle)");
        } else if (!pending) {
          // agent is processing but nothing queued -> queue the resume to run next
          await pi.sendUserMessage(resumeText, { deliverAs: "followUp" } as any);
          dlog("session_compact: pi.sendUserMessage followUp (was processing)");
        } else {
          // already a pending/queued message -> the hunt is moving; don't double-send
          restoreWorkingOnResume = false;
          dlog("session_compact: skip resume (already pending/processing)");
        }
        try { ctx.ui.setWorkingVisible(true); } catch { /* keep the loader visible */ }
      } catch (e: any) {
        // Last-resort: if the chosen path still raced and threw, fall back to followUp once.
        dlog("session_compact: resume send error, retry as followUp", { err: String(e?.message || e) });
        try {
          await pi.sendUserMessage(resumeText, { deliverAs: "followUp" } as any);
          try { ctx.ui.setWorkingVisible(true); } catch { /* keep the loader visible */ }
          dlog("session_compact: pi.sendUserMessage followUp OK (fallback)");
        } catch (e2: any) {
          restoreWorkingOnResume = false;
          dlog("session_compact: resume followUp FAILED", { err: String(e2?.message || e2) });
        }
      }
    };
    // 150ms defers past the synchronous compaction_end (statusContainer.clear) and lets the
    // TUI settle; the agent is idle here so the send triggers a clean new turn.
    setTimeout(() => { void sendResume(); }, 150);
  });

  // UI GLITCH FIX (part 2, belt-and-suspenders): when the resume turn begins, re-assert the
  // working loader visible on the FIRST agent_start after a resume. With the deferred send
  // above this is normally redundant (compaction_end already cleared first), but it also
  // covers any residual race. setWorkingVisible(true) only (re)creates the loader when a
  // stream is active, so it is safe/idempotent and never sticks the spinner on.
  pi.on("agent_start", async (_event, ctx) => {
    if (!restoreWorkingOnResume) return;
    restoreWorkingOnResume = false;
    if (ctx.mode !== "tui") return;
    try {
      ctx.ui.setWorkingVisible(true);
      ctx.ui.setWorkingMessage(); // restore default "Working" message
      dlog("agent_start: restored working indicator after compaction resume");
    } catch {
      /* not in tui / no-op */
    }
  });
}
