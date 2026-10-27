# pi-hunt Prompting & Steering Cheat Sheet

This cheat sheet provides actionable instructions, grammar templates, and best practices for optimal and token-efficient steering of the `pi-hunt` coordinator.

> For model/provider orchestration (`pi-tier`, the failover watchers) and the recon-synthesis tooling (`pihunt-gadgets`, `pihunt-authz`, the gadget graph), see **`pi-hunt-tooling-cheatsheet.md`** in this folder.

---

## 1. Quick Reference & Triggers

To launch and steer a hunt, use the following interactive triggers:

### Hunt Trigger Grammar
```text
Hunt <PROGRAM> [in HackerOne|in Intigriti|in YesWeHack] [for <FLOOR>]
```
* **Severity Floors (`for <FLOOR>`):** Specify `for CRITICAL`, `for HIGH`, or `for CRITICAL/EXCEPTIONAL` (critical or above). The coordinator will aggressively pursue high-value branches and won't stop until findings matching the floor are validated by `strict-triager` or all leads are exhausted.

### Launch Examples
```bash
# Start an interactive TUI session (Default platform: Intigriti)
pi-hunt

# Headless one-shot execution
pi-hunt -p "Hunt finbank in Intigriti for HIGH"
```

---

## 2. Token-Efficient Prompting Strategies

To prevent coordinator context bloat and maximize token efficiency, follow these guidelines:

### A. Core Delegation Shape Rule
Do not ask the coordinator to run heavy operations directly. Instead, tell the coordinator to delegate tasks to specialist subagents using the correct shapes:

| Shape | Prompt/Instruction Template | Token Impact |
| :--- | :--- | :--- |
| **Single/Parallel** | `"Test the cart API for BOLA and the login flow for OAuth issues in parallel."` | Low (Isolated subagent contexts) |
| **Ensemble (Auth/Payment)** | `"Ensemble the OAuth login on login.acme.com, 6 passes, varying payload families."` | Medium (Runs 1 agent K times under different angles) |
| **Swarm (Broad Scope)** | `"Swarm every endpoint in js_assets.txt: idor-logic + sqli + injection, one cell each."` | High (RAM-gated queue; keeps coordinator context thin) |

### B. Network & Browser Discipline
* **Prefer Raw HTTP:** Tell the coordinator to use raw HTTP (`burp_*`) for API mutation, replay, and diffing.
* **Limit Browser Automation:** Tell the coordinator to use browser automation (`browser_live_*`) ONLY when Javascript execution or stateful login flows are necessary. Browser snapshots/DOM dumps are extremely token-heavy.
* **Steering Instruction:** `"Use raw HTTP requests for this API check, not the browser."`

---

## 3. Mid-Flight Steering & Refocusing

You can intervene in the TUI at any point to steer the coordinator mid-hunt:

### Refocusing Scope & Eliminating Dead Ends
* **Narrow the Surface:** `"Ignore everything except *.hotelco.io. Drop the WP-admin branch."`
* **Stop Negative Sweeps:** `"mobile-api-gateway BOLA is negative-swept. Stop and move to checkout."`
* **Escalate & Chain:** `"This open redirect is low-severity alone. Send it to security-analyzer to chain with the SSRF candidate."`

### Reflexive Disconfirmation (WAFs & Walls)
* The coordinator has an automatic disconfirmation gate, but you should verbally reinforce it when the agent hits a block:
* **Steering Instruction:** `"You hit a 429/403. Prove it's rate-limiting vs a WAF path signature. Try an encoded path (e.g. grap%68ql) and rotate egress before concluding."`

---

## 4. Subagent Lifecycle & Safety Habits

The single highest-leverage habit when using `pi-hunt` is ensuring no work is lost:

> [!IMPORTANT]
> **No Findings Lost Rule:** Every subagent's entire result is delivered ONLY via its final plain-text message. If it gets cut off or ends on a tool call, the work is lost.
> Always instruct agents to checkpoint findings to disk continuously.

### Key Prompts for Safety:
* **Pre-Swarm Checkpoint:** `"Checkpoint current findings to reports/ and memory before starting the swarm."`
* **Recovery:** If a subagent returns empty or `No result`, run: `"Re-run that specialist with a narrower, 1-step objective; it got cut off."`

---

## 5. Configuration Toggles

Routing is state-driven. The default keeps Kimi elite-only: coordinator + 16 hunters on `amd-radeon/DeepSeek-V4.1-Flash`, 8 mechanical on `mistral-direct/codestral-latest`, and only `strict-triager` / `hypothesis-redteam` on `kimi-coding/k3.1-pro`.

```bash
# Check current configuration & active agent counts
pi-tier status

# Restore the default three-tier mapping
pi-tier on

# Change just the coordinator (state file read by pi-hunt)
pi-tier set-coordinator amd-radeon/DeepSeek-V4.1-Flash:high

# Legacy Kimi-only quality toggle; does not touch DeepSeek/Mistral agents
pi-4.8 status
pi-4.8 on|off
```
