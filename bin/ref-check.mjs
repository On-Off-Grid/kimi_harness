#!/usr/bin/env node
/**
 * ref-check.mjs — reference-resolution + budget + schema gate for the agent fleet.
 *
 * The signature gate validated prompt CONTENT; this validates REFERENCES. It exists
 * because `deep-research` pointed at `skills/deep-research-memory/SKILL.md` which was
 * never deployed: the prompt was fine, the reference dangled, and nothing noticed.
 *
 * Fails when:
 *   1. an emitted agent references skills/<name> that is not in the repo skill tree
 *      or in skills/manifest.json;
 *   2. a skill exists in the repo but no installer path deploys it (dead on arrival);
 *   3. a deployed skill in ~/.pi/agent/skills has no repo source (reverse drift),
 *      or its bytes differ from the repo source;
 *   4. any repo path referenced by an emitted agent (bin/, rag/, pi-agent/, steering/,
 *      prompts/, docs/, extensions/) does not resolve, or a `pihunt-*` tool is not
 *      installed;
 *   5. a skill→skill reference dangles;
 *   6. a mechanical agent exceeds its token budget (recon < 2,000, all others < 400);
 *   7. an agent lost the return-contract status enum (static output-schema check);
 *   8. the manifest declares a retired ~/.kiro deploy destination, or install.sh
 *      rsyncs skills to a destination that is not declared in deploy[].
 *
 * Runs against BOTH the repo mirror (pi-agent/agents) and the deployed tree
 * (~/.pi/agent/agents) when the latter exists — defect 1 only manifested at deploy time.
 *
 *   node bin/ref-check.mjs            # full gate (deploy tree if present)
 *   node bin/ref-check.mjs --repo     # repo-only (CI: no deploy tree/installed tools)
 *   node bin/ref-check.mjs --verbose  # list every resolved reference
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO = process.env.REFCHECK_REPO
  ? path.resolve(process.env.REFCHECK_REPO)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.REFCHECK_HOME || process.env.HOME;
const REPO_AGENTS = path.join(REPO, "pi-agent", "agents");
const DEPLOY_AGENTS = path.join(HOME, ".pi", "agent", "agents");
const REPO_SKILLS = path.join(REPO, "skills");
const DEPLOY_SKILLS = path.join(HOME, ".pi", "agent", "skills");
const MANIFEST = path.join(REPO_SKILLS, "manifest.json");
const INSTALL = path.join(REPO, "install.sh");
const RAG_INSTALL = path.join(REPO, "rag", "install-rag.sh");
const VERBOSE = process.argv.includes("--verbose");
const REPO_ONLY = process.argv.includes("--repo");

const fails = [];
const warns = [];
const fail = (scope, msg) => fails.push(`${scope}: ${msg}`);
const warn = (scope, msg) => warns.push(`${scope}: ${msg}`);

/* ---------------------------------------------------------------- tokens */
const require = createRequire(import.meta.url);
let enc = null;
try { enc = require("js-tiktoken").getEncoding("cl100k_base"); } catch { enc = null; }
const tokens = (text) => {
  const fm = text.match(/^---\n[\s\S]*?\n---\n?/);
  const body = fm ? text.slice(fm[0].length) : text;
  return enc ? enc.encode(body).length : Math.ceil(body.length / 4);
};

/* --------------------------------------------------------------- helpers */
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const read = (p) => fs.readFileSync(p, "utf8");
const strip = (s) => s.replace(/^---\n[\s\S]*?\n---\n?/, "");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const inPath = (tool) => (process.env.PATH || "").split(":").some((d) => d && exists(path.join(d, tool)));
const trimToken = (t) => t.replace(/[.,;:)\]}'"`]+$/, "");

const listAgents = (dir) => (exists(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : []);

/* -------------------------------------------------------------- manifest */
if (!exists(MANIFEST)) {
  console.error(`FAIL manifest: ${path.relative(REPO, MANIFEST)} missing`);
  process.exit(1);
}
const manifest = JSON.parse(read(MANIFEST));
const manifestSkills = manifest.skills || {};
const deployDests = manifest.deploy || [];
const runtimeDest = manifest.runtime_dir;

if (!runtimeDest) fail("manifest", "runtime_dir is not set");
else if (!deployDests.includes(runtimeDest)) fail("manifest", `runtime_dir ${runtimeDest} is not in deploy[]`);
for (const dest of deployDests) {
  if (dest.includes("/.kiro/")) fail("manifest", `legacy ~/.kiro deploy destination "${dest}" is retired`);
}

const repoSkillDirs = exists(REPO_SKILLS)
  ? fs.readdirSync(REPO_SKILLS).filter((d) => exists(path.join(REPO_SKILLS, d, "SKILL.md"))).sort()
  : [];

for (const [name, meta] of Object.entries(manifestSkills)) {
  const rel = meta.path || `skills/${name}/SKILL.md`;
  if (!exists(path.join(REPO, rel))) fail("manifest", `skill "${name}" declares ${rel} but the file is missing`);
  if (!exists(path.join(REPO_SKILLS, name, "SKILL.md"))) fail("manifest", `skill "${name}" has no skills/${name}/SKILL.md`);
}
for (const d of repoSkillDirs) if (!manifestSkills[d]) fail("manifest", `repo skill "${d}" is not declared in skills/manifest.json`);

// consumers[] is a contract too: a declared consumer must exist and must mention the skill.
for (const [name, meta] of Object.entries(manifestSkills)) {
  for (const a of meta.consumers || []) {
    const f = path.join(REPO_AGENTS, a + ".md");
    if (!exists(f)) fail("manifest", `skill "${name}" lists consumer "${a}" but that agent file is missing`);
    else if (!new RegExp(`(?<![a-z0-9-])${escapeRe(name)}(?![a-z0-9-])`, "i").test(read(f)))
      fail("manifest", `skill "${name}" lists consumer "${a}" which never references it`);
  }
}

/* --------------------------------------------- installer covers every dest */
const installTxt = exists(INSTALL) ? read(INSTALL) : "";
const ragInstallTxt = exists(RAG_INSTALL) ? read(RAG_INSTALL) : "";

// Repo-only mode must not require tools to be installed on the CI runner. It
// instead proves each referenced pihunt-* tool has a repo source and an
// installer mapping, so a fresh `install.sh` will actually provide it.
const installerToolSources = new Map();
for (const m of installTxt.matchAll(
  /cp\s+-p\s+['"]\$SRC\/([^'"]+)['"]\s+['"]\$H\/\.local\/bin\/(pihunt-[a-z0-9-]+)['"]/g,
)) {
  installerToolSources.set(m[2], m[1]);
}
for (const m of installTxt.matchAll(/\b([a-z0-9-]+):(pihunt-[a-z0-9-]+)\b/g)) {
  if (!installerToolSources.has(m[2])) installerToolSources.set(m[2], `recon/${m[1]}.sh`);
}
if (/\.local\/bin\/pihunt-rag/.test(ragInstallTxt)) {
  installerToolSources.set("pihunt-rag", "rag/install-rag.sh");
}
function repoSourceForTool(tool) {
  for (const rel of [`bin/${tool}`, `rag/${tool}`]) {
    if (exists(path.join(REPO, rel))) return rel;
  }
  const src = installerToolSources.get(tool);
  if (src && exists(path.join(REPO, src))) return src;
  return null;
}

for (const dest of deployDests) {
  const rel = dest.replace(/^~\//, "");
  const re = new RegExp(`rsync\\s+-a\\s+['"]\\$SRC/skills/['"]\\s+['"]\\$H/${escapeRe(rel)}/['"]`);
  if (!re.test(installTxt)) fail("installer", `no rsync of $SRC/skills/ -> $H/${rel}/ in install.sh (skill would be dead on arrival)`);
}
const skillRsyncs = [...installTxt.matchAll(/rsync\s+-a\s+['"]\$SRC\/skills\/['"]\s+['"]\$H\/([^'"]+)\/['"]/g)].map((m) => m[1]);
for (const rel of skillRsyncs) {
  if (!deployDests.includes("~/" + rel)) fail("installer", `install.sh deploys skills to ~/${rel} but it is not in manifest deploy[] (dead deploy surface)`);
}

/* ------------------------------------------------ skill → skill references */
for (const d of repoSkillDirs) {
  const file = path.join(REPO_SKILLS, d, "SKILL.md");
  for (const m of strip(read(file)).matchAll(/skills\/([a-z0-9][a-z0-9-]*)(?:\/SKILL\.md)?/g)) {
    const ref = m[1];
    if (!exists(path.join(REPO_SKILLS, ref, "SKILL.md"))) fail(`skill ${d}`, `references skills/${ref} which does not exist`);
    else if (!manifestSkills[ref]) fail(`skill ${d}`, `references undeclared skill "${ref}"`);
  }
}

/* ---------------------------------------------------------- agent scan */
const deployedSkillsPresent = !REPO_ONLY && exists(DEPLOY_SKILLS);
const repoSkillNames = repoSkillDirs;
const nameRe = new Map(repoSkillNames.map((n) => [n, new RegExp(`(?<![a-z0-9-])${escapeRe(n)}(?![a-z0-9-])`, "i")]));
const REPO_PREFIXES = ["bin", "rag", "pi-agent", "steering", "prompts", "docs", "extensions"];
const pathRe = new RegExp(`(?<![A-Za-z0-9_./~-])(${REPO_PREFIXES.join("|")})/[A-Za-z0-9_.@/-]+`, "g");

const rows = [];
let refCount = 0;

function scanTree(label, dir) {
  const agents = listAgents(dir);
  if (!agents.length) return;
  console.log(`\n== ${label}: ${agents.length} agents (${dir.replace(HOME, "~")})`);
  for (const f of agents) {
    const name = f.slice(0, -3);
    const raw = read(path.join(dir, f));
    const body = strip(raw);
    const seen = new Set();
    const add = (kind, ref, repo, man, dep) => {
      const key = `${kind}|${ref}`;
      if (seen.has(key)) return;
      seen.add(key);
      refCount++;
      rows.push({ agent: name, kind, ref, repo, manifest: man, deployed: dep });
      if (repo === "MISSING") fail(`${label}/${name}`, `${kind} ${ref}: not found in repo`);
      if (man === "MISSING") fail(`${label}/${name}`, `${kind} ${ref}: not declared in skills/manifest.json`);
      if (dep === "MISSING") fail(`${label}/${name}`, `${kind} ${ref}: not deployed to ~/.pi/agent/skills`);
    };

    // 1. explicit skills/<name> references
    for (const m of body.matchAll(/skills\/([a-z0-9][a-z0-9-]*)(?:\/SKILL\.md)?/g)) {
      const ref = m[1];
      add("skill-path", `skills/${ref}/SKILL.md`,
        exists(path.join(REPO_SKILLS, ref, "SKILL.md")) ? "OK" : "MISSING",
        manifestSkills[ref] ? "OK" : "MISSING",
        !deployedSkillsPresent ? "SKIP" : exists(path.join(DEPLOY_SKILLS, ref, "SKILL.md")) ? "OK" : "MISSING");
    }

    // 2. frontmatter skills: [a, b] (loader ignores it, but it is a reference)
    const fm = raw.match(/^---\n([\s\S]*?)\n---/);
    if (fm) {
      const line = fm[1].match(/^skills:\s*\[(.*?)\]\s*$/m);
      if (line) {
        for (const ref of line[1].split(",").map((s) => s.trim()).filter(Boolean)) {
          add("skill-frontmatter", ref,
            exists(path.join(REPO_SKILLS, ref, "SKILL.md")) ? "OK" : "MISSING",
            manifestSkills[ref] ? "OK" : "MISSING",
            !deployedSkillsPresent ? "SKIP" : exists(path.join(DEPLOY_SKILLS, ref, "SKILL.md")) ? "OK" : "MISSING");
        }
      }
    }

    // 3. bare skill-name mentions (e.g. recon names its skills in prose)
    for (const ref of repoSkillNames) {
      if (!nameRe.get(ref).test(body)) continue;
      add("skill-name", ref, "OK", manifestSkills[ref] ? "OK" : "MISSING",
        !deployedSkillsPresent ? "SKIP" : exists(path.join(DEPLOY_SKILLS, ref, "SKILL.md")) ? "OK" : "MISSING");
    }

    // 4. pihunt-* tool references
    for (const m of body.matchAll(/\bpihunt-[a-z0-9-]+\b/g)) {
      const tool = m[0];
      if (REPO_ONLY) {
        const src = repoSourceForTool(tool);
        if (!src) fail(`${label}/${name}`, `tool ${tool}: no repo source or installer mapping (would be dead on arrival)`);
        else {
          refCount++;
          rows.push({ agent: name, kind: "tool", ref: tool, repo: `OK (${src})`, manifest: "-", deployed: "installer" });
        }
        continue;
      }
      const ok = exists(path.join(REPO, "bin", tool)) || exists(path.join(REPO, "rag", tool)) ||
        exists(path.join(HOME, ".local/bin", tool)) || exists(path.join(HOME, ".pi/agent/bin", tool)) || inPath(tool);
      if (!ok) fail(`${label}/${name}`, `tool ${tool}: not installed (repo bin/rag, ~/.local/bin, PATH)`);
      else { refCount++; rows.push({ agent: name, kind: "tool", ref: tool, repo: "OK", manifest: "-", deployed: "-" }); }
    }

    // 5. repo path references
    for (const m of body.matchAll(pathRe)) {
      const ref = trimToken(m[0]);
      if (/[<{*$]/.test(ref)) continue; // template/placeholder, not a literal path
      const ok = exists(path.join(REPO, ref));
      if (!ok) fail(`${label}/${name}`, `path ${ref}: does not resolve in repo`);
      else { refCount++; rows.push({ agent: name, kind: "path", ref, repo: "OK", manifest: "-", deployed: "-" }); }
    }

    // 6. static output-schema check: the return contract's status enum must survive
    for (const s of ["validated", "candidate", "needs-more-evidence", "blocked"]) {
      if (!body.toLowerCase().includes(s)) fail(`${label}/${name}`, `output schema: status enum token "${s}" missing`);
    }
  }
}

scanTree("repo", REPO_AGENTS);
if (!REPO_ONLY && exists(DEPLOY_AGENTS)) scanTree("deployed", DEPLOY_AGENTS);
else console.log(`\n== deployed: SKIPPED (${REPO_ONLY ? "--repo" : "no ~/.pi/agent/agents — CI/repo-only mode"})`);

/* ------------------------------------------------------- deploy parity */
if (deployedSkillsPresent) {
  const deployedDirs = fs.readdirSync(DEPLOY_SKILLS).filter((d) => exists(path.join(DEPLOY_SKILLS, d, "SKILL.md"))).sort();
  for (const d of deployedDirs) {
    if (!exists(path.join(REPO_SKILLS, d, "SKILL.md"))) fail("reverse-drift", `deployed skill "${d}" has no repo source`);
    else if (read(path.join(DEPLOY_SKILLS, d, "SKILL.md")) !== read(path.join(REPO_SKILLS, d, "SKILL.md")))
      fail("reverse-drift", `deployed skill "${d}" differs from repo source (stale deploy)`);
  }
  for (const d of repoSkillDirs) {
    if (!deployedDirs.includes(d)) fail("deploy-coverage", `repo skill "${d}" is not deployed to ~/.pi/agent/skills`);
  }
}

// Every deploy destination that exists on this machine must carry every repo skill,
// byte-identical. A destination that is only half-populated is dead on arrival too.
if (!REPO_ONLY) {
  for (const dest of deployDests) {
    const abs = path.join(HOME, dest.replace(/^~\//, ""));
    if (!exists(abs)) continue;
    const present = new Set(fs.readdirSync(abs).filter((d) => exists(path.join(abs, d, "SKILL.md"))));
    for (const d of repoSkillDirs) {
      if (!present.has(d)) fail("deploy-coverage", `repo skill "${d}" is missing from ${dest}`);
      else if (read(path.join(abs, d, "SKILL.md")) !== read(path.join(REPO_SKILLS, d, "SKILL.md")))
        fail("deploy-coverage", `skill "${d}" in ${dest} differs from repo source`);
    }
  }
}

/* -------------------------------------------------------------- budgets */
// Budget unit = the agent's authored delta (the part this refactor controls).
// The shared mechanical base (~220 tok: safety + return contract) is fixed and is
// reported separately; <400 applies to the delta, recon is exempt at <2,000.
console.log("\n== token budgets (per-agent delta; assembled shown for context)");
for (const f of fs.readdirSync(path.join(REPO, "pi-agent", "prompts", "mechanical")).filter((x) => x.endsWith(".md") && !x.startsWith("_"))) {
  const name = f.slice(0, -3);
  const delta = tokens(read(path.join(REPO, "pi-agent", "prompts", "mechanical", f)));
  const assembled = exists(path.join(REPO_AGENTS, f)) ? tokens(read(path.join(REPO_AGENTS, f))) : 0;
  const limit = name === "recon" ? 2000 : 400;
  const ok = delta < limit;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(26)} delta ${String(delta).padStart(4)} tok (< ${String(limit).padStart(4)})   assembled ${String(assembled).padStart(4)}`);
  if (!ok) fail("budget", `${name} delta is ${delta} tok, budget is < ${limit}`);
}

/* --------------------------------------------------------------- report */
// manifest drift the other way: a reference exists but consumers[] does not list it.
{
  const byRef = new Map();
  for (const r of rows) {
    if (!r.kind.startsWith("skill")) continue;
    const skill = r.kind === "skill-path"
      ? r.ref.replace(/^skills\//, "").replace(/\/SKILL\.md$/, "")
      : r.ref;
    if (!byRef.has(skill)) byRef.set(skill, new Set());
    byRef.get(skill).add(r.agent);
  }
  for (const [skill, agents] of byRef) {
    for (const a of agents) {
      if (!(manifestSkills[skill]?.consumers || []).includes(a))
        warn("manifest", `skill "${skill}" is referenced by "${a}" but consumers[] does not list it`);
    }
  }
}

if (VERBOSE) {
  console.log("\n== resolution table");
  console.log("  " + "agent".padEnd(26) + "kind".padEnd(18) + "reference".padEnd(42) + "repo   manifest  deployed");
  for (const r of rows.sort((a, b) => a.agent.localeCompare(b.agent) || a.ref.localeCompare(b.ref)))
    console.log("  " + r.agent.padEnd(26) + r.kind.padEnd(18) + r.ref.padEnd(42) + r.repo.padEnd(7) + r.manifest.padEnd(10) + r.deployed);
}

console.log("\n== summary");
console.log(`  skills: ${repoSkillDirs.length} in repo, ${Object.keys(manifestSkills).length} in manifest, ${deployedSkillsPresent ? fs.readdirSync(DEPLOY_SKILLS).filter((d) => exists(path.join(DEPLOY_SKILLS, d, "SKILL.md"))).length + " deployed" : "deploy tree absent"}`);
console.log(`  references resolved: ${refCount}`);
for (const w of warns) console.log(`  WARN  ${w}`);
for (const f of fails) console.log(`  FAIL  ${f}`);
if (fails.length) {
  console.log(`\nREF CHECK: FAIL (${fails.length})`);
  process.exit(1);
}
console.log("\nREF CHECK: PASS (references, installer coverage, reverse drift, budgets, schema)");
