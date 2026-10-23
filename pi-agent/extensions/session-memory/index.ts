/**
 * session-memory — persist session context into the RAG and restore it on a new session.
 * ---------------------------------------------------------------------------
 * Problem: when you open a NEW pi session you lose the thread of what you were
 * doing. pi compacts within a session, but across sessions the context is gone.
 *
 * This extension makes session context durable and queryable:
 *
 *  (A) CAPTURE (session_before_compact): every time pi compacts (auto or
 *      /compact), we let pi build its normal structured summary, then ALSO
 *      persist that summary into the RAG (source="session", kind="session-summary")
 *      keyed by cwd + session id. We never cancel/replace compaction — we observe it.
 *
 *  (B) CAPTURE (session_shutdown / session_before_switch): on exit/switch we
 *      snapshot a lightweight "where we left off" marker (last summary pointer +
 *      timestamp + cwd) so even un-compacted short sessions leave a breadcrumb.
 *
 *  (C) RESTORE (session_start, reason=new|startup): we look up the most recent
 *      session summaries for THIS cwd in the RAG and inject them as a system note
 *      so the model resumes with "here's what we did last time / how to continue".
 *      Also registers a /resume-context command to pull it on demand.
 *
 * Storage goes through the RAG CLI (pihunt-rag) so it's the same vector store the
 * model already searches. Everything is best-effort and never blocks the session.
 *
 * Toggle: PIHUNT_SESSION_MEMORY=0 to disable. Tunables:
 *   PIHUNT_SESSION_RESTORE_K (default 3) — how many prior summaries to inject.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const enabled = () => process.env.PIHUNT_SESSION_MEMORY !== "0";
const RAG_HOME = process.env.PIHUNT_RAG_HOME || path.join(os.homedir(), ".pi-hunt-rag");
const RAG_PY = path.join(RAG_HOME, ".venv", "bin", "python");
const RAG_REPO =
  process.env.PIHUNT_RAG_REPO ||
  firstDir([
    path.join(os.homedir(), "Documents/ai/pi-Hunt/pi-hunt-restore/rag"),
    path.join(os.homedir(), "pi-hunt/rag"),
    path.join(os.homedir(), "tools/pi-hunt/rag"),
  ]);
const RESTORE_K = Math.max(1, parseInt(process.env.PIHUNT_SESSION_RESTORE_K || "3", 10) || 3);

function firstDir(cands: string[]): string {
  for (const c of cands) { try { if (fs.existsSync(path.join(c, "pihunt_rag"))) return c; } catch {} }
  return cands[0];
}

function ragAvailable(): boolean {
  try { return fs.existsSync(RAG_PY) && fs.existsSync(path.join(RAG_REPO, "pihunt_rag")); } catch { return false; }
}

function runRag(args: string[], input?: string): { ok: boolean; out: string } {
  try {
    const r = spawnSync(RAG_PY, ["-m", "pihunt_rag.cli", ...args], {
      env: { ...process.env, PIHUNT_RAG_HOME: RAG_HOME, PYTHONPATH: RAG_REPO,
             HF_HOME: path.join(RAG_HOME, "data", "hf") },
      input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60000,
    });
    return { ok: r.status === 0, out: (r.stdout || "").trim() };
  } catch { return { ok: false, out: "" }; }
}

function projectKey(cwd: string): string {
  // stable, human-readable program key from cwd (so per-project recall works)
  const base = path.basename(cwd || process.cwd() || "session").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return `session-${base || "default"}`;
}

/** Persist a summary into the RAG (source="session") so it is searchable next session. */
function persistSummary(cwd: string, summary: string, sid: string) {
  if (!summary || !ragAvailable()) return;
  const key = projectKey(cwd);
  const ts = new Date().toISOString();
  const title = `Session ${ts} (${sid.slice(0, 8)}) — ${path.basename(cwd)}`;
  runRag(["session-add", "--key", key, "--title", title,
          "--body", summary.slice(0, 6000), "--cwd", cwd, "--keep", "12"]);
}

function lastText(message: any): string {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b: any) => b?.type === "text").map((b: any) => b.text || "").join("\n");
  return "";
}

export default function (pi: ExtensionAPI) {
  if (!pi || typeof (pi as any).on !== "function") return;
  if (!enabled()) return;

  const cwd = process.cwd();
  let lastSummary = "";

  // ---- (A) capture every compaction summary into the RAG (observe, don't replace)
  pi.on("session_before_compact", async (event: any) => {
    try {
      // We do NOT return a custom summary — let pi compact normally. We capture
      // after the fact via the summary pi exposes on the event/preparation.
      const prep = event?.preparation;
      const prev = prep?.previousSummary;
      if (prev && typeof prev === "string") { lastSummary = prev; }
      // schedule a capture shortly after compaction writes its entry
      setTimeout(() => {
        try {
          const sid = (event?.sessionId || event?.preparation?.sessionId || "session").toString();
          // Prefer the freshest summary we can see; fall back to previousSummary.
          const summary = lastSummary || prev || "";
          if (summary) persistSummary(cwd, summary, sid);
        } catch {}
      }, 500);
    } catch {}
    return undefined; // never cancel/replace
  });

  // Capture the model's own end-of-turn text as a rolling "latest state" hint,
  // so even without compaction we have something to persist on shutdown.
  pi.on("turn_end", async (event: any) => {
    try {
      const t = lastText(event?.message);
      if (t && t.length > 80) lastSummary = t.slice(0, 6000);
    } catch {}
  });

  // ---- (B) breadcrumb on shutdown/switch
  const snapshot = (sidRaw: any) => {
    try {
      const sid = (sidRaw || "session").toString();
      if (lastSummary) persistSummary(cwd, lastSummary, sid);
    } catch {}
  };
  pi.on("session_shutdown", async (event: any) => { snapshot(event?.sessionId); });
  pi.on("session_before_switch", async (event: any) => { snapshot(event?.sessionId); return undefined; });

  // ---- (C) restore prior context on a new/startup session
  pi.on("session_start", async (event: any, ctx: any) => {
    try {
      const reason = event?.reason;
      if (reason !== "new" && reason !== "startup") return; // resume/fork already keep context
      if (!ragAvailable()) return;
      const key = projectKey(cwd);
      // semantic pull of this project's prior session summaries
      const res = runRag(["search", `prior session context and next steps for ${cwd}`,
        "--source", "session", "-k", String(RESTORE_K), "--json"]);
      if (!res.ok || !res.out) return;
      let hits: any[] = [];
      try { hits = JSON.parse(res.out); } catch { return; }
      // keep only this project's summaries
      const mine = hits.filter((h) => (h?.ref || "").toLowerCase().startsWith(key) || (h?.program || "") === key || (h?.text || "").includes(cwd));
      const chosen = (mine.length ? mine : hits).slice(0, RESTORE_K);
      if (!chosen.length) return;
      const blocks = chosen.map((h, i) =>
        `### Prior session ${i + 1} (${h.title || h.ref || ""})\n${(h.text || "").slice(0, 1500)}`).join("\n\n");
      const note =
        `🔁 Restored context from ${chosen.length} prior session(s) in this directory ` +
        `(via pihunt-rag session memory). Use this to continue where you left off; ` +
        `run \`/resume-context\` for more, or \`pihunt-rag search "..." --source session\`.\n\n${blocks}`;
      // inject as a system/context message if the API allows; else print.
      if (ctx?.addContext) await ctx.addContext(note);
      else if (ctx?.ui?.info) ctx.ui.info(note.slice(0, 4000));
      else if (event?.injectMessage) event.injectMessage(note);
    } catch {}
  });

  // ---- on-demand recall command
  if (typeof (pi as any).addCommand === "function") {
    (pi as any).addCommand({
      name: "resume-context",
      description: "Pull prior session summaries for this directory from the RAG",
      handler: async (_args: string, ctx: any) => {
        const res = runRag(["search", `prior session context for ${cwd}`, "--source", "session", "-k", "6"]);
        const text = res.ok && res.out ? res.out : "(no prior session context found)";
        if (ctx?.ui?.info) ctx.ui.info(text.slice(0, 6000)); else console.log(text);
      },
    });
  }
}
