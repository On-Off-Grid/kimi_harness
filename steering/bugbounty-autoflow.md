Global bug bounty workflow for this profile:

## Subagent return contract (MANDATORY)
- Return Contract: Checkpoint reports/Memory MCP incrementally. Stop before turn limit. End on a structured text summary (tested, evidence, status, next actions). Never return empty (a tool call or empty return discards all work).

When user intent is `Hunt <PROGRAM>` (or equivalent bug bounty hunt request), follow this order:

0. Treat every explicitly named command, tool invocation, MCP use, subagent call, report artifact, and checkpoint step in the active agent or subagent prompt as mandatory unless it is technically impossible, outside confirmed scope, or blocked by missing credentials or unavailable infrastructure.
   - Do not silently skip a named step because it seems unnecessary.
   - If a named step is blocked, state the blocker clearly and continue with the nearest valid alternative.
   - Subagents must not ask the user what to do next. If a subagent reaches ambiguity, branching choices, or a blocker, it must return the blocker, the assumptions, and ranked next actions to the parent agent instead of using the `question` tool.
   - Subagents must not create or rely on their own todo list. The parent agent owns todo state; subagents return checkpoints and ranked next actions to the parent instead.
   - Specialist subagents may delegate laterally to other specialist subagents when the evidence clearly crosses class boundaries or another specialist owns the next decisive step. Before a lateral handoff, write or refresh a compact Memory MCP note for the exact asset, auth state, signal, and next required specialist. Do not bounce the same unchanged hypothesis between specialists more than once; if the evidence did not materially change, continue locally or return to the parent with the blocker instead of ping-ponging.
   - Before calling any shell, Burp, browser-live, or other MCP tool, determine the full required arguments and expected signal. Never emit placeholder or empty tool calls; if inputs are not fully specified yet, continue reasoning until they are.
   - Before reading, parsing, or reusing any local artifact or `/tmp` file, verify it exists and is non-empty. If it is missing, recreate it from the producing step or switch to a direct query instead of blindly parsing a nonexistent file.
   - Before overwriting or appending to an existing local report or evidence file, read its current contents first. If the file changed since the last read, re-read it immediately before editing and merge or replace intentionally instead of issuing a blind write.
   - Invoke installed CLI tools by their PATH name by default. Do not call `./tool` unless a local executable at that exact path exists and is intentionally required.
   - `protonvpn` CLI is installed and available on PATH. If a task legitimately depends on egress location, source IP, ASN, geofenced behavior, region-specific content, or validating whether a behavior changes across network exit regions, you may use `protonvpn` deliberately as part of the workflow. Before changing the connection, record the current public IP or region and the reason for the switch. After the test batch, note which server or profile was used.
   - For browser-live browser work, prefer one `take_snapshot` to establish element UIDs, then reuse those UIDs with action tools that keep `includeSnapshot=false` by default. Refresh the snapshot only after navigation, a major DOM rewrite, or a stale-UID failure. Use `evaluate_script`, `list_network_requests`, and focused screenshots before taking another full snapshot.
   - For browser-live navigation on heavy apps, prefer explicit waits (`wait_for`, URL checks, targeted JS extraction) over repeated page-wide refresh loops. Do not narrate every click. Work in short browser batches, then return the decisive state change, current URL, key requests, and next actionable target.
   - Treat stale browser interaction as a controlled failure mode. After one initial browser-live batch, at most one fresh snapshot batch after a material DOM change, and at most one targeted JS or focused-network fallback, either switch strategy or return the blocker. Do not keep spending turns in the same browser loop.
   - For Burp requests to SSE, EventSource, long-polling, WebSocket-upgrade, or other long-lived endpoints, do not wait for a full response body completion as if it were a normal request. Use a bounded probe, handshake check, or alternate browser/raw HTTP method and treat `stream opened` or `upgrade/live response` as the signal instead of retrying the same timeout path.
1. Read any relevant `Memory MCP` entries for the program name, aliases, and prior leads, then call the matching scope loader (`@h1-scope-loader`, `@intigriti-scope-loader`, or `@yeswehack-scope-loader`) before any active testing.
   - Treat memory as prior context only, not as authoritative scope.
   - The primary coordinator agent owns the initial scope load (to build the scope record). EVERY subagent MUST independently read and trust the locally saved, verified scope record at `reports/<program>/structured-recon/scope.md`. If the file is missing or empty, the subagent must stop immediately and report the missing scope blocker. Subagents do not query external platform APIs for scope verification.
   - When a program-level structured recon memory entry exists, read it before starting specialized testing. Use a stable key such as `<program>|structured-recon` and stable tags such as `<program>+structured recon` so later subagents can find it reliably.
   - Treat the structured recon memory entry as the authoritative pointer to recon artifact files. It should tell later subagents where files like `subdomains_live.txt`, `hosts_resolved.txt`, `takeover_candidates.txt`, `routes.txt`, `params.txt`, `js_assets.txt`, `api_hosts.txt`, and the recon manifest are stored.
   - Before doing broad free-text memory search for a program branch, first look up deterministic program keys such as `<program>|structured-recon` and any known finding keys, then read the referenced manifest or artifact files directly. Use fuzzy memory search only after the deterministic program entry was checked.
   - When the parent or a broad general-purpose agent spawns a child task and already knows the structured recon manifest path or relevant recon artifact paths, include those exact paths in the child task text so the child reuses recon artifacts instead of re-running recon. Children read and validate scope locally using the `reports/<program>/structured-recon/scope.md` file rather than hitting external platform APIs.
2. Build a scope record using the platform API (HackerOne: `$H1_API`, Intigriti: `$INTIGRITI_APP`, YesWeHack: `$YWH_API`/credentials). Fallback to official public page if credentials/API fail.
3. Restrict all recon and testing to confirmed in-scope assets.
4. If authenticated testing is required and no test account exists, call `@test-account-manager` only to create, verify, manage, or recover authorized test identities and capture first-party credentials or tokens issued during that flow.
   - If account creation or account management reveals a possible vulnerability, return that lead to the parent for a dedicated hunter instead of continuing as `@test-account-manager`.
5. If recon yields source-rich artifacts (JS bundles, source maps, `.git`, runtime config, lockfiles, or credential-bearing secrets), hand off to `source-review` before payload-led specialists.
   - For mature public programs, require `source-review` or `hypothesis-redteam` before broad payload-researcher / gf / generic payload-family fan-out.
6. If the target exposes AI/chatbot/agent features, or an MCP/tool-protocol surface, call `@llm-hunter` before broad payload spray or other class-specific testing.
   - Do only the minimum scope/liveness/fingerprint work needed to confirm the AI or MCP surface and capture the initial evidence, then hand the branch to `@llm-hunter` immediately.
   - The parent, `@general`, `@explore`, and `@recon` may spend at most one short confirming batch on an AI/MCP surface after recognition. A short confirming batch means no more than roughly 3 direct HTTP requests or one browser batch plus one fallback. After that, they must spawn `@llm-hunter` or return a concrete blocker.
   - Do not let `@recon` or the parent keep a multi-turn exploit branch on an AI/MCP target once that surface is confirmed.
7. Run exploration and testing with relevant security subagents based on surface and signals (`@recon`, `@xss-hunter`, `@sqli-hunter`, `@ssrf-hunter`, `@rce-hunter`, `@llm-hunter`, `@path-traversal-hunter`, `@request-smuggling-hunter`, `@race-condition-hunter`, `@idor-logic-hunter`, `@security-analyzer`, `@bypass-innovator`, `@payload-researcher`).
7. When selecting payloads, fuzz inputs, or wordlists depends on the exact technology, sink, parser, framework, WAF, or discovery goal, call `@payload-researcher` before broad fuzzing or before deep exploit attempts.
   - Use it for endpoint/file/path/parameter/header wordlists, framework-specific recon lists, XSS payload families, SQLi payload families, SSRF variants, traversal file-target lists, request-smuggling variants, RCE payloads, prompt-injection strings, and WAF-aware bypass inputs.
   - Use it for tool choice too when the scenario may benefit from a specialized fuzzer, crawler, smuggling helper, desync helper, wordlist source, or framework-specific utility.
   - Call it with one exact objective at a time. Split unrelated payload families into separate payload-researcher tasks instead of asking one subagent to cover the whole hunt branch.
   - Do not call it for trivial baseline probes where standard defaults already provide complete baseline coverage.
8. Use payout-optimized ordering by expected value: prioritize findings with highest likely bounty and exploitability first.
   - Tier 1: RCE, auth bypass/ATO, high-impact SSRF, request smuggling desync impact, critical business-logic and race-condition abuse.
   - Tier 2: IDOR/BOLA with sensitive read/write, path traversal/LFI with high-value file access, privilege escalation paths.
   - Tier 3: XSS/SQLi and medium-impact classes unless they chain to account takeover, data theft, or admin compromise.
   - If the user sets a severity floor such as `CRITICAL`, `HIGH`, or `CRITICAL or HIGH`, keep focusing on branches that can still plausibly meet that floor. Do not stop only because lower-severity or invalid findings were produced. Stop only when a finding at or above the floor is validated, or when the relevant high-value in-scope branches are exhausted, blocked, or ruled out with evidence.
9. For every candidate vulnerability (not every exploratory step), call `@strict-triager` before presenting a final finding.
   - `@strict-triager` must not issue a verdict from narrative alone. It must read the referenced local report/evidence files and verify each material claim with a direct rerun, artifact check, Burp request, browser step, or command whenever that can be done safely and in scope.
   - If a material claim cannot be rerun safely, `@strict-triager` must state that blocker explicitly and keep the verdict at `Needs More Evidence` or `Invalid`.
   - When triaging a retained finding folder, `@strict-triager` must also write a local `response.md` file in that same folder that reads like a concise human triager response: what is accepted as proven, what is missing, the current verdict, and the next exact action required.
10. Only report findings marked `Valid` by triage, or keep `Needs More Evidence` findings in a separate follow-up list with missing evidence explicitly stated.
11. For every candidate finding kept after triage, create a dedicated local folder at `reports/<program>/<timestamp>-<slug>/`.
   - Required files in each finding folder:
   - `title.txt`
   - `description.md`
   - `weakness.txt`
   - `severity.txt`
   - `asset.txt`
   - `impact.md`
   - `response.md`
   - `files/` for screenshots, raw requests, relevant response excerpts, and other evidence artifacts
   - Write `description.md` in plain, direct language. Avoid stiff wording, unnecessary jargon, or over-explaining obvious steps.
   - Make `description.md` copy-paste reproducible. Include the exact commands, requests, URLs, headers, parameters, and execution order needed to reproduce.
   - If reproduction depends on first-party test accounts, target-issued tokens, cookies, API keys, invite links, or other legitimate test values created during the hunt, include those exact values in the local report and label them clearly so a triager can run the steps without rebuilding the setup.
12. Never submit anything to HackerOne or any other bounty platform from the agent. The agent may load scope and rules, but reporting stops at local artifact creation.
13. For every vulnerability class, execute dual-track tests:
   - Positive-path tests likely to work
   - Negative-path tests expected to fail (invalid, contradictory, malformed, wrong-role, or wrong-state cases)
14. Use MCPs where they improve efficiency and confidence:
   - browser-live MCP for JS-rendered routes, stateful auth flows, DOM behavior, live Chrome inspection, and visual/UI verification.
   - Burp MCP for precise HTTP replay, parameter mutation, request diffing, and evidence capture.
   - Memory MCP at hunt start for retrieval, then during the hunt to persist high-signal findings, failed hypotheses, and reusable bypass patterns across sessions.
   - GitHub MCP for public GitHub code, repository, issue, and pull request search on framework fingerprints, route patterns, vulnerable usage patterns, payload snippets, and open-source deployments that resemble the target stack.
   - X/Medium MCP for technique research and practitioner OSINT.
   - Cross-check critical findings across browser-level and raw HTTP views before final reporting.

Quality guardrails:
- Do not let triage block broad exploration. Triage only candidate findings to avoid reducing discovery rate.
- Keep scope loading reliable and complete: use `@h1-scope-loader` for scope extraction, not high-cost deep analysis agents.
- Do not force account creation unless testing genuinely requires authenticated access.
- `@recon` is a mapper, not the main exploit worker. Once a lead clearly belongs to a specialist class, `@recon` must capture the decisive evidence, update structured recon artifacts/memory, and hand off within one short confirming batch instead of continuing the exploit branch itself.
- A short confirming batch for `@recon` means one focused request family, one focused browser batch, or a small bounded command batch to verify the surface classification. If that batch is complete and the lead is still specialist-owned, recon must stop local exploit work and hand off.
- AI/chatbot/agent/MCP surfaces are not ordinary recon leads. Once identified, they should be routed to `@llm-hunter` immediately after the minimum confirming evidence is captured.
- `@recon` must not write a takeover candidate on weak evidence like one-off `000`, generic timeouts, or a single failed fetch. Write to `takeover_candidates.txt` only when you have a provider-specific orphaning signal or at least two independent confirming indicators. Put weaker signals into a separate holding file such as `takeover_weak_signals.txt`.
- Use `@payload-researcher` intentionally. It should improve hit rate for scenario-specific payload and wordlist selection and increase coverage quality, not delay baseline probes that are already fully covered by standard defaults.
- `@payload-researcher` must answer the exact scenario it was asked about. It must not recap the whole hunt, reprioritize unrelated branches, or end with a user-facing option menu. If broader hunt context matters, include it as one short `Relevant Context` note and still return the exact payload or wordlist deliverable requested.
- If `@payload-researcher` returns a recap, a broad hunt summary, or a menu of next-step choices instead of the exact payload, wordlist, commit, or tooling deliverable requested, treat that run as failed scope control. Re-issue the task once with a narrower exact objective and required output sections instead of summarizing the bad answer.
- When `@payload-researcher` returns payloads, wordlists, request bodies, or reusable commands longer than a few lines, it must save them into local artifact file(s) and return the exact artifact path(s). Parent agents should treat a summary-only answer with no artifact path as incomplete when a reusable payload deliverable was requested.
- For passive retrieval of public JS bundles, source maps, static assets, and public documentation, prefer browser-live MCP, GitHub MCP, `curl`, or direct raw-file fetches. Do not use OpenCode's built-in `webfetch` or `websearch`; they are disabled so web access stays routed through MCP/browser tooling. Reserve Burp for HTTP mutation, replay, differential testing, and evidence capture where raw interception is actually needed.
- If a tool materially improves coverage, validation quality, or speed and it is missing, install the latest stable release from an official source or trusted package manager and use it with scenario-appropriate flags after checking current docs or `--help`.
- SecLists is installed at `/usr/share/seclists`. Prefer focused maintained lists from there before downloading ad hoc copies of the same wordlists.
- Prefer current, well-maintained tooling when it materially improves findings, but avoid churn from installing tools that do not help the exact scenario.
- If a tool supports authenticated or API-key-backed modes, use only credentials that already exist, are target-owned, or can be legitimately created inside the authorized workflow. If first-party test credentials are needed, call `@test-account-manager`. Do not obtain unrelated third-party API keys.
- `@test-account-manager` uses browser-live MCP exclusively for ALL browser work — discovery, multi-step create/verify/login, password reset, invite acceptance, OTP, and inbox-confirmation flows. Open an isolated context per target with `new_page` + `isolatedContext` to keep sessions separate. Take one `take_snapshot` to get element UIDs and reuse them with `fill`/`fill_form`/`click`/`wait_for`/`evaluate_script` until the DOM changes; prefer `evaluate_script` for complex DOM extraction over repeated snapshots. Use `list_network_requests`/`get_network_request` to capture tokens, cookies, and API responses. Do NOT spawn standalone Chrome, Zendriver, Playwright, Puppeteer, or any other browser process, the browser-live Chrome is already running, use it. If a flow is blocked even through browser-live (hard anti-bot/CAPTCHA), sleep for 3 minutes over and over agin untill the operator solves it manually for you.
- In browser-live, verify that the selected page or tab still matches the intended host, URL family, and auth state before acting. If the wrong page is selected, re-select the right page or open a fresh isolated context instead of continuing in the stale one.
- When Gmail or inbox work yields a decisive OTP, magic link, invite URL, or verification code, write that extracted value once to a stable local artifact and reuse that artifact instead of rereading the same full HTML message unless the message materially changed.
- When `@llm-hunter` or another specialist needs multi-step account creation, login bootstrap, verification, OTP handling, or inbox polling, it may do only one short confirming setup batch itself. After that, it must hand the workflow to `@test-account-manager` and stay focused on the exploit logic.
- If scope data is ambiguous, pause active exploitation and ask for clarification instead of guessing scope.
- If a specialist is close to step cap, checkpoint current evidence, payloads tried, and next 3 actions before it stops.
- If cap is reached near a promising lead, immediately re-invoke the same specialist with the checkpoint and continue from there.
- Subagent failures: If empty/failed, retry up to 3 times with adjusted inputs/narrower task before switching specialists.
- Heavy tools: Work in bounded batches of 10-15 requests. Checkpoint evidence and status before continuing.
- Memory MCP: Save findings to `<program>|<asset>|<weakness>|<auth-state>|<surface>` (status, proof summary, paths). No raw dumps or secrets.
- Reporting: Save to `reports/<program>/<timestamp>-<slug>/` with standard files. Summarize raw outputs and large data; use artifact paths.
- Learning loop: Specialists must emit exactly one tagged line (INSTINCT: / DEADEND: / CHAIN:) at each decision point. Promotion depends on these tags.
- Keep outputs reproducible and evidence-first.
