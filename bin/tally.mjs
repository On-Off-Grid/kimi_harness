#!/usr/bin/env node
/**
 * tally.mjs — per-agent before/after token report for the prompt refactor.
 *
 * `before` comes from pi-agent/prompts/baseline/tokens.json, which was recorded
 * from the deploy-time `.bak-<ts>` copies of each agent (the true pre-refactor
 * files) by bin/prompt-build.mjs. `after` is measured live from the deployed
 * agents, so the table stays honest as sources change.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AG = path.join(process.env.HOME, ".pi", "agent", "agents");
const base = JSON.parse(fs.readFileSync(path.join(REPO, "pi-agent/prompts/baseline/tokens.json"), "utf8"));
const tok = (f) => parseInt(execFileSync("node", [path.join(REPO, "bin/tsize.mjs"), f], { encoding: "utf8" }).trim(), 10);

const P = (n, w) => String(n).padEnd(w);
const R = (n, w) => String(n).padStart(w);
const pct = (a, b) => (b ? Math.round((a - b) * 100 / b) : 0) + "%";

const rows = Object.entries(base).map(([name, v]) => ({ name, cls: v.class, before: v.before, after: tok(path.join(AG, name + ".md")) }));
rows.sort((a, b) => a.cls.localeCompare(b.cls) || a.name.localeCompare(b.name));

let BT = 0, AT = 0;
const cls = {};
console.log(P("agent", 30) + P("class", 11) + R("before", 8) + R("after", 7) + R("delta", 7) + R("d%", 7));
for (const r of rows) {
  BT += r.before; AT += r.after;
  cls[r.cls] ??= { b: 0, a: 0 };
  cls[r.cls].b += r.before; cls[r.cls].a += r.after;
  console.log(P(r.name, 30) + P(r.cls, 11) + R(r.before, 8) + R(r.after, 7) + R(r.after - r.before, 7) + R(pct(r.after, r.before), 7));
}
console.log("-".repeat(70));
for (const [c, v] of Object.entries(cls))
  console.log(P("  " + c + " subtotal", 30) + P("", 11) + R(v.b, 8) + R(v.a, 7) + R(v.a - v.b, 7) + R(pct(v.a, v.b), 7));
console.log(P("FLEET TOTAL", 30) + P("", 11) + R(BT, 8) + R(AT, 7) + R(AT - BT, 7) + R(pct(AT, BT), 7));
console.log("\n" + rows.length + " agents");
