/**
 * Cross-process alert cooldown.
 *
 * Each subagent is a separate pi process, so an in-memory Map cannot stop
 * eight browser workers from ringing the desk for the same CAPTCHA. A tiny
 * lock file per alert key gives us a shared cooldown without a daemon.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function alertKey(reason: string): string {
  return createHash("sha1").update(reason).digest("hex").slice(0, 16);
}

function prune(dir: string, now: number, cooldownMs: number): void {
  const maxAge = Math.max(cooldownMs * 4, 60_000);
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".lock")) continue;
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > maxAge) fs.unlinkSync(file);
      } catch {
        /* another process may have removed it */
      }
    }
  } catch {
    /* pruning is best-effort */
  }
}

/**
 * Returns true when this process won the alert. The lock file is created
 * atomically with O_EXCL; an existing fresh lock suppresses the alert.
 */
export function claimAlert(
  key: string,
  cooldownMs: number,
  stateDir = process.env.PIHUNT_ALERT_STATE_DIR || path.join(os.tmpdir(), "pi-human-alert"),
): boolean {
  const now = Date.now();
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  } catch {
    return true; // fail open: a missing state dir must not hide a real alert
  }

  const file = path.join(stateDir, `${alertKey(key)}.lock`);
  const create = (): boolean => {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      try {
        fs.writeFileSync(fd, String(now));
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (e: any) {
      if (e?.code === "EEXIST") return false;
      return true; // fail open on unexpected filesystem errors
    }
  };

  if (create()) {
    prune(stateDir, now, cooldownMs);
    return true;
  }

  // Existing lock: suppress while fresh, otherwise remove and retry once.
  try {
    const st = fs.statSync(file);
    if (now - st.mtimeMs < cooldownMs) return false;
    fs.unlinkSync(file);
  } catch {
    /* raced with another process */
  }

  if (create()) {
    prune(stateDir, now, cooldownMs);
    return true;
  }
  return false;
}
