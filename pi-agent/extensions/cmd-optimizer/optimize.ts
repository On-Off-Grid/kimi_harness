/**
 * optimize.ts — PURE command-augmentation logic (no pi imports, unit-testable).
 *
 * Exposed: optimizeCommand(cmd, cfg?) -> string. Only ever augments a small
 * allowlist of discovery/fuzzing tools with a SecLists wordlist (when none is
 * given) plus a couple of benign flags. Everyday commands (grep/ls/cat/curl/
 * git/find/...) are never touched: the per-segment logic early-exits unless the
 * segment's first token is a known tool. Idempotent via a trailing marker.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MARKER = "#cmdopt";
const RAG_HOME = process.env.PIHUNT_RAG_HOME || path.join(os.homedir(), ".pi-hunt-rag");
export const CONFIG_PATH = path.join(RAG_HOME, "data", "cmdopt.json");

// First existing path wins. Ordered best -> fallback.
export const WL: Record<string, string[]> = {
  dir: [
    "/usr/share/seclists/Discovery/Web-Content/raft-large-directories.txt",
    "/usr/share/seclists/Discovery/Web-Content/directory-list-2.3-medium.txt",
    "/usr/share/seclists/Discovery/Web-Content/common.txt",
    "/usr/share/wordlists/dirb/common.txt",
  ],
  word: [
    "/usr/share/seclists/Discovery/Web-Content/raft-large-words.txt",
    "/usr/share/seclists/Discovery/Web-Content/raft-medium-words.txt",
    "/usr/share/seclists/Discovery/Web-Content/common.txt",
  ],
  dns: [
    "/usr/share/seclists/Discovery/DNS/subdomains-top1million-110000.txt",
    "/usr/share/seclists/Discovery/DNS/subdomains-top1million-20000.txt",
    "/usr/share/seclists/Discovery/DNS/dns-Jhaddix.txt",
  ],
  param: [
    "/usr/share/seclists/Discovery/Web-Content/burp-parameter-names.txt",
    "/usr/share/seclists/Discovery/Web-Content/raft-large-words.txt",
  ],
  vhost: [
    "/usr/share/seclists/Discovery/DNS/subdomains-top1million-110000.txt",
    "/usr/share/seclists/Discovery/DNS/subdomains-top1million-20000.txt",
  ],
  api: [
    "/usr/share/seclists/Discovery/Web-Content/api/api-endpoints.txt",
    "/usr/share/seclists/Discovery/Web-Content/api/objects.txt",
  ],
  lfi: ["/usr/share/seclists/Fuzzing/LFI/LFI-Jhaddix.txt"],
};

// Allow tests to stub existence. Default = real fs.
let _exists = (p: string): boolean => {
  try { return fs.existsSync(p); } catch { return false; }
};
export function _setExistsForTest(fn: (p: string) => boolean) { _exists = fn; }

function firstExisting(cands: string[]): string | null {
  for (const c of cands) if (_exists(c)) return c;
  return null;
}

type Cat = keyof typeof WL;
type Rule = {
  hasWordlist: RegExp;
  category: Cat;
  inject: (seg: string, wl: string) => string;
  flags?: Array<[RegExp, string]>;
  refine?: (seg: string) => Cat | null;
  onlyWhenRefined?: boolean;
};

export const RULES: Record<string, Rule> = {
  ffuf: {
    hasWordlist: /(^|\s)-w(\s|=)/,
    category: "dir",
    refine: (s) =>
      /-H\s+["']?Host:\s*FUZZ/i.test(s) ? "vhost"
      : /([?&][a-z0-9_]*=FUZZ|[?&]FUZZ=)/i.test(s) ? "param"
      : /\/api\b|\bapi\./i.test(s) ? "api" : "dir",
    inject: (s, wl) => `${s} -w ${wl}:FUZZ`,
    flags: [
      [/(^|\s)-mc(\s|=)/, "-mc all"],
      [/(^|\s)-t(\s|=)/, "-t 40"],
      [/(^|\s)(-ac|-fc(\s|=)|-fs(\s|=)|-fw(\s|=)|-fl(\s|=))/, "-ac"],
    ],
  },
  feroxbuster: {
    hasWordlist: /(^|\s)(-w|--wordlist)(\s|=)/,
    category: "dir",
    inject: (s, wl) => `${s} -w ${wl}`,
    flags: [[/(^|\s)(-t|--threads)(\s|=)/, "-t 40"]],
  },
  gobuster: {
    hasWordlist: /(^|\s)(-w|--wordlist)(\s|=)/,
    category: "dir",
    refine: (s) => (/\bdns\b/.test(s) ? "dns" : /\bvhost\b/.test(s) ? "vhost" : "dir"),
    inject: (s, wl) => `${s} -w ${wl}`,
    flags: [[/(^|\s)(-t|--threads)(\s|=)/, "-t 40"]],
  },
  dirsearch: {
    hasWordlist: /(^|\s)(-w|--wordlists?)(\s|=)/,
    category: "dir",
    inject: (s, wl) => `${s} -w ${wl}`,
  },
  wfuzz: {
    hasWordlist: /(^|\s)(-w|-z\s*file)/,
    category: "dir",
    inject: (s, wl) => `${s} -w ${wl}`,
  },
  dnsx: {
    hasWordlist: /(^|\s)(-w|-wordlist)(\s|=)/,
    category: "dns",
    // dnsx brute-forces only with -d (+domain); in resolve mode (-l/stdin) it must
    // NOT get a wordlist. refine returns null there and onlyWhenRefined skips it.
    refine: (s) => (/(^|\s)(--?brute)\b/.test(s) || /(^|\s)-d(\s|=)/.test(s) ? "dns" : null),
    onlyWhenRefined: true,
    inject: (s, wl) => `${s} -w ${wl}`,
  },
};

export type CmdOptConfig = { disabledTools: string[]; extraTools: Record<string, string> };

export function loadConfig(): CmdOptConfig {
  try {
    if (_exists(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch { /* ignore */ }
  const seed: any = {
    _note: "cmd-optimizer config. disabledTools: never augment these. extraTools: tool->category (dir|word|dns|param|vhost|api|lfi).",
    disabledTools: [], extraTools: {},
  };
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(seed, null, 2));
  } catch { /* ignore */ }
  return seed;
}

function augmentSegment(seg: string, cfg: CmdOptConfig): string {
  const trimmed = seg.trim();
  if (!trimmed) return seg;
  const toks = trimmed.split(/\s+/);
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++; // skip env assignments
  const tool = (toks[i] || "").split("/").pop() || "";
  if (cfg.disabledTools.includes(tool)) return seg;
  const rule = RULES[tool];
  const extraCat = cfg.extraTools[tool] as Cat | undefined;
  if (!rule && !extraCat) return seg; // everyday commands exit HERE, untouched

  let out = seg;
  if (rule) {
    if (!rule.hasWordlist.test(out)) {
      const refined = rule.refine ? rule.refine(out) : undefined;
      const skip = rule.onlyWhenRefined && !refined; // dnsx resolve-mode => skip
      const cat = (refined as Cat) || rule.category;
      if (!skip && cat) {
        const wl = firstExisting(WL[cat]);
        if (wl) out = rule.inject(out, wl);
      }
    }
    for (const [test, add] of rule.flags || []) if (!test.test(out)) out = `${out} ${add}`;
  } else if (extraCat && WL[extraCat]) {
    if (!/(^|\s)-w(\s|=)/.test(out)) {
      const wl = firstExisting(WL[extraCat]);
      if (wl) out = `${out} -w ${wl}`;
    }
  }
  return out;
}

export function optimizeCommand(cmd: string, cfg?: CmdOptConfig): string {
  if (!cmd || cmd.includes(MARKER)) return cmd;
  const c = cfg || loadConfig();
  const names = [...Object.keys(RULES), ...Object.keys(c.extraTools)];
  if (!names.some((n) => new RegExp(`(^|[\\s;&|(])${n}(\\s|$)`).test(cmd))) return cmd;
  const parts = cmd.split(/(\s*(?:&&|\|\||;|\|)\s*)/);
  let changed = false;
  const rebuilt = parts.map((p, idx) => {
    if (idx % 2 === 1) return p;
    const aug = augmentSegment(p, c);
    if (aug !== p) changed = true;
    return aug;
  });
  return changed ? `${rebuilt.join("")}  ${MARKER}` : cmd;
}
