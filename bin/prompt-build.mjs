#!/usr/bin/env node
/**
 * prompt-build.mjs — assemble self-contained pi-hunt agent files from
 * prompts/base/ (shared skeleton) + class deltas + per-agent deltas.
 *
 * The pi subagent loader consumes ONE self-contained markdown per agent
 * (frontmatter block + body). This generator preserves that architecture:
 * source of truth lives in pi-agent/prompts/, output = one file per agent,
 * byte-identical rebuilds.
 *
 *   node bin/prompt-build.mjs                build + deploy (backup .bak-<ts>) + sync repo mirror
 *   node bin/prompt-build.mjs --dry          build to stdout, write nothing
 *   node bin/prompt-build.mjs --check        FAIL if deployed files drift from a fresh build
 *   node bin/prompt-build.mjs --manifest     write token manifest (uses tsize.mjs)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SRC = path.join(REPO, "pi-agent", "prompts");
const DEPLOY = path.join(process.env.HOME, ".pi", "agent", "agents");
const MIRROR = path.join(REPO, "pi-agent", "agents");

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const CHECK = args.includes("--check");
const ts = () => new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "-");

/** Parse prompts/<class>/<agent>.md: frontmatter + delta body. */
function readSource(file) {
  const raw = fs.readFileSync(file, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) throw new Error(`missing frontmatter: ${file}`);
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^"(.*)"$/, "$1");
  }
  if (!fm.name || !fm.description || !fm.model || !fm.class)
    throw new Error(`frontmatter needs name/description/model/class: ${file}`);
  return { fm, body: raw.slice(m[0].length).trim() };
}

/** Ordered base section list for a class, from the source frontmatter `base:` key. */
function baseSections(fm) {
  if (!fm.base) return [];
  return fm.base.split(",").map((s) => s.trim()).filter(Boolean)
    .map((s) => {
      const p = path.join(SRC, "base", `${s}.md`);
      if (!fs.existsSync(p)) throw new Error(`base section not found: ${p}`);
      return fs.readFileSync(p, "utf8").trim();
    });
}

function assemble(src) {
  const { fm } = src;
  let body = src.body;
  // {{ROLE}} expansion: base/roles/<agent>.md (shared flagship framing) when present
  const rolePath = path.join(SRC, "roles", `${src.fm.name}.md`);
  if (fs.existsSync(rolePath)) body = body.replace(/\{\{ROLE\}\}/, fs.readFileSync(rolePath, "utf8").trim());
  const frontmatter = [
    "---",
    `name: ${fm.name}`,
    `description: ${JSON.stringify(fm.description)}`,
    `model: ${fm.model}`,
    ...(fm.tools ? [`tools: ${fm.tools}`] : []),
    ...(fm.skills ? [`skills: ${fm.skills}`] : []),
    "---",
  ].join("\n");
  const parts = [frontmatter];
  for (const s of baseSections(fm)) parts.push(s);
  if (body) parts.push(body);
  // class tail: shared footer sections (stop-conditions is base; mechanical gets mechanical tail)
  const tailPath = path.join(SRC, fm.class, "_tail.md");
  if (fs.existsSync(tailPath)) parts.push(fs.readFileSync(tailPath, "utf8").trim());
  return parts.join("\n\n") + "\n";
}

function discover() {
  const out = [];
  for (const cls of ["mechanical", "flagship", "elite"]) {
    const dir = path.join(SRC, cls);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md") && !x.startsWith("_")))
      out.push({ cls, file: path.join(dir, f) });
  }
  return out.sort((a, b) => a.cls.localeCompare(b.cls) || a.file.localeCompare(b.file));
}

function tokenCount(text) {
  try {
    return parseInt(execFileSync("node", [path.join(REPO, "bin", "tsize.mjs"), "--stdin-body"], { input: text }).toString().trim(), 10) || 0;
  } catch { return -1; }
}

const sources = discover();
if (!sources.length) { console.error("no sources found under", SRC); process.exit(1); }

let drift = 0, totalTok = 0;
const rows = [];
for (const s of sources) {
  const src = readSource(s.file);
  const built = assemble(src);
  const target = path.join(DEPLOY, `${src.fm.name}.md`);
  const mirror = path.join(MIRROR, `${src.fm.name}.md`);
  const tok = tokenCount(built);
  totalTok += Math.max(tok, 0);
  const cur = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  const mir = fs.existsSync(mirror) ? fs.readFileSync(mirror, "utf8") : null;
  const same = cur === built && (mir === null || mir === built);
  rows.push({ name: src.fm.name, cls: s.cls, tokens: tok, drift: !same && cur !== null });

  if (CHECK) {
    if (!same && cur !== null) { drift++; console.error(`DRIFT: ${src.fm.name}.md`); }
    else if (mir !== null && mir !== built) { drift++; console.error(`DRIFT (repo mirror): ${src.fm.name}.md`); }
    continue;
  }
  if (DRY) {
    console.log(`=== ${src.fm.name}.md (${s.cls}, ~${tok} tok) ===\n${built}`);
    continue;
  }
  if (cur !== null && !same) {
    fs.copyFileSync(target, `${target}.bak-${ts()}`);
    if (fs.existsSync(mirror)) fs.copyFileSync(mirror, `${mirror}.bak-${ts()}`);
  }
  fs.writeFileSync(target, built);
  fs.writeFileSync(mirror, built);
}

const W = (n, w) => String(n).padEnd(w);
if (!DRY && !CHECK) {
  console.log(W("agent", 26) + W("class", 11) + "tokens");
  for (const r of rows) console.log(W(r.name, 26) + W(r.cls, 11) + r.tokens);
  console.log(`TOTAL ~${totalTok} tokens across ${rows.length} agents`);
}
if (CHECK) {
  if (drift) { console.error(`FAIL: ${drift} deployed file(s) drift from build`); process.exit(1); }
  console.log(`OK: ${rows.length} deployed agents match a fresh build`);
}
