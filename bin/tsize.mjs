#!/usr/bin/env node
/**
 * tsize.mjs — token counter for prompt files (tiktoken cl100k, the most
 * widely available tokenizer; used only for before/after size reporting).
 *
 *   node bin/tsize.mjs file.md [file2.md ...]   -> per-file + total token count
 *   echo -n "text" | node bin/tsize.mjs --stdin -> count of stdin
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let enc;
try {
  ({ getEncoding } = require("js-tiktoken"));
  enc = getEncoding("cl100k_base");
} catch {
  // dependency missing -> byte/4 estimate (never fail CI for a stat)
  enc = { encode: (t) => new Array(Math.ceil(t.length / 4)).fill(0) };
}

const args = process.argv.slice(2);
let total = 0;
for (const a of args) {
  if (a === "--stdin") {
    const t = fs.readFileSync(0, "utf8");
    process.stdout.write(String(enc.encode(t).length) + "\n");
    process.exit(0);
  }
  if (a === "--stdin-body") {
    // same accounting as file mode: strip the first frontmatter block
    const t = fs.readFileSync(0, "utf8");
    const fm = t.match(/^---\n[\s\S]*?\n---\n?/);
    process.stdout.write(String(enc.encode(fm ? t.slice(fm[0].length) : t).length) + "\n");
    process.exit(0);
  }
  const t = fs.readFileSync(a, "utf8");
  // count the loaded prompt exactly as the subagent loader sees it:
  // everything AFTER the first frontmatter block (pi's parseFrontmatter keeps one block;
  // any legacy second frontmatter was dead bytes, never in the model's context)
  const fm = t.match(/^---\n[\s\S]*?\n---\n?/);
  const body = fm ? t.slice(fm[0].length) : t;
  const n = enc.encode(body).length;
  total += n;
  console.log(`${String(n).padStart(6)} tok  ${path.basename(a)}`);
}
if (args.length) console.log(`${String(total).padStart(6)} tok  TOTAL`);
