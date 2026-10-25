I have everything needed. The exploration is complete. I'm in Plan mode, so I'll present the full plan. Let me write the plan document to the plan directory as requested by the mission deliverables, then present it in the conversation.
Actually — the mission's deliverables are a set of artifacts (compatibility matrix, refactored prompt tree, smoke test, validation table, migration note). This is a large multi-phase implementation. Since I'm in plan mode)Skip repeated confirmations, write the plan file now. Let me create it.
←Write ~/.opencode/plan
Unable to write /home/souhail/.opencode/plan
The plan file write failed (directory may not exist). Let me present the plan directly in the conversation, which is the required behavior in Plan mode.
Plan: cl4r1t4s → harness prompt synthesis & fleet upgrade
I've completed the full Phase 1 inventory and assessment (read-only). Here's the plan.
What I found (Phase 1 — done)
Fleet (26 agents, ~78K tokens / 311,930 B):
Class	Model	Agents	Tokens
mechanical	google-direct/gemini-3.1-flash-lite	8	~16.9K
flagship	kimi-coding/k3	16	~53.8K
elite	kimi-coding/k3.1-pro	2	~7.3K
Boilerplate is real and quantified. Every flagship hunter inlines the same 5 sections:
- Return contract & reporting ≈ 1,530 B × 16
- Return contract (MANDATORY — read last) ≈ 1,168 B × 16
- Delegating to helper subagents ≈ 1,980 B × 16
- Confirm scope LIVE ≈ 847 B × 20/26
- Role ≈ 120–340 B × 25/26
⇒ ~90 KB of pure duplication across the 16 flagship hunters (of 215 KB). The mission's ~60% fleet-token-reduction target is achievable by factoring this into a shared base.
Architecture constraint (critical): pi's loader consumes one self-contained markdown per agent. skills/ is the on-demand injection mechanism (hunters already use it for chain-patterns etc.). prompts/ is interactive slash-commands, not the loader. So to do base+delta without changing architecture, I'll add a generator: prompts/base/ (shared sections) + class-delta + per-agent delta → build script emits the same self-contained files. Content refactored, loader untouched.
CL4R1T4S catalogued (108 prompts, 3 parallel sweeps done). Techniques mapped to classes below.
Phase 2 — synthesis rules (with cited source files)
Mechanical (gemini-3.1-flash-lite) — target <400 tok, zero discretion:
- Single-JSON-or-empty output contract → ZAI/ZCode/Prompts.md, ANTHROPIC/Claude-4.5-Opus
- "If X absent → empty list / not found" fallback → MULTION/MultiOn.md, Claude-Sonnet-4.5
- Enum-constrained fields → MULTION/MultiOn.md STATUS, XAI/GROK-4.1
- "Call immediately, never announce" → META/Muse_Spark
- "NEVER make redundant tool calls" → WINDSURF/Windsurf_Prompt.md
Flagship (kimi/k3) — 16 hunters, shared skeleton + thin delta:
- Tool-call budgeting / "don't call unless" → WINDSURF, Muse_Spark, CURSOR/Cursor_Prompt
- Root-cause-first → DEVIN/Devin_2.0.md
- Evidence-first PoC + negative control + "do not accept proxy signals as completion" → DEVIN2, ZAI/ZCode
- Tool-call loop cap (max 3) → CURSOR
- Verification gates → OPENAI/Codex.md
- New hard stop-conditions section (escalate→elite / hand to strict-triager / declare no-findings instead of padding) → MANUS idle gating, DEVIN2 BLOCK/DONE tri-state
Elite (k3.1-pro):
- Multi-step adversarial + mandatory self-reflection-before-DONE → DEVIN2, OPENAI/GPT-6-Astra
- strict-triager: duplicate/known-vuln heuristic + "reject with reason" JSON contract + confidence rubric → ZAI/ZCode, OPENAI/ChatGPT5, PERPLEXITY
Phase 3 — implementation
1. prompts/base/ (role, scope, return-contract, delegating, output-schema, stop-conditions, tool-discipline)
2. class-deltas: mechanical/ (compact), flagship/, elite/
3. per-agent deltas (only the vuln-class-specific content, pulled from existing files)
4. bin/prompt-build.sh generator → emits deployed + repo agent files
5. bin/prompt-smoke.sh — canned input per mechanical agent → schema-validate output, runnable across working providers (codestral-latest, gemini-3.5-flash-lite, deepseek-v4-flash, allam-2-7b); codestral for code-adjacent agents, gemini-3.5-flash-lite for the rest
6. bin/tsize.mjs — real tokenizer (vendored tiktoken in the copilot extension dir) for old→new counts
Phase 4 — validation
Smoke all 8 mechanical; dry-run sqli/oauth/llm hunters vs fixture; diff tool-calls + tokens + schema validity; summary table with cl4r1t4s source-file citations.
Before I proceed to implementation (need your call — I'm in plan mode)
1. Mechanical token target: strict <400 for all 8, or exempt recon (25 KB — it's really a workflow engine, not a loader)? Recon can't go under 400 without gutting it.
2. Smoke-test depth: schema-validate only (fast, per-provider), or also assert signal quality (needs a labeled fixture)?
3. Build script: bash (dependency-free) or node (matches pi-agent conventions)?
Tell me these three and switch me to the build agent — the plan is fully staged and ready to execute.
