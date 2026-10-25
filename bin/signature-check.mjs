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
 * Content only. Reference resolution lives in bin/ref-check.mjs; both are run by
 * bin/prompt-gate.mjs.
 *
 *   node bin/signature-check.mjs            # repo mirror + deployed tree (when present)
 *   node bin/signature-check.mjs --repo     # repo mirror only (CI)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.HOME;
const TREES = [["repo", path.join(REPO, "pi-agent", "agents")]];
const deployed = path.join(HOME, ".pi", "agent", "agents");
if (!process.argv.includes("--repo") && fs.existsSync(deployed)) TREES.push(["deployed", deployed]);

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
const bad = (scope, msg) => { fails++; console.log(`  FAIL  ${scope}: ${msg}`); };

for (const [label, dir] of TREES) {
  console.log(`\n== ${label}: ${dir.replace(HOME, "~")}`);

  console.log(`-- signature behaviours (pre-registered, per hunter)`);
  for (const [name, sigs] of Object.entries(HUNTERS)) {
    const f = path.join(dir, name + ".md");
    if (!fs.existsSync(f)) { bad(`${label}/${name}`, "agent file missing"); continue; }
    const t = fs.readFileSync(f, "utf8");
    const lost = sigs.filter(([, re]) => !re.test(t)).map(([sig]) => sig);
    console.log(`  ${lost.length ? "FAIL" : "PASS"}  ${name.padEnd(24)} ${sigs.length - lost.length}/${sigs.length}${lost.length ? "  lost: " + lost.join(", ") : ""}`);
    if (lost.length) fails++;
  }

  console.log(`-- safety invariants`);
  for (const name of ALL) {
    const f = path.join(dir, name + ".md");
    if (!fs.existsSync(f)) { bad(`${label}/${name}`, "agent file missing"); continue; }
    const t = fs.readFileSync(f, "utf8");
    const body = t.replace(/^---\n[\s\S]*?\n---\n?/, "");
    const heads = [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]);
    const first = heads[0] || "";
    if (!/authori[sz]ed testing/i.test(first)) bad(`${label}/${name}`, `first section is "${first}" (expected authorised-testing/scope-compliance)`);
    if (/return contract/i.test(first)) bad(`${label}/${name}`, "safety section displaced by return contract");
    if (!/return contract/i.test(body)) bad(`${label}/${name}`, "missing return contract");
    if (HUNTERS[name] && !/confirm scope live/i.test(body)) bad(`${label}/${name}`, "missing mandatory LIVE scope confirmation");
  }
}

console.log(fails ? `\nSIGNATURE CHECK: FAIL (${fails})` : `\nSIGNATURE CHECK: PASS (${Object.keys(HUNTERS).length} hunters, ${ALL.length} agents × ${TREES.length} tree(s))`);
process.exit(fails ? 1 : 0);
