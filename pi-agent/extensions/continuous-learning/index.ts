/**
 * continuous-learning — turn hunt sessions into confidence-scored "instincts"
 * and promote the strong ones into the RAG so future hunts recall them.
 * ---------------------------------------------------------------------------
 * Adapted from ECC's continuous-learning-v2 (instinct model + confidence
 * scoring + evolution/promotion), but pi-native and lean:
 *   - No homunculus dir and no background-LLM observer. Instincts live in a
 *     single JSONL under the existing RAG_HOME, and promotion reuses the same
 *     pihunt-rag store the model already searches (CLI `record` -> model-notes).
 *   - Complements `session-memory` (which already persists/restores per-session
 *     context). This extension learns *reusable behaviors*, not session state.
 *
 * An instinct is one atomic learned behavior:
 *   trigger ("when ...") + action ("do ...") + domain + confidence + evidence.
 *
 * SIGNALS (deterministic, cheap, fail-safe):
 *  (1) Tagged lines the model/agents emit in their turn text:
 *        INSTINCT: <action>            -> reinforce a positive instinct
 *        LESSON:   <action>            -> alias of INSTINCT
 *        HEURISTIC:<action>            -> alias of INSTINCT
 *        DEADEND:  <thing that failed> -> record an "avoid" instinct
 *        FALSE-POSITIVE: <pattern>     -> alias of DEADEND
 *      Optional inline tags: "#domain" (e.g. #ssrf) and "when <context>".
 *  (2) Repeated identical security-tool commands (frequency -> confidence) for a
 *      small allowlist of discovery/exploit tools — captures workflows you keep
 *      reusing without any narration.
 *
 * CONFIDENCE: starts 0.40; +0.10 per fresh reinforcement (cap 0.95);
 *  a contradiction (DEADEND of the same normalized action) -0.20 (floor 0.10).
 *  At >= threshold (default 0.70) an un-promoted instinct is written to the RAG
 *  model-notes exactly once and marked promoted.
 *
 * SCOPE: project-scoped by cwd basename (like session-memory), so a program's
 *  instincts don't bleed across unrelated targets; DEADEND/security/global ones
 *  can be recorded global with `--global`.
 *
 * COMMANDS:  /instinct "<action>" [--domain d] [--when ctx] [--global]
 *            /instinct-status [--all]
 *            /instinct-promote [<id>|all]
 *
 * Toggle:    PIHUNT_LEARNING=0 to disable.
 * Tunables:  PIHUNT_LEARNING_THRESHOLD (default 0.70)
 *            PIHUNT_LEARNING_STORE      (default $RAG_HOME/data/instincts.jsonl)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";

const enabled = () => process.env.PIHUNT_LEARNING !== "0";
const RAG_HOME = process.env.PIHUNT_RAG_HOME || path.join(os.homedir(), ".pi-hunt-rag");
const RAG_PY = path.join(RAG_HOME, ".venv", "bin", "python");
const RAG_REPO =
  process.env.PIHUNT_RAG_REPO ||
  firstDir([
    path.join(os.homedir(), "Documents/ai/pi-Hunt/pi-hunt-restore/rag"),
    path.join(os.homedir(), "pi-hunt/rag"),
    path.join(os.homedir(), "tools/pi-hunt/rag"),
  ]);
const STORE =
  process.env.PIHUNT_LEARNING_STORE || path.join(RAG_HOME, "data", "instincts.jsonl");
const THRESHOLD = clamp(parseFloat(process.env.PIHUNT_LEARNING_THRESHOLD || "0.7") || 0.7, 0.3, 0.95);

// Security tools whose repeated identical use is a meaningful workflow signal.
const TOOL_DOMAIN: Record<string, string> = {
  ffuf: "recon", feroxbuster: "recon", gobuster: "recon", dirsearch: "recon",
  katana: "recon", gau: "recon", waybackurls: "recon", subfinder: "recon",
  httpx: "recon", dnsx: "recon", naabu: "recon", nuclei: "scan",
  sqlmap: "sqli", dalfox: "xss", nmap: "recon", "git-dumper": "recon",
};

function firstDir(cands: string[]): string {
  for (const c of cands) { try { if (fs.existsSync(path.join(c, "pihunt_rag"))) return c; } catch {} }
  return cands[0];
}
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }
function ragAvailable(): boolean {
  try { return fs.existsSync(RAG_PY) && fs.existsSync(path.join(RAG_REPO, "pihunt_rag")); } catch { return false; }
}
function runRag(args: string[]): { ok: boolean; out: string } {
  try {
    const r = spawnSync(RAG_PY, ["-m", "pihunt_rag.cli", ...args], {
      env: { ...process.env, PIHUNT_RAG_HOME: RAG_HOME, PYTHONPATH: RAG_REPO,
             HF_HOME: path.join(RAG_HOME, "data", "hf") },
      encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60000,
    });
    return { ok: r.status === 0, out: (r.stdout || "").trim() };
  } catch { return { ok: false, out: "" }; }
}

function projectKey(cwd: string): string {
  const base = path.basename(cwd || process.cwd() || "default").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return base || "default";
}

type Instinct = {
  id: string;
  scope: "project" | "global";
  project: string | null;
  kind: "do" | "avoid";
  trigger: string;
  action: string;
  domain: string;
  confidence: number;
  count: number;
  evidence: string[];
  promoted: boolean;
  created: string;
  updated: string;
};

function norm(s: string): string {
  return (s || "").toLowerCase().replace(/\s+/g, " ").replace(/[`'".]+/g, "").trim();
}
function instinctId(scope: string, project: string | null, kind: string, action: string): string {
  return crypto.createHash("sha1").update(`${scope}|${project || ""}|${kind}|${norm(action)}`).digest("hex").slice(0, 16);
}

function loadStore(): Instinct[] {
  try {
    if (!fs.existsSync(STORE)) return [];
    return fs.readFileSync(STORE, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as Instinct; } catch { return null; } })
      .filter((x): x is Instinct => !!x && !!x.id);
  } catch { return []; }
}
function saveStore(items: Instinct[]) {
  try {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(STORE, items.map((i) => JSON.stringify(i)).join("\n") + "\n");
  } catch {}
}

/** Promote an instinct into the RAG model-notes exactly once. */
function promote(it: Instinct): boolean {
  if (it.promoted || !ragAvailable()) return false;
  const verb = it.kind === "avoid" ? "Avoid" : "Instinct";
  const title = `## ${verb} [${it.domain}]: ${it.action.slice(0, 90)}`;
  const body =
    `${it.kind === "avoid" ? "AVOID/DEAD-END" : "Learned behavior"} ` +
    `(confidence ${it.confidence.toFixed(2)}, seen ${it.count}x, scope ${it.scope}` +
    `${it.project ? `/${it.project}` : ""}).\n` +
    `Trigger: ${it.trigger || "(general)"}\n` +
    `Action: ${it.action}\n` +
    (it.evidence.length ? `Evidence: ${it.evidence.slice(0, 4).join(" | ")}\n` : "");
  const r = runRag(["record", title, body]);
  return r.ok;
}

/**
 * Reinforce (or create) an instinct. Returns the updated record.
 * A contradiction (kind "avoid" of an existing "do", or vice-versa) nudges
 * confidence down on the opposite-kind twin if present.
 */
function reinforce(opts: {
  action: string; trigger?: string; domain?: string; kind?: "do" | "avoid";
  scope?: "project" | "global"; project: string | null; evidence?: string; bump?: number;
}): Instinct | null {
  const action = (opts.action || "").trim();
  if (action.length < 4) return null;
  const kind = opts.kind || "do";
  const scope = opts.scope || (kind === "avoid" ? "global" : "project");
  const proj = scope === "global" ? null : opts.project;
  const id = instinctId(scope, proj, kind, action);
  const items = loadStore();
  const now = new Date().toISOString();

  // contradiction: dampen the opposite-kind twin
  const twinKind = kind === "do" ? "avoid" : "do";
  const twinId = instinctId(scope, proj, twinKind, action);
  const twin = items.find((x) => x.id === twinId);
  if (twin) { twin.confidence = clamp(twin.confidence - 0.2, 0.1, 0.95); twin.updated = now; }

  let it = items.find((x) => x.id === id);
  if (!it) {
    it = {
      id, scope, project: proj, kind,
      trigger: (opts.trigger || "").trim(),
      action, domain: (opts.domain || "general").toLowerCase(),
      confidence: clamp(0.4 + (opts.bump || 0), 0.1, 0.95),
      count: 1, evidence: opts.evidence ? [opts.evidence.slice(0, 200)] : [],
      promoted: false, created: now, updated: now,
    };
    items.push(it);
  } else {
    it.confidence = clamp(it.confidence + (opts.bump ?? 0.1), 0.1, 0.95);
    it.count += 1;
    it.updated = now;
    if (opts.trigger && !it.trigger) it.trigger = opts.trigger.trim();
    if (opts.domain && it.domain === "general") it.domain = opts.domain.toLowerCase();
    if (opts.evidence && it.evidence.length < 6) it.evidence.push(opts.evidence.slice(0, 200));
  }

  if (!it.promoted && it.confidence >= THRESHOLD) {
    if (promote(it)) it.promoted = true;
  }
  saveStore(items);
  return it;
}

// Parse "#domain" and "when <ctx>" hints out of a tagged line's payload.
function parseHints(text: string): { action: string; domain?: string; trigger?: string } {
  let action = text.trim();
  let domain: string | undefined;
  let trigger: string | undefined;
  const dm = action.match(/#([a-z0-9_-]{2,20})\b/i);
  if (dm) { domain = dm[1].toLowerCase(); action = action.replace(dm[0], "").trim(); }
  const wm = action.match(/\bwhen\b\s+(.+?)(?:[,;]|->|$)/i);
  if (wm) { trigger = wm[1].trim(); action = action.replace(wm[0], "").trim(); }
  return { action: action.replace(/\s{2,}/g, " ").replace(/[\s,;]+$/, "").trim(), domain, trigger };
}

const POS = /^\s*(?:INSTINCT|LESSON|HEURISTIC)\s*:\s*(.+)$/gim;
const NEG = /^\s*(?:DEADEND|DEAD-END|FALSE[-\s]?POSITIVE|ANTI)\s*:\s*(.+)$/gim;

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
  const proj = projectKey(cwd);

  // ---- signal (1): tagged lines in the model's turn text
  pi.on("turn_end", async (event: any) => {
    try {
      const text = lastText(event?.message);
      if (!text) return;
      let m: RegExpExecArray | null;
      POS.lastIndex = 0;
      while ((m = POS.exec(text))) {
        const h = parseHints(m[1]);
        if (h.action) reinforce({ ...h, kind: "do", scope: "project", project: proj, evidence: `turn @ ${proj}` });
      }
      NEG.lastIndex = 0;
      while ((m = NEG.exec(text))) {
        const h = parseHints(m[1]);
        if (h.action) reinforce({ ...h, kind: "avoid", scope: "global", project: null, evidence: `dead-end @ ${proj}` });
      }
    } catch {}
  });

  // ---- signal (2): repeated identical security-tool commands
  pi.on("tool_call", async (event: any) => {
    try {
      if (!isToolCallEventType("bash", event)) return;
      const cmd = (event as any).input?.command;
      if (!cmd || typeof cmd !== "string") return;
      // first bare token after env assignments / sudo
      const toks = cmd.trim().split(/\s+/).filter((t) => !/^[A-Z0-9_]+=/.test(t) && t !== "sudo");
      const tool = path.basename(toks[0] || "");
      const domain = TOOL_DOMAIN[tool];
      if (!domain) return; // only learn from known security tools
      // normalize away volatile bits (urls/ips/ports) so "same workflow" matches
      const shape = cmd.replace(/https?:\/\/\S+/g, "<url>").replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>")
        .replace(/\s+-o\s+\S+/g, "").replace(/\s{2,}/g, " ").trim().slice(0, 200);
      reinforce({
        action: `reuse workflow: ${shape}`, trigger: `running ${tool}`, domain,
        kind: "do", scope: "project", project: proj, bump: 0.07, evidence: tool,
      });
    } catch {}
  });

  // ---- commands
  const add = (pi as any).addCommand?.bind(pi);
  if (typeof add === "function") {
    add({
      name: "instinct",
      description: 'Record a learned behavior: /instinct "<action>" [--domain d] [--when ctx] [--global]',
      handler: async (args: string, ctx: any) => {
        const global = /--global\b/.test(args);
        const dom = args.match(/--domain\s+(\S+)/)?.[1];
        const when = args.match(/--when\s+([^-].*?)(?:\s--|$)/)?.[1]?.trim();
        const action = (args.match(/"([^"]+)"/)?.[1] || args.replace(/--\w+(\s+\S+)?/g, "").trim());
        const it = reinforce({
          action, domain: dom, trigger: when, kind: "do",
          scope: global ? "global" : "project", project: global ? null : proj, bump: 0.15, evidence: "manual",
        });
        const msg = it
          ? `recorded instinct [${it.domain}] conf ${it.confidence.toFixed(2)} (${it.promoted ? "promoted to RAG" : "not yet promoted"})`
          : "nothing recorded (action too short)";
        ctx?.ui?.info ? ctx.ui.info(msg) : console.log(msg);
      },
    });
    add({
      name: "instinct-status",
      description: "Show learned instincts for this project (+ global). Use --all for every project.",
      handler: async (args: string, ctx: any) => {
        const all = /--all\b/.test(args);
        const items = loadStore()
          .filter((i) => all || i.scope === "global" || i.project === proj)
          .sort((a, b) => b.confidence - a.confidence).slice(0, 40);
        const out = items.length
          ? items.map((i) => `${i.promoted ? "★" : " "} ${i.confidence.toFixed(2)} [${i.scope === "global" ? "global" : i.project}/${i.domain}] ${i.kind === "avoid" ? "AVOID " : ""}${i.action}`).join("\n")
          : "(no instincts yet)";
        ctx?.ui?.info ? ctx.ui.info(out.slice(0, 6000)) : console.log(out);
      },
    });
    add({
      name: "instinct-promote",
      description: "Force-promote instincts into the RAG: /instinct-promote [<id>|all]",
      handler: async (args: string, ctx: any) => {
        const target = args.trim();
        const items = loadStore();
        let n = 0;
        for (const it of items) {
          if (it.promoted) continue;
          if (target && target !== "all" && !it.id.startsWith(target)) continue;
          if (!target && it.confidence < THRESHOLD) continue;
          if (promote(it)) { it.promoted = true; n += 1; }
        }
        saveStore(items);
        const msg = `promoted ${n} instinct(s) to the RAG`;
        ctx?.ui?.info ? ctx.ui.info(msg) : console.log(msg);
      },
    });
  }
}
