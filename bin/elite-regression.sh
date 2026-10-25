#!/usr/bin/env bash
# elite-regression — strict-triager regression gate.
# Feeds the triager a labeled set: 1 duplicate, 1 known-vuln, 1 novel.
# Asserts reject-with-reason on the first two and accept on the novel.
#   . ~/.pi/secrets/kimi.env && bin/elite-regression.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIX="$HERE/elite-regression.json"
TRIAGER="$HOME/.pi/agent/agents/strict-triager.md"

python3 - "$FIX" "$TRIAGER" <<'PY'
import json, sys, re, subprocess, os
fix = json.load(open(sys.argv[1]))
triage = sys.argv[2]
model = "kimi-coding/k3.1-pro"

def run(user):
    # authoritative path: full agent file appended as system prompt, same model as prod.
    # Run from a NEUTRAL cwd (/tmp) so the harness coordinator prompt is NOT auto-loaded.
    neutral = os.path.expanduser("/tmp")
    r = subprocess.run(["pi", "-p", user, "--model", model,
                        "--append-system-prompt", triage, "--no-context-files"],
                       capture_output=True, text=True, timeout=240, cwd=neutral)
    return r.stdout

ok = True
for t in fix["tests"]:
    user = (f"TRIAGE GATE (apply your system rules).\n"
            f"Known system state: {t['known_context']}\n"
            f"CANDIDATE FINDING:\n{t['input']}\n\n"
            f"Output your verdict as exactly two lines:\nVERDICT: VALID|NEEDS WORK|REJECT\nREASON: <one line>")
    out = run(user).lower()
    exp = t["expect_verdict"]
    if exp == "reject":
        verdict_ok = "reject" in out
    else:
        verdict_ok = "valid" in out or "needs work" in out  # accept OR accept-with-gaps both count as not-reject
    reason_ok = True
    if t["expect_reason"]:
        reason_ok = bool(re.search(t["expect_reason"], out))
    passed = verdict_ok and reason_ok
    print(f"{t['id']:10} {exp:7} verdict_ok={str(verdict_ok):5} reason_ok={str(reason_ok):5} -> {'PASS' if passed else 'FAIL'}")
    if not passed:
        print("   OUTPUT:", out[:600].replace("\n", " "))
    ok = ok and passed
print("ELITE REGRESSION:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
PY