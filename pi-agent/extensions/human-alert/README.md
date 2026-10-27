# human-alert

Rings the operator's desk only for **blocking live-browser actions**.

## What fires

1. A `browser_live_*` tool result containing a high-confidence signal:
   - **CAPTCHA** — requires a vendor/challenge-infrastructure *marker*
     (`recaptcha`, `hcaptcha`, `turnstile`, `cdn-cgi/challenge-platform`,
     `data-sitekey`, …). A bare English phrase such as "verify you are human",
     "just a moment", or "checking your browser" does **not** fire on its own —
     those appear in docs, normal login UI, and auto-resolving Cloudflare
     interstitials, and were the main false-positive source.
   - **OTP / code-entry** and explicit **manual-handoff** phrases fire as before.
   - Captcha walls are **confirmed before alarming**: the alert is held
     `PIHUNT_ALERT_CONFIRM_MS` and only fires if no newer browser result arrives
     (i.e. the agent is still stuck). A transient challenge the browser passes
     produces a follow-up browser result and stays silent.
2. An assistant `NEED_HUMAN: <reason>` marker while a `browser_live_*` tool was
   used in that turn or within the browser-context window. This path stays
   loose: a reason that *names* a browser wall (even a bare keyword) fires, so a
   coordinator can surface a subagent's browser blocker.

Everything else is silent. In particular, `read`/`bash` output mentioning
`2FA`, rate limits, quotas, access denied, payments, or bans does not ring.

For a **hung** hunt (a wedged coordinator or a subagent stuck on "(running)"),
no event is emitted, so this extension cannot see it — use the external
`pi-tier stall-watch` poller instead.

Non-browser operator blockers use the coordinator's `[[HUNT_BLOCKED: ...]]`
marker instead; it stops the hunt without sounding the alarm.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PIHUNT_ALERT` | `1` | `0` disables all alerts |
| `PIHUNT_ALERT_COOLDOWN_MS` | `60000` | Cross-process per-issue cooldown |
| `PIHUNT_ALERT_BROWSER_CONTEXT_MS` | `120000` | How long a browser result makes `NEED_HUMAN` actionable |
| `PIHUNT_ALERT_CONFIRM_MS` | `15000` | Hold a captcha wall this long; fire only if the agent didn't move on |
| `PIHUNT_ALERT_DRY_RUN` | unset | `1` logs instead of spawning notify/audio |
| `PIHUNT_ALERT_STATE_DIR` | `$TMPDIR/pi-human-alert` | Shared lock directory |
| `PIHUNT_ALERT_VOICE` | built-in | Spoken line via `spd-say` |

## Test

```bash
node --experimental-strip-types pi-agent/extensions/human-alert/selftest.mjs
node --experimental-strip-types --check pi-agent/extensions/human-alert/index.ts
```

The live copy lives at `~/.pi/agent/extensions/human-alert/`. Deploy only this
extension directory; do not run `install.sh` just to update it. If you back up
the old extension, move the backup **outside** `~/.pi/agent/extensions/` — pi
loads every subdirectory there, so a `human-alert.bak-*` copy would keep the
old behavior alive.
