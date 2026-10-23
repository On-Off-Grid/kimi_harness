/**
 * Auto-Continue Watchdog
 * ----------------------
 * pi runs one agentic turn per user message and idles when the model returns a
 * turn with no tool call (text-only, empty, or an errored/degraded completion).
 * During a long autonomous hunt that "stops until you prompt it" — which is the
 * stall we root-caused (an empty completion after a parallel tool batch).
 *
 * This watchdog, when a hunt is active (PI_AUTOCONTINUE=1, set by `pi-hunt`) and
 * only in interactive TUI mode, auto-sends a "continue" message on turn_end so
 * the coordinator keeps going by itself — with hard safeguards so it can never
 * loop forever or fight the user.
 *
 * Activates ONLY when:  PI_AUTOCONTINUE=1  AND  ctx.mode === "tui"
 *   => never runs in plain coding sessions, never in subagents (json/print mode).
 *
 * Stops / does NOT continue when:
 *   - the model explicitly ends with [[HUNT_COMPLETE]] or [[HUNT_BLOCKED: ...]]
 *   - the user aborted the turn (stopReason "aborted")  -> hands control back
 *   - the user has queued/typed a message, or the agent isn't idle
 *   - too many consecutive no-progress (no-tool) turns  (PI_AUTOCONTINUE_MAX_EMPTY, default 3)
 *   - a per-session lifetime cap is hit                 (PI_AUTOCONTINUE_MAX, default 400)
 *   - toggled off with /autocontinue off
 *
 * Tunables (env): PI_AUTOCONTINUE_MAX_EMPTY, PI_AUTOCONTINUE_MAX,
 *                 PI_AUTOCONTINUE_DELAY_MS (default 1500; errored turns wait >=5s).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const enabled = () => process.env.PI_AUTOCONTINUE === "1";
const MAX_EMPTY = Math.max(1, parseInt(process.env.PI_AUTOCONTINUE_MAX_EMPTY || "3", 10) || 3);
const MAX_TOTAL = Math.max(1, parseInt(process.env.PI_AUTOCONTINUE_MAX || "400", 10) || 400);
const DELAY_MS = Math.max(0, parseInt(process.env.PI_AUTOCONTINUE_DELAY_MS || "1500", 10) || 1500);

// Distinctive end-of-hunt markers the coordinator is told to emit (prompt hardening).
const COMPLETE_RE = /\[\[\s*HUNT[ _]?COMPLETE\s*\]\]/i;
const BLOCKED_RE = /\[\[\s*HUNT[ _]?BLOCKED/i;

const CONTINUE_MSG =
  "Auto-continue (watchdog): keep going autonomously — do NOT stop or wait for me. " +
  "Take the next concrete action right now with a tool call; if you have nothing to say, act, don't narrate. " +
  "Only stop by ending your message with exactly [[HUNT_COMPLETE]] when the hunt is genuinely finished/exhausted, " +
  "or [[HUNT_BLOCKED: <one-line reason>]] if you truly need my input.";

function lastText(message: any): string {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b: any) => b && b.type === "text").map((b: any) => b.text || "").join("\n");
  return "";
}

// Gateway/extension give-up placeholders: a turn whose only text is one of these
// produced NO real output (it's the empty-completion stall this watchdog exists for).
const PLACEHOLDER_RE = /^\s*\((?:no output|empty placeholder|continuing)\)\s*$/i;

// Does this assistant turn contain a tool call? (pi resumes tool turns on its own.)
function hasToolCall(message: any): boolean {
  const c = message?.content;
  return Array.isArray(c) && c.some((b: any) => b && (b.type === "toolCall" || b.type === "tool_use"));
}

// Heuristic: is the model addressing / waiting on the USER rather than continuing
// the hunt autonomously? We must NOT auto-nudge those (the "firing for the wrong
// reason" case). Signals, checked on the TAIL of the message (last ~3 non-empty
// lines, where a turn that defers to the user puts its ask):
//   - a question mark anywhere in the tail
//   - decision/permission phrasing ("which", "want me to", "should I", "let me
//     know", "tell me", "your call", "options:", "option 1/2/3", "A or B")
// Deliberately tail-only so a normal hunt turn that merely contains "?" mid-plan
// still gets nudged.
const AWAIT_USER_RE = /\?|\b(which|want me to|should i|shall i|do you want|let me know|tell me|your call|prefer|confirm|approve|option\s*\d|options?:|a or b)\b/i;
// Err toward NOT nudging when the tail contains any question / decision-request:
// a falsely-suppressed nudge is cheap (operator types continue, or it's a one-off),
// but falsely nudging a turn that is presenting options / awaiting the user's
// decision is the exact "fired for the wrong reason" bug. Tail-only (last 3 lines)
// so a question buried mid-plan doesn't mute an otherwise-autonomous hunt turn.
function awaitsUser(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  const lines = t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  const tail = lines.slice(-3).join("\n");
  return AWAIT_USER_RE.test(tail);
}

// Decide whether to auto-continue this turn. (Narrowed per operator request.)
// NUDGE ONLY when:
//   - the turn MADE PROGRESS (produced tool results), or did a web_search, OR
//   - the turn is an EMPTY/PLACEHOLDER stall (no usable output)
// Everything else (a tool-call turn pi resumes itself, OR any substantive final
// text — whether or not it addresses the user) is NOT nudged: a turn that ends
// with real prose and no tool call is treated as the model deliberately yielding.
function shouldNudge(message: any, madeProgress: boolean, didWebSearch: boolean): boolean {
  if (madeProgress || didWebSearch) return true;               // progress -> keep moving
  const t = (lastText(message) || "").trim();
  if (t.length === 0 || PLACEHOLDER_RE.test(t)) return true;   // empty/placeholder stall
  return false;                                                // tool turn or substantive text -> do NOT nudge
}

export default function autoContinueWatchdog(pi: ExtensionAPI) {
  let emptyStreak = 0; // consecutive no-progress (no-tool) turns
  let total = 0; // lifetime auto-continues this session
  let pausedByUser = false; // /autocontinue off
  let pausedBySafety = false; // hit a cap
  let scheduled = false; // a continue is already scheduled for this idle

  pi.registerCommand("autocontinue", {
    description: "Auto-continue watchdog: on | off | status",
    handler: async (args, ctx) => {
      const a = (args || "").trim().toLowerCase();
      if (a === "off") {
        pausedByUser = true;
        ctx.ui.notify("auto-continue: OFF (you paused it)", "info");
      } else if (a === "on") {
        pausedByUser = false;
        pausedBySafety = false;
        emptyStreak = 0;
        ctx.ui.notify("auto-continue: ON", "info");
      } else {
        const on = enabled() && !pausedByUser && !pausedBySafety;
        ctx.ui.notify(
          `auto-continue: ${on ? "ON" : "OFF"} (env=${enabled() ? "1" : "0"}, mode-gated to tui) | emptyStreak=${emptyStreak}/${MAX_EMPTY} total=${total}/${MAX_TOTAL}`,
          "info",
        );
      }
    },
  });

  pi.on("turn_end", async (event, ctx) => {
    try {
      if (!enabled() || pausedByUser || pausedBySafety) return;
      if (ctx.mode !== "tui") return; // never in headless/subagent (json/print) or rpc

      const msg: any = (event as any)?.message;
      const stop = msg?.stopReason;

      // User explicitly interrupted -> hand control back, reset.
      if (stop === "aborted") {
        emptyStreak = 0;
        return;
      }

      // Explicit stop signal from the model -> respect it, do not continue.
      const text = lastText(msg);
      if (COMPLETE_RE.test(text) || BLOCKED_RE.test(text)) {
        ctx.ui.notify("auto-continue: hunt complete/blocked marker seen — standing by.", "info");
        emptyStreak = 0;
        return;
      }

      // Progress = the turn produced tool results. No tools = a stall/idle turn.
      const toolResults = (event as any)?.toolResults;
      const madeProgress = Array.isArray(toolResults) && toolResults.length > 0;
      // A gateway-resolved web_search (Path B) yields NO client toolResults but the
      // model DID advance (it has fresh search results to act on). Count it as
      // progress so a legit run of searches can't trip the no-progress safety cap;
      // we still auto-continue this turn (it ended end_turn with no client tool).
      const didWebSearch = /<web_search>/i.test(text);

      // Coordination with compact-on-46: when an empty/placeholder stall happens AND
      // empty-driven compaction is active, that extension calls ctx.compact() which
      // makes pi non-idle; the watchdog's own nudge below is already guarded by
      // ctx.isIdle()/hasPendingMessages(), so it self-suppresses while compaction runs
      // and its follow-up resume message is pending. If compact-on-46 DECLINES (small
      // context), pi stays idle and the watchdog nudges a normal retry as usual. No
      // explicit deferral needed — the idle/pending guards coordinate the two.

      // "Fire only when needed": do NOT nudge a turn that is genuinely waiting on the
      // user (a trailing question) or a tool turn pi resumes itself. This is the fix
      // for the watchdog firing when not needed. Hand control back without nudging.
      if (!shouldNudge(msg, madeProgress, didWebSearch)) {
        emptyStreak = 0;
        if (awaitsUser(text)) {
          ctx.ui.notify("auto-continue: model is addressing you — standing by.", "info");
        }
        return;
      }

      if (madeProgress || didWebSearch) emptyStreak = 0;
      else emptyStreak += 1;

      // Safety: stop nudging if the agent is stuck producing nothing.
      if (emptyStreak > MAX_EMPTY) {
        pausedBySafety = true;
        ctx.ui.notify(
          `auto-continue: paused after ${emptyStreak} no-progress turns (agent may be stuck or asking). Resume with /autocontinue on.`,
          "warning",
        );
        return;
      }
      if (total >= MAX_TOTAL) {
        pausedBySafety = true;
        ctx.ui.notify(`auto-continue: lifetime cap ${MAX_TOTAL} reached — paused. Resume with /autocontinue on.`, "warning");
        return;
      }

      if (scheduled) return;
      scheduled = true;
      // Errored turns (e.g. 429-exhausted) wait longer to let rate limits cool.
      const delay = stop === "error" ? Math.max(DELAY_MS, 5000) : DELAY_MS;
      setTimeout(async () => {
        scheduled = false;
        try {
          if (!enabled() || pausedByUser || pausedBySafety) return;
          // Only inject if still idle and the user hasn't queued/typed anything.
          if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
          total += 1;
          await pi.sendUserMessage(CONTINUE_MSG);
        } catch {
          /* never crash the session */
        }
      }, delay).unref?.();
    } catch {
      /* never crash the session */
    }
  });
}
