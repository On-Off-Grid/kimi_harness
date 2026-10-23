/**
 * cmd-optimizer — augment recon/fuzzing commands with good wordlists & sane flags.
 * ---------------------------------------------------------------------------
 * Hooks `tool_call` for the `bash` tool ONLY. For a small allowlist of discovery
 * tools (ffuf, feroxbuster, gobuster, dirsearch, wfuzz, dnsx), when the command
 * is missing a wordlist it injects a high-quality SecLists list chosen by mode
 * (dir/dns/param/vhost/api), and adds a couple of benign flags when absent.
 *
 * It deliberately does NOTHING to everyday commands (grep, ls, cat, sed, awk,
 * curl, git, find, python, jq, ...): the per-segment logic early-exits unless the
 * segment's first token is a known discovery tool, so latency on normal commands
 * is unaffected. All real logic lives in ./optimize.ts (pure, unit-tested).
 *
 * Toggle off:  PIHUNT_CMDOPT=0
 * Config:      ~/.pi-hunt-rag/data/cmdopt.json  (disabledTools[], extraTools{})
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { loadConfig, optimizeCommand } from "./optimize.ts";

const enabled = () => process.env.PIHUNT_CMDOPT !== "0";

export default function (pi: ExtensionAPI) {
  // Defensive: pi must be the ExtensionAPI with .on(). If a wrong call signature
  // or host change ever passes something else, no-op instead of throwing — a
  // throw here aborts extension loading and breaks subagent spawns.
  if (!pi || typeof (pi as any).on !== "function") return;
  let cfg: ReturnType<typeof loadConfig>;
  try { cfg = loadConfig(); } catch { cfg = { disabledTools: [], extraTools: {} } as any; }
  let lastLoad = Date.now();
  pi.on("tool_call", async (event) => {
    if (!enabled()) return;
    if (!isToolCallEventType("bash", event)) return;
    const cmd = (event as any).input?.command;
    if (!cmd || typeof cmd !== "string") return;
    // cheap hot-reload of config at most every 30s so edits apply without restart
    if (Date.now() - lastLoad > 30000) { try { cfg = loadConfig(); } catch { /* keep old */ } lastLoad = Date.now(); }
    try {
      const next = optimizeCommand(cmd, cfg);
      if (next !== cmd) (event as any).input.command = next; // mutate in place -> used by execution
    } catch {
      /* never break a command because of the optimizer */
    }
  });
}
