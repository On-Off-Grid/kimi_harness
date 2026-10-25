# pi-hunt — Operator Docs

> [!IMPORTANT]
> Current runtime: Kimi Code. Flagship `kimi-coding/k3`, elite `kimi-coding/k3.1-pro`,
> mechanical `google-direct/gemini-3.1-flash-lite`, compaction `kimi-coding/k3-256k`.
> Kiro gateway material is legacy/reference-only.

Practical guides for running and maintaining pi-hunt. Read in order.

1. **[01-health-analysis.md](01-health-analysis.md)** — Historical Kiro health snapshot and diagnostic notes;
   do not use its gateway checks as the current runbook; the current health check is
   `make prompts-check`. It still documents the known silent-failure modes and where
   every credential lives. Start here on a cold session.

2. **[02-optimal-usage-guide.md](02-optimal-usage-guide.md)** — How to run a hunt,
   steer it mid-flight, and drive each phase. Trigger grammar, the seven phases with
   per-phase prompts + commands, mid-work steering moves, tuning knobs, RAG recall.

3. **[03-current-state-and-roadmap.md](03-current-state-and-roadmap.md)** — Historical
   host snapshot with the current Kimi/Google migration status and roadmap.

---

Quick start:
```bash
pi-hunt
> Hunt <program> in <HackerOne|Intigriti> for <CRITICAL|HIGH|CRITICAL/EXCEPTIONAL>
```
Health check: confirm `kimi-coding` / `k3` (and `google-direct/gemini-3.1-flash-lite`
for mechanical agents) in `~/.pi/agent/{models,settings}.json`; the gateway sweep is
historical only.
Everything writes to `reports/<program>/...`; pi-hunt never submits to a platform.
