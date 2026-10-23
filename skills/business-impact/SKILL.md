---
name: business-impact
description: "Translate every finding into the target company's business and dollar terms — how much money the company loses if this bug stays unfixed. Forces the model to first build a business model of the target, then evaluate each report through the dual lens of the company's own triager (risk/budget owner) and the company's own security researcher (adversary/defender). Auto-loads when writing impact.md, assessing severity, building the payout-optimized finding queue, or whenever strict-triager / security-analyzer scores a candidate finding."
---

## Purpose

Severity is not a property of a payload — it is a property of **what the target company stands to lose**. A reflected XSS on a marketing blog and the same XSS on a banking dashboard are technically identical and economically a thousand-fold apart. This skill makes you reason about the second number.

Use it to:
1. **Understand the business** of the target before scoring anything.
2. **Quantify the loss** the company eats if the reported bug stays live (worst-case AND realistic-case, with stated assumptions).
3. **Score like the company's own people** — both the internal triager who signs the bounty cheque and the internal security researcher/defender who knows the real blast radius.

Impact ALWAYS follows proof. This skill does not let you inflate a finding — it forces the loss estimate to be anchored to what was actually demonstrated (see strict-triager's "proven vs theoretical" rule). Fabricated precision ("this is a $4.88M bug") with no model behind it is a triage red flag, not a strength.

---

## Step 1 — Build the target's business model (do this ONCE per program, cache it)

Before scoring any finding, answer these. Write the answers to `reports/<program>/business-model.md` and refresh a Memory MCP entry keyed `<program>|business-model` so every hunter/triager reuses it.

| Question | Why it changes the dollar figure | Where to find it |
|---|---|---|
| **What does the company sell?** | Defines the crown jewels and the worst-case story. | Marketing site, `/about`, `/pricing`, docs, app store listing |
| **How does it make money?** (subscriptions, transactions/%, ads, enterprise seats, marketplace take-rate) | Tells you whether direct financial-logic bugs (price/race/refund) hit revenue directly. | Pricing page, billing flows, investor/press pages |
| **Who are the customers?** (B2C consumer, B2B SMB, B2B enterprise, government, regulated industries) | Enterprise/gov/regulated = contractual penalties, SLA credits, and churn worth $$$ per logo. | Customer logos, case studies, "trusted by", SOC2/compliance page |
| **What is the most sensitive data?** (payment/PAN, health/PHI, gov/defense, private messages, credentials, source/IP, biometrics, location) | Picks the regulatory regime and per-record breach cost band. | Privacy policy, data-processing addendum, the app itself |
| **Which regulations apply?** (GDPR, UK-GDPR, CCPA/CPRA, HIPAA, PCI-DSS, GLBA, SOX, FedRAMP, DORA, NIS2, sector rules) | Fines are often the single biggest line item. | Privacy/compliance/trust page, jurisdiction of HQ + customers |
| **Public or private company? Revenue scale?** | GDPR fine ceiling = 4% of **global annual turnover**; public co = stock/8-K exposure. | SEC filings/10-K, Crunchbase, press, headcount as a proxy |
| **What is the realistic threat actor?** (opportunistic scanner, fraud ring, competitor, nation-state, malicious insider) | Sets exploit likelihood and whether "scaled/automated" is realistic. | Industry + the program's own threat-model language in policy |
| **What does the program already say it cares about?** | The bounty table IS the company telling you its own loss function. | HackerOne/Intigriti policy: severity→bounty table, "what we care about", explicit exclusions |
| **What defense-in-depth already exists?** | Existing mitigations shrink realistic loss (and the triager WILL cite them). | Observed controls: WAF, MFA, encryption, monitoring, segmentation |

**The bounty table is gold.** If the program pays $20k for ATO and $250 for info-disclosure, the company has literally priced its own loss function. Anchor your dollar estimates and your severity to that table first; outside benchmarks are secondary calibration.

---

## Step 2 — Score through the company's two internal lenses

A defensible severity is the point where these two people AGREE. Run every candidate finding through both before writing `impact.md`.

### Lens A — The company's triager / risk owner (the one who pays)
Pragmatic, budget-constrained, defense-in-depth-aware, duplicate-allergic. They ask:
- "Is this **actually reachable** in production by a real unauthenticated/low-priv attacker, or only in a lab/with admin already?"
- "Is it **already mitigated** by another control (WAF, MFA, short token TTL, server-side re-validation, encryption at rest)?"
- "What is the **realistic** worst case, not the theoretical one? Is the scary version gated behind preconditions we don't actually expose?"
- "Is this **by design** / accepted risk / a known issue / a duplicate?"
- "Would I rather spend eng time + bounty $ here, or on the next report in the queue?"
This lens DOWNGRADES: theoretical impact, self-XSS, empty-200 'bypasses', staging-only info leaks, missing-header noise, anything needing unrealistic preconditions.

### Lens B — The company's security researcher / blue-team defender (the one who models the breach)
Adversarial, chain-minded, blast-radius-focused. They ask:
- "If I were the attacker, **what do I actually walk away with** — how many users, how many records, which privileges?"
- "Can this be **automated and scaled** (enumeration, mass ATO), or is it one-victim-at-a-time?"
- "Does it **chain**? (open redirect→OAuth token theft, IDOR→PII→mass reset, SSRF→metadata→cloud account). See chain-patterns."
- "Does it cross a **trust/tenant boundary**, touch money, or reach a crown-jewel datastore?"
- "Would this trigger **breach-notification obligations** if exploited?"
This lens UPGRADES: cross-tenant access, write/state-change over read, auth/identity bugs, money flows, anything that scales, anything that chains to a crown jewel.

**Reconcile:** Lens B sets the ceiling (max plausible loss), Lens A sets the floor (what's realistically reachable + already-mitigated). Report the band, lead with the realistic figure, and name the assumptions that move it.

---

## Step 3 — Quantify the loss ("how much does the company lose if this stays?")

Express loss as a small set of named components. Show your arithmetic and your assumptions; an estimate with a visible model beats a confident single number.

```
Realistic Annual Loss Exposure ≈ Σ (component cost × likelihood it materialises)
```

Loss components — pick the ones the finding actually triggers (do NOT stack all of them by reflex):

1. **Direct fraud / theft** — payment/price/race/refund/balance bugs. Loss = transaction value × abuse rate × time-to-detect. Often the cleanest, hardest-to-dispute dollar figure.
2. **Data-breach cost** — if records are exposed. Loss ≈ records exposed × per-record cost (see benchmark table). Includes forensics, notification, credit monitoring, legal.
3. **Regulatory fines** — the big one. Map data type → regime → ceiling (table below). For GDPR, anchor to **4% of global turnover or €20M, whichever is higher** for severe cases; cite the realistic-enforcement band, not just the ceiling.
4. **Customer churn / lost revenue** — trust-sensitive businesses (privacy, fintech, messaging). Loss ≈ at-risk customers × ARPU/ACV × expected churn lift. Enterprise: a single referenceable logo leaving can be six/seven figures.
5. **Contractual / SLA penalties** — B2B/enterprise/gov: breach-of-contract, SLA service credits, MSA security-clause penalties, loss of certification (SOC2/FedRAMP/ISO) → loss of the ability to sell to a whole segment.
6. **Incident response & remediation** — eng hours, IR retainer/forensics, legal, PR, emergency patch, customer support surge.
7. **Reputational / market** — brand damage, press, and for public companies stock/market-cap reaction + 8-K/disclosure cost.
8. **IP / competitive loss** — source code, algorithms, roadmap, unreleased product (crown jewels for deep-tech, gaming, trading firms).

Then frame it as **cost of inaction vs cost of fix**: "Leaving this open risks ~$X (realistic) to ~$Y (worst case); the fix is ~N eng-hours + a config change." That single sentence is what turns a report into a paid report — it's the argument the internal triager makes to their own management.

---

## Step 4 — Map the dollar model back to severity & bounty

1. **Anchor to the program's own bounty table first.** Place the finding next to the named examples the program pays for. That's the company's self-declared loss function.
2. **Cross-check with CVSS 3.1** (strict-triager computes this independently — don't override it, reconcile with it). If your dollar story says "mass ATO" but the CVSS vector says low scope/no integrity impact, one of them is wrong — fix the analysis, not the score.
3. **Let the loss band drive Critical/High/Medium/Low**, calibrated to the business:
   - **Critical** — directly hits crown jewels at scale: mass ATO, cross-tenant PII/PHI/PAN at scale, RCE, direct money theft, regulatory-fine-triggering breach. (Loss band: regime fine ceiling / many-record breach / direct fraud.)
   - **High** — serious but bounded: single-victim ATO, sensitive IDOR/BOLA read or write, SSRF reaching internal/metadata, auth bypass on a real boundary.
   - **Medium** — real but mitigated/limited: reflected XSS, blind SSRF w/o extraction, info disclosure with some sensitivity, logic bug with friction.
   - **Low / Info** — minimal realistic loss: by-design exposure, staging-only, theoretical, already-defended, non-sensitive disclosure.
4. **Respect the program's stated priorities and exclusions** — if they exclude an issue class or call it accepted risk, the realistic bounty is $0 regardless of your CVSS; say so honestly (see the Wickr example below).

---

## Step 5 — Write the business-impact narrative (`impact.md` template)

```markdown
# Impact

## Proven impact (what the replay actually demonstrated)
<Only what was reproduced. Exact data fields/records/privileges obtained. No speculation here.>

## Realistic attacker scenario
<Who attacks, from what auth position, what they do step-by-step, what they walk away with.
 Note if it scales/automates and whether it chains (link chain-patterns).>

## Business & financial loss if unfixed
- Affected crown jewel: <data/system/money flow>
- Loss components triggered: <fraud | breach cost | regulatory fine | churn | SLA | IR | reputational>
- Realistic loss estimate: ~$<X> — assumptions: <records, ARPU, abuse rate, regime, scale>
- Worst-case loss: ~$<Y> — preconditions: <what must also be true>
- Who bears it: <customers / company / partners> ; triggers breach-notification? <yes/no, why>

## Cost of inaction vs cost of fix
Leaving open ≈ $<X>–$<Y>. Fix ≈ <N eng-hours / config change>. <one-line "why pay now">.

## Honest scoping / what this is NOT
<Existing mitigations, defense-in-depth, what was NOT proven, by-design caveats,
 why the realistic figure is lower than the worst case.>
```

Keep the assumptions visible and conservative. A triager trusts a report that says "assuming ~5,000 affected accounts at ~$165/record breach cost" far more than one that just shouts "$825k!".

---

## Reference: regulatory fine quick-map (calibration bands, not legal advice)

| Regime | Triggered by | Realistic / ceiling exposure |
|---|---|---|
| **GDPR / UK-GDPR** | EU/UK personal data exposure | Up to **4% of global annual turnover or €20M (whichever higher)** for severe; typical enforced fines 6–8 figures |
| **CCPA / CPRA** | California consumer PII | ~$2,500/violation (unintentional), ~$7,500 (intentional/minors) — **per record**, scales fast |
| **HIPAA** | US health data (PHI) | Tiered ~$100–$50k **per violation**, annual cap ~$1.5M+ per category; OCR settlements often 6–7 figures |
| **PCI-DSS** | Cardholder data (PAN) | Card-brand fines ~$5k–$100k/month + per-card reissue/fraud + possible loss of processing ability |
| **GLBA / SOX** | US financial institutions / public-co financial integrity | Regulatory penalties + officer liability; SOX touches financial-reporting integrity bugs |
| **FedRAMP / CMMC / ITAR** | US gov / defense data | Loss of authorization to operate = loss of the entire gov revenue line; export-control penalties |
| **DORA / NIS2 / PSD2** | EU financial & critical-infra & payments | Operational-resilience + strong-customer-auth penalties; rising enforcement |

## Reference: data-breach cost benchmarks (IBM Cost of a Data Breach era, 2024–2025)

- Global average total breach ≈ **$4.4M–$4.9M**; per-record ≈ **$160–$180** (PII), higher for sensitive classes.
- **Healthcare** is consistently the most expensive industry (~$9–10M avg breach); financial services next.
- Mega-breaches (>1M records) scale into tens/hundreds of millions.
- Use these as **calibration bands** with stated record counts — never as a finished number divorced from how many records the finding actually exposes.

## Reference: business model → crown jewel → dominant loss driver

| Business model | Crown jewels | Dominant loss driver to model first |
|---|---|---|
| **Fintech / payments / crypto** | Funds, PAN, KYC/PII, ledgers | Direct fraud + PCI/financial-reg fines + total trust collapse |
| **Healthcare / health-tech** | PHI, clinical data | HIPAA + per-record breach (highest band) + patient-safety/contract loss |
| **B2B SaaS (enterprise)** | Tenant data, admin, SSO, source | Cross-tenant breach + SLA/MSA penalties + SOC2/FedRAMP loss → segment lockout |
| **Consumer social / messaging / privacy** | Private messages, contacts, location, identity | Mass-scale breach + GDPR + churn; privacy IS the product (see Wickr) |
| **E-commerce / marketplace** | Orders, payment, balances, take-rate | Price/race/refund fraud + PCI + checkout-trust churn |
| **Gaming / media / deep-tech** | Accounts, virtual goods, source/IP, anti-cheat | Account/asset theft economy + IP exfil + competitive loss |
| **Gov / defense / critical infra** | Classified/citizen data, control systems | Authorization-to-operate loss + national-security + statutory penalties |

---

## Worked examples (finding → loss → severity)

**1. IDOR exposing patient records at a health-tech SaaS.** Crown jewel = PHI. Lens B: numeric `id` enumerable → mass automated pull, cross-tenant, scales. Lens A: is there server-side authz / rate limiting? Assume none proven. Loss model: 50k records × ~$400/record (health band) breach cost + HIPAA settlement (6–7 fig) + enterprise-customer churn + breach notification. → **Critical**; "cost of inaction = multi-million + HIPAA; fix = add an ownership check on one endpoint."

**2. Checkout race condition applying a coupon N times at an e-commerce site.** Crown jewel = revenue/margin. Lens B: single-packet race, automatable, direct money. Lens A: per-order cap? max discount? Loss = avg order value × discount × abuse volume × time-to-detect (direct, undisputable fraud) + IR. Usually **High** (Medium if discount is capped/whitelisted — write-only IDOR-style cap rule). Lead with the clean fraud arithmetic.

**3. Unauthenticated pre-login config endpoint leaking feature flags + internal IDs (the Wickr-style case).** Crown jewel = private messaging trust, but this data is client-shipped, by-design bootstrap config; IDs proven NOT reusable (all sibling endpoints 401). Lens B: recon value only, no boundary crossed. Lens A: by-design, defense-in-depth holds, program pays $0. Loss ≈ negligible. → **Informational**. This is the discipline: a scary-sounding asset (a secure messenger) does NOT make a near-zero-loss finding valuable. Match the company's own verdict, not the brand's reputation.

---

## Anti-inflation rules (keep the triager trusting you)

- **No proof, no loss.** Tie every dollar to a reproduced fact. Theoretical impact goes in its own clearly-labelled section.
- **State every assumption** (record count, ARPU, abuse rate, regime, scale). Numbers without assumptions are noise.
- **Don't double-count** breach cost + fine + churn + IR for the same 1,000 records as if they were four separate breaches.
- **Subtract existing defenses.** If MFA, short token TTL, encryption, or server-side re-validation blunts the attack, the realistic figure drops — say so before the triager does.
- **Honor the bounty table and exclusions.** A high CVSS on an explicitly-excluded/by-design issue is still a $0 bounty; report it honestly.
- **Worst-case ≠ realistic-case.** Always give both, lead with realistic, and name the preconditions that bridge them.
- **Brand ≠ severity.** A famous, security-marketed target does not raise the loss of a low-impact bug. Score the finding, not the logo.
