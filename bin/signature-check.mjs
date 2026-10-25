#!/usr/bin/env node
/**
 * signature-check.mjs — prove each refactored agent kept its class-specific edge.
 *
 * For every hunter we pre-registered 3 "signature behaviours": concrete,
 * class-defining capabilities that must survive refactoring (grep-able here).
 * Also asserts the non-negotiable safety invariants on ALL agents:
 *   - the authorised-testing / scope-compliance section is the FIRST body section
 *   - hunters confirm scope LIVE (scope section present)
 *   - the caller's return contract is present (a silent run loses everything)
 *
 *   node bin/signature-check.mjs
 */
import fs from "node:fs";
import path from "node:path";

const AG = path.join(process.env.HOME, ".pi", "agent", "agents");
const HUNTERS = {
  "bypass-innovator": [["WAF", /WAF/i], ["CSP", /CSP/i], ["parser-level behaviour", /parser/i]],
  "cache-poison-hunter": [["unkeyed input", /unkeyed/i], ["cache deception", /web cache deception/i], ["poisoning", /poison/i]],
  "cve-misconfig-hunter": [["vulnscan orchestrator", /pihunt-vulnscan/i], ["CVE mapping", /CVE/i], ["default credentials", /default cred/i]],
  "deep-research": [["source quality", /source/i], ["verification", /verif/i], ["recency", /recen|current|latest/i]],
  "idor-logic-hunter": [["authz matrix", /authz/i], ["BOLA", /BOLA/i], ["object enumeration", /enumerat/i]],
  "injection-hunter": [["SSTI", /SSTI/i], ["XXE", /XXE/i], ["non-SQL injection (LDAP/NoSQL)", /NoSQL|LDAP/i]],
  "llm-hunter": [["prompt injection", /prompt injection/i], ["tool abuse", /tool[- ]?(call|abuse|invocation|use)/i], ["exfiltration", /exfil/i]],
  "oauth-hunter": [["redirect_uri", /redirect_uri/i], ["PKCE", /PKCE/i], ["SAML", /SAML/i]],
  "path-traversal-hunter": [["traversal", /traversal|\.\.\//i], ["upload/filename", /upload|filename/i], ["LFI", /LFI/i]],
  "race-condition-hunter": [["single-packet", /single-packet/i], ["TOCTOU", /TOCTOU|time-of-check/i], ["limit overrun", /overrun|limit[- ]overrun|double/i]],
  "rce-hunter": [["deserialization", /deserial/i], ["SSTI", /SSTI/i], ["out-of-band confirmation", /out-of-band|OOB/i]],
  "request-smuggling-hunter": [["CL.TE", /CL\.TE/i], ["TE.CL", /TE\.CL/i], ["desync / HTTP-2", /desync|HTTP\/2/i]],
  "security-analyzer": [["gadget chaining", /gadget/i], ["ledger", /ledger/i], ["chain analysis", /chain/i]],
  "sqli-hunter": [["UNION", /union/i], ["error-based", /error-based/i], ["boolean/time blind", /boolean|time-blind|timing/i]],
  "ssrf-hunter": [["cloud metadata", /metadata/i], ["bypass tiers", /bypass/i], ["OOB", /out-of-band|OOB/i]],
  "xss-hunter": [["DOM XSS", /DOM/], ["supply-chain", /supply-chain/i], ["CSP", /CSP/i]],
  "hypothesis-redteam": [["adversarial hypotheses", /adversarial/i], ["challenges 'looks safe'", /challenge/i], ["negative control", /negative control/i]],
  "strict-triager": [["verdict categories", /verdict categories/i], ["confidence rubric", /confidence/i], ["duplicate detection", /duplicate/i]],
};

const ALL = ["h1-scope-loader", "intigriti-scope-loader", "yeswehack-scope-loader", "payload-researcher", "recon",
  "test-account-manager", "visual-security", "wordlist-curator", ...Object.keys(HUNTERS)];

let fails = 0;
const bad = (name, msg) => { fails++; console.log(`  FAIL  ${name}: ${msg}`); };

console.log("== signature behaviours (pre-registered, per hunter)");
for (const [name, sigs] of Object.entries(HUNTERS)) {
  const f = path.join(AG, name + ".md");
  if (!fs.existsSync(f)) { bad(name, "deployed file missing"); continue; }
  const t = fs.readFileSync(f, "utf8");
  const lost = sigs.filter(([, re]) => !re.test(t)).map(([label]) => label);
  console.log(`  ${lost.length ? "FAIL" : "PASS"}  ${name.padEnd(24)} ${sigs.length - lost.length}/${sigs.length}${lost.length ? "  lost: " + lost.join(", ") : ""}`);
  if (lost.length) fails++;
}

console.log("\n== safety invariants (all agents)");
for (const name of ALL) {
  const f = path.join(AG, name + ".md");
  if (!fs.existsSync(f)) { bad(name, "deployed file missing"); continue; }
  const t = fs.readFileSync(f, "utf8");
  const body = t.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const heads = [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]);
  const first = heads[0] || "";
  if (!/authori[sz]ed testing/i.test(first)) bad(name, `first section is "${first}" (expected authorised-testing/scope-compliance)`);
  if (/return contract/i.test(first)) bad(name, "safety section displaced by return contract");
  if (!/return contract/i.test(body)) bad(name, "missing return contract");
  if (HUNTERS[name] && !/confirm scope live/i.test(body)) bad(name, "missing mandatory LIVE scope confirmation");
}
console.log("\n== offloaded skill pointers resolve");
{
  const repoSkills = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "skills");
  const depSkills = path.join(process.env.HOME, ".pi/agent/skills");
  let seen = 0;
  for (const name of ALL) {
    const f = path.join(AG, name + ".md");
    if (!fs.existsSync(f)) continue;
    for (const m of fs.readFileSync(f, "utf8").matchAll(/skills\/([a-z0-9-]+)\/SKILL\.md/g)) {
      seen++;
      const s = m[1];
      if (!fs.existsSync(path.join(repoSkills, s, "SKILL.md"))) bad(name, `points at missing repo skill ${s}`);
      if (!fs.existsSync(path.join(depSkills, s, "SKILL.md"))) bad(name, `points at undeployed skill ${s}`);
    }
  }
  console.log(`  ${seen} pointer(s) checked`);
}

console.log(fails ? `\nSIGNATURE CHECK: FAIL (${fails})` : `\nSIGNATURE CHECK: PASS (${Object.keys(HUNTERS).length} hunters, ${ALL.length} agents)`);
process.exit(fails ? 1 : 0);
