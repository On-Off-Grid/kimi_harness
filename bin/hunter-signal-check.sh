#!/usr/bin/env bash
# hunter-signal-check — dry-run 3 representative hunters (sqli, oauth, llm) against
# a known-vulnerable fixture (must reproduce) and a clean control (must return empty).
#   . ~/.pi/secrets/kimi.env && bin/hunter-signal-check.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIX="$HERE/hunter-fixture.json"

python3 - "$FIX" <<'PY'
import json, sys, re, subprocess, os
fix = json.load(open(sys.argv[1]))
os.makedirs("/tmp/hunter-fixture-reports", exist_ok=True)
only_label = os.environ.get("HUNTER_LABEL", "")  # e.g. "clean" or "vuln" or "" = both

def run(agent, user, model):
    with open(os.path.expanduser(f"~/.pi/agent/agents/{agent}.md")) as f:
        agent_body = f.read()
    r = subprocess.run(["pi", "-p", user, "--model", model,
                        "--append-system-prompt", os.path.expanduser(f"~/.pi/agent/agents/{agent}.md"),
                        "--no-context-files"],
                       capture_output=True, text=True, timeout=240, cwd="/tmp")
    return r.stdout

ok = True
for agent, spec in fix.items():
    model = spec["model"]
    for label in ("vuln", "clean"):
        if only_label and only_label != label:
            continue
        fx = spec[f"fixture_{label}"]
        user = (f"BUG-BOUNTY HUNTER TASK ({label.upper()} FIXTURE).\n"
                f"Scope: {fx['scope']}\n\n"
                f"Your observed evidence (treat as ground truth — do NOT fabricate requests):\n{fx['known_truth']}\n\n"
                f"{fx['task']}")
        out = run(agent, user, model)
        low = out.lower()
        has_valid = any(re.search(v, low) for v in fx["expect_valid"])
        has_forbidden = any(re.search(f, low) for f in fx["expect_not"])
        passed = has_valid and not has_forbidden
        print(f"{agent:16} {label:6} valid_signal={has_valid} forbidden_signal={has_forbidden} -> {'PASS' if passed else 'FAIL'}")
        if not passed:
            print("   OUTPUT (first 400):", out[:400].replace("\n", " "))
        ok = ok and passed
print("HUNTER SIGNAL CHECK:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
PY