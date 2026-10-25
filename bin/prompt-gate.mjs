#!/usr/bin/env node
/**
 * prompt-gate.mjs — one command, every prompt invariant. This is the gate that
 * must pass before a refactor is called done.
 *
 * Stages (all run; failures are collected so one bad stage does not hide another):
 *   1. build drift   — deployed agents + repo mirror must match a fresh build
 *   2. content       — 3 signature behaviours per hunter + safety invariants
 *   3. references    — skill/file/tool references resolve in repo AND deployed tree,
 *                      installer covers every skill, no reverse drift,
 *                      token budgets, static output-schema tokens
 *
 *   node bin/prompt-gate.mjs           # full (deploy tree when present)
 *   node bin/prompt-gate.mjs --repo    # repo-only (CI; skips deployed-tree stages)
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoOnly = process.argv.includes("--repo");

const stages = [
  ["build drift", "prompt-build.mjs", ["--check"]],
  ["content / signature", "signature-check.mjs", repoOnly ? ["--repo"] : []],
  ["references / budgets / schema", "ref-check.mjs", repoOnly ? ["--repo"] : []],
  ["gate self-test", "ref-check-selftest.mjs", []],
];

const results = [];
for (const [name, script, args] of stages) {
  console.log(`\n${"─".repeat(70)}\n▶ ${name}  (bin/${script} ${args.join(" ")})\n${"─".repeat(70)}`);
  const r = spawnSync(process.execPath, [path.join(REPO, "bin", script), ...args], { stdio: "inherit" });
  results.push({ name, ok: r.status === 0 });
}

console.log(`\n${"═".repeat(70)}\nPROMPT GATE SUMMARY`);
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log(`\nPROMPT GATE: FAIL (${failed.length}/${results.length} stages)`);
  process.exit(1);
}
console.log(`\nPROMPT GATE: PASS (${results.length}/${results.length} stages)`);
