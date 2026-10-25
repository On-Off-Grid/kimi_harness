#!/usr/bin/env node
/**
 * skill-manifest.mjs — regenerate skills/manifest.json from the repo tree.
 *
 * The manifest is the deploy contract the reference gate checks against:
 *   - every skill dir with a SKILL.md must be listed
 *   - every listed skill must exist and be deployed by install.sh
 *   - consumers[] must mention the skill
 *
 * Run after adding/removing a skill:  node bin/skill-manifest.mjs
 * (the gate fails on a stale manifest, so this is not optional).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = path.join(REPO, "skills");
const AGENTS = path.join(REPO, "pi-agent", "agents");
const MANIFEST = path.join(SKILLS, "manifest.json");

const names = fs.readdirSync(SKILLS)
  .filter((d) => fs.existsSync(path.join(SKILLS, d, "SKILL.md")))
  .sort();
const agents = fs.readdirSync(AGENTS).filter((f) => f.endsWith(".md"));

const skills = {};
for (const s of names) {
  const re = new RegExp(`(^|[^a-z0-9-])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9-]|$)`, "i");
  skills[s] = {
    path: `skills/${s}/SKILL.md`,
    consumers: agents.filter((a) => re.test(fs.readFileSync(path.join(AGENTS, a), "utf8"))).map((a) => a.slice(0, -3)),
  };
}

const manifest = {
  runtime_dir: "~/.pi/agent/skills",
  deploy: ["~/.pi/agent/skills", "~/.kiro/skills"],
  skills,
};

fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${path.relative(REPO, MANIFEST)} — ${names.length} skills, ${names.filter((n) => skills[n].consumers.length).length} with consumers`);
