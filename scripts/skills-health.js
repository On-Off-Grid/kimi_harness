#!/usr/bin/env node
'use strict';

/*
 * pi-hunt skills-health
 * ---------------------
 * Zero-dependency validator for pi-hunt SKILL.md files.
 * Adapted from the Everything Claude Code (ECC) `skills-health.js` concept,
 * but rewritten standalone — ECC's version depends on a lib/skill-evolution/*
 * tree we don't carry here.
 *
 * Checks, per skill directory under <skills-root>:
 *   - a SKILL.md file exists
 *   - it opens with a YAML frontmatter block (--- ... ---)
 *   - frontmatter has non-empty `name` and `description`
 *   - `name` matches the directory name (kebab-case)
 *   - `description` is within a sane length (>= 40, <= 600 chars)
 *   - description mentions an auto-load trigger (pi-hunt convention)
 *   - there is real body content after the frontmatter
 *
 * Usage:
 *   node scripts/skills-health.js [--skills-root <path>] [--json] [--strict]
 *
 * Exit codes: 0 = all OK (warnings allowed), 1 = at least one ERROR
 *             (or any warning when --strict). 2 = bad invocation.
 */

const fs = require('fs');
const path = require('path');

const DESC_MIN = 40;
const DESC_MAX = 600;

function parseArgs(argv) {
  const opts = { json: false, strict: false, skillsRoot: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--skills-root') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error('Missing value for --skills-root');
      opts.skillsRoot = v;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

function showHelp() {
  process.stdout.write(`Usage: node scripts/skills-health.js [options]

Options:
  --skills-root <path>  Skills directory to scan (default: <repo>/skills)
  --json                Emit machine-readable JSON
  --strict              Treat warnings as failures (exit 1)
  --help                Show this help
`);
}

// Minimal, dependency-free frontmatter reader. Handles the simple
// `key: value` pairs pi-hunt skills use (optionally quoted values).
function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { found: false };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { found: false };
  const block = text.slice(3, end).replace(/^\n/, '');
  const body = text.slice(end + 4).replace(/^\s+/, '');
  const data = {};
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    data[m[1]] = val;
  }
  return { found: true, data, body };
}

function checkSkill(dirName, skillDir) {
  const errors = [];
  const warnings = [];
  const skillMd = path.join(skillDir, 'SKILL.md');

  if (!fs.existsSync(skillMd)) {
    errors.push('missing SKILL.md');
    return { name: dirName, errors, warnings };
  }

  const text = fs.readFileSync(skillMd, 'utf8');
  const fm = parseFrontmatter(text);

  if (!fm.found) {
    errors.push('no YAML frontmatter block (--- ... ---)');
    return { name: dirName, errors, warnings };
  }

  const name = fm.data.name;
  const description = fm.data.description;

  if (!name) {
    errors.push('frontmatter missing `name`');
  } else if (name !== dirName) {
    errors.push(`name "${name}" does not match directory "${dirName}"`);
  }

  if (!description) {
    errors.push('frontmatter missing `description`');
  } else {
    if (description.length < DESC_MIN) {
      warnings.push(`description is short (${description.length} < ${DESC_MIN} chars)`);
    }
    if (description.length > DESC_MAX) {
      warnings.push(`description is long (${description.length} > ${DESC_MAX} chars)`);
    }
    if (!/auto-?load/i.test(description)) {
      warnings.push('description has no auto-load trigger (pi-hunt convention)');
    }
  }

  if (!fm.body || fm.body.replace(/\s+/g, '').length < 30) {
    errors.push('SKILL.md has no real body content after frontmatter');
  }

  return { name: dirName, errors, warnings };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(2);
  }
  if (opts.help) {
    showHelp();
    process.exit(0);
  }

  const skillsRoot = opts.skillsRoot
    ? path.resolve(opts.skillsRoot)
    : path.resolve(__dirname, '..', 'skills');

  if (!fs.existsSync(skillsRoot)) {
    process.stderr.write(`Error: skills root not found: ${skillsRoot}\n`);
    process.exit(2);
  }

  const entries = fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const results = entries.map((name) => checkSkill(name, path.join(skillsRoot, name)));

  const totalErrors = results.reduce((n, r) => n + r.errors.length, 0);
  const totalWarnings = results.reduce((n, r) => n + r.warnings.length, 0);
  const ok = results.filter((r) => r.errors.length === 0 && r.warnings.length === 0).length;

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        { skillsRoot, total: results.length, ok, errors: totalErrors, warnings: totalWarnings, results },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`pi-hunt skills-health — ${skillsRoot}\n`);
    process.stdout.write(`${results.length} skills · ${ok} clean · ${totalErrors} errors · ${totalWarnings} warnings\n\n`);
    for (const r of results) {
      if (r.errors.length === 0 && r.warnings.length === 0) {
        process.stdout.write(`  OK    ${r.name}\n`);
        continue;
      }
      for (const e of r.errors) process.stdout.write(`  ERROR ${r.name}: ${e}\n`);
      for (const w of r.warnings) process.stdout.write(`  WARN  ${r.name}: ${w}\n`);
    }
  }

  const failed = totalErrors > 0 || (opts.strict && totalWarnings > 0);
  process.exit(failed ? 1 : 0);
}

main();
