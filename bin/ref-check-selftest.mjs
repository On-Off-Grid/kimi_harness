#!/usr/bin/env node
/**
 * ref-check-selftest.mjs — negative tests for the reference gate.
 *
 * A gate that only ever passes is decoration. This builds a minimal repo+deploy
 * fixture, proves the gate passes on it, then injects each defect class and proves
 * the gate FAILS with the expected message. Runs in /tmp; never touches the real tree.
 *
 *   node bin/ref-check-selftest.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(HERE, "ref-check.mjs");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "refcheck-"));

const AGENT = `---
name: fixture-hunter
description: "fixture"
model: x
class: mechanical
base: b
skills: [alpha-skill]
---

## Authorized testing & scope compliance (non-negotiable)
In scope only. Never submit.

## Return contract
End with status: validated|candidate|needs-more-evidence|blocked.

## Body
Load \`skills/alpha-skill/SKILL.md\` before testing. Run \`bin/tool.mjs\`. Write to \`reports/<program>/x/\`.
`;

const BASE = `## Base
shared skeleton
`;

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(ROOT, "case-"));
  const repo = path.join(dir, "repo");
  const home = path.join(dir, "home");
  const w = (rel, txt) => { const p = path.join(repo, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };
  const wh = (rel, txt) => { const p = path.join(home, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };

  w("bin/tool.mjs", "// fixture tool\n");
  // The fixture keeps a second destination so the generic per-destination
  // coverage loop stays exercised; the real manifest now has only ~/.pi/agent/skills.
  w("install.sh", `#!/usr/bin/env bash\nrsync -a '$SRC/skills/' '$H/.pi/agent/skills/'\nrsync -a '$SRC/skills/' '$H/.local/share/pihunt/skills/'\n`);
  w("skills/manifest.json", JSON.stringify({
    runtime_dir: "~/.pi/agent/skills",
    deploy: ["~/.pi/agent/skills", "~/.local/share/pihunt/skills"],
    skills: { "alpha-skill": { path: "skills/alpha-skill/SKILL.md", consumers: ["fixture-hunter"] } },
  }, null, 2));
  w("skills/alpha-skill/SKILL.md", "---\nname: alpha-skill\ndescription: \"fixture\"\n---\n\nalpha\n");
  w("pi-agent/prompts/base/b.md", BASE);
  w("pi-agent/prompts/mechanical/fixture-hunter.md", AGENT);
  w("pi-agent/agents/fixture-hunter.md", AGENT.replace(/^base: b\n/m, "").replace("skills: [alpha-skill]\n", "").replace("## Base\nshared skeleton\n", ""));

  wh(".pi/agent/agents/fixture-hunter.md", fs.readFileSync(path.join(repo, "pi-agent/agents/fixture-hunter.md")));
  wh(".pi/agent/skills/alpha-skill/SKILL.md", fs.readFileSync(path.join(repo, "skills/alpha-skill/SKILL.md")));
  return { dir, repo, home };
}

function run(fx, args = []) {
  const r = spawnSync(process.execPath, [CHECK, ...args], {
    env: { ...process.env, REFCHECK_REPO: fx.repo, REFCHECK_HOME: fx.home },
    encoding: "utf8",
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

const cases = [];
const check = (name, mutate, expect, args = []) => {
  const fx = makeFixture();
  mutate(fx);
  const { code, out } = run(fx, args);
  const ok = code !== 0 && expect.test(out);
  cases.push({ name, ok, detail: ok ? "" : `exit=${code} expected /${expect.source}/` });
  if (!ok) console.log(`   --- output ---\n${out.split("\n").filter((l) => l.includes("FAIL")).slice(0, 6).join("\n")}`);
  fs.rmSync(fx.dir, { recursive: true, force: true });
};

// 0. clean fixture must pass in full and repo-only modes
for (const args of [[], ["--repo"]]) {
  const fx = makeFixture();
  const { code, out } = run(fx, args);
  const label = args.length ? "clean fixture passes --repo" : "clean fixture passes";
  cases.push({ name: label, ok: code === 0, detail: code === 0 ? "" : out.slice(-400) });
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

// 0b. repo-only mode accepts a tool that the installer will provide.
{
  const fx = makeFixture();
  fs.mkdirSync(path.join(fx.repo, "recon"), { recursive: true });
  fs.writeFileSync(path.join(fx.repo, "recon/fixture.sh"), "#!/bin/sh\n");
  fs.appendFileSync(path.join(fx.repo, "install.sh"),
    "cp -p '$SRC/recon/fixture.sh' '$H/.local/bin/pihunt-fixture'\n");
  fs.appendFileSync(path.join(fx.repo, "pi-agent/agents/fixture-hunter.md"), "\nRun `pihunt-fixture`.\n");
  const { code, out } = run(fx, ["--repo"]);
  cases.push({
    name: "repo-only accepts installer-mapped tool",
    ok: code === 0,
    detail: code === 0 ? "" : out.slice(-400),
  });
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

check("dangling skills/<name> reference", (fx) => {
  const p = path.join(fx.repo, "pi-agent/agents/fixture-hunter.md");
  fs.appendFileSync(p, "\nLoad `skills/does-not-exist/SKILL.md`.\n");
}, /does-not-exist.*not found in repo/i);

check("repo skill with no installer path", (fx) => {
  fs.writeFileSync(path.join(fx.repo, "install.sh"), "#!/usr/bin/env bash\n# nothing\n");
}, /no rsync of \$SRC\/skills\/.*dead on arrival/i);

check("deployed skill with no repo source", (fx) => {
  const p = path.join(fx.home, ".pi/agent/skills/ghost-skill/SKILL.md");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "---\nname: ghost-skill\n---\nghost\n");
}, /ghost-skill.*no repo source/i);

check("half-populated deploy destination", (fx) => {
  fs.mkdirSync(path.join(fx.home, ".local/share/pihunt/skills"), { recursive: true });
}, /repo skill "alpha-skill" is missing from ~\/\.local\/share\/pihunt\/skills/i);

check("legacy .kiro deploy destination", (fx) => {
  const p = path.join(fx.repo, "skills/manifest.json");
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  m.deploy.push("~/.kiro/skills");
  fs.writeFileSync(p, JSON.stringify(m, null, 2));
}, /legacy ~\/\.kiro deploy destination/i);

check("stale deployed skill bytes", (fx) => {
  fs.appendFileSync(path.join(fx.home, ".pi/agent/skills/alpha-skill/SKILL.md"), "\nstale edit\n");
}, /alpha-skill.*differs from repo source/i);

check("broken repo path reference", (fx) => {
  const p = path.join(fx.repo, "pi-agent/agents/fixture-hunter.md");
  fs.appendFileSync(p, "\nSee `bin/missing-tool.mjs`.\n");
}, /bin\/missing-tool\.mjs.*does not resolve/i);

check("uninstalled tool reference", (fx) => {
  const p = path.join(fx.repo, "pi-agent/agents/fixture-hunter.md");
  fs.appendFileSync(p, "\nRun `pihunt-definitely-not-installed`.\n");
}, /pihunt-definitely-not-installed.*not installed/i);

check("repo-only rejects unmapped tool", (fx) => {
  const p = path.join(fx.repo, "pi-agent/agents/fixture-hunter.md");
  fs.appendFileSync(p, "\nRun `pihunt-definitely-not-installed`.\n");
}, /pihunt-definitely-not-installed.*no repo source or installer mapping/i, ["--repo"]);

check("mechanical delta over budget", (fx) => {
  fs.appendFileSync(path.join(fx.repo, "pi-agent/prompts/mechanical/fixture-hunter.md"),
    "\n" + "filler sentence about nothing in particular. ".repeat(120) + "\n");
}, /fixture-hunter delta is \d+ tok, budget is < 400/i);

check("output-schema status token missing", (fx) => {
  const p = path.join(fx.repo, "pi-agent/agents/fixture-hunter.md");
  const t = fs.readFileSync(p, "utf8").replace("needs-more-evidence|", "");
  fs.writeFileSync(p, t);
}, /status enum token "needs-more-evidence" missing/i);

check("undeclared repo skill", (fx) => {
  const p = path.join(fx.repo, "skills/beta-skill/SKILL.md");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "---\nname: beta-skill\n---\nbeta\n");
}, /repo skill "beta-skill" is not declared/i);

console.log("== reference-gate self-test (negative cases)");
let failed = 0;
for (const c of cases) {
  console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "  — " + c.detail : ""}`);
  if (!c.ok) failed++;
}
console.log(failed ? `\nREF-CHECK SELF-TEST: FAIL (${failed}/${cases.length})` : `\nREF-CHECK SELF-TEST: PASS (${cases.length}/${cases.length})`);
process.exit(failed ? 1 : 0);
