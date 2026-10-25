#!/usr/bin/env python3
"""
prompt-smoke.py — per-provider behavior smoke test for mechanical agents.

For each (agent, provider): load the DEPLOYED agent file exactly as the pi
subagent loader sees it (frontmatter-stripped body = system prompt), send one
canned input, validate the output against the fixture's expected groups.

  usage: . ~/.pi/secrets/direct_llm.env && python3 bin/prompt-smoke.py [--agents a,b] [--only provider-substr] [--json out.json]

Exit 0 = every agent passes on >=1 preferred provider AND on its current
default provider (google-direct/gemini-3.1-flash-lite).
"""
import json, os, re, sys, time, urllib.request, urllib.error

H = os.path.expanduser("~/.pi/agent/agents")
FIX = os.path.join(os.path.dirname(__file__), "..", "pi-agent", "prompts", "mechanical", "_smoke.json")
KEYS = {k: os.environ.get(k, "") for k in ("GOOGLE_AI_KEY", "MISTRAL_API_KEY", "FREELLM_POOL_KEY", "GROQ_API_KEY")}

def load_body(agent):
    raw = open(os.path.join(H, agent + ".md")).read()
    m = re.match(r"^---\n.*?\n---\n?", raw, re.S)
    return raw[m.end():] if m else raw

def call(model_ref, system, user, timeout=90):
    prov, model = model_ref.split("/", 1)
    base = {
        "google-direct": ("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", KEYS["GOOGLE_AI_KEY"]),
        "mistral-direct": ("https://api.mistral.ai/v1/chat/completions", KEYS["MISTRAL_API_KEY"]),
        "freellm": ("http://127.0.0.1:3001/v1/chat/completions", KEYS["FREELLM_POOL_KEY"]),
    }[prov]
    body = json.dumps({
        "model": model, "max_tokens": 2048,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
    }).encode()
    req = urllib.request.Request(base[0], data=body, headers={
        "Authorization": f"Bearer {base[1]}", "Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.loads(r.read())
        c = d["choices"][0]["message"].get("content") or ""
        return c, int((time.time() - t0) * 1000), None
    except urllib.error.HTTPError as e:
        return "", int((time.time() - t0) * 1000), f"HTTP{e.code}"
    except Exception as e:
        return "", int((time.time() - t0) * 1000), type(e).__name__

def validate(out, expects):
    fails = [g for g in expects if not re.search(g, out, re.I)]
    ok = bool(out.strip()) and not fails
    return ok, fails

def main():
    fix = json.load(open(FIX))
    only = None; agents = list(fix)
    args = sys.argv[1:]
    for i, a in enumerate(args):
        if a == "--agents": agents = args[i+1].split(",")
        if a == "--only": only = args[i+1]
    DEFAULT = "google-direct/gemini-3.1-flash-lite"
    results, table = {}, []
    for ag in agents:
        f = fix[ag]; body = load_body(ag)
        provs = f["providers"] if not only else [p for p in f["providers"] if only in p]
        for p in provs:
            out, ms, err = call(p, body, f["input"])
            ok, fails = validate(out, f["expect"]) if not err else (False, ["PROVIDER-ERR"])
            results[f"{ag}|{p}"] = {"ok": ok, "ms": ms, "err": err, "missing": fails, "chars": len(out)}
            flag = "PASS" if ok else ("PROV-ERR" if err else "FAIL")
            miss = ",".join(x[:22] for x in fails[:3]) if fails else ""
            table.append(f"{ag:24} {p:38} {flag:8} {ms:6}ms  {len(out):5}ch  {miss}")
    print(f"{'agent':24} {'provider':38} {'status':8} {'latency':>7}   out   missing-groups")
    print("\n".join(table))
    # gate: default provider pass per agent
    hard = [a for a in agents if not results.get(f"{a}|{DEFAULT}", {}).get("ok")]
    any_pass = [a for a in agents if any(v["ok"] for k, v in results.items() if k.startswith(a + "|"))]
    print()
    for a in agents:
        d = results.get(f"{a}|{DEFAULT}", {})
        print(f"  {a:24} default-pass={d.get('ok')} any-provider-pass={a in any_pass}")
    if "--json" in args:
        open(args[args.index("--json") + 1], "w").write(json.dumps(results, indent=1))
    sys.exit(0 if not hard and len(any_pass) == len(agents) else 1)

main()
