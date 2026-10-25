---
name: chain-metrics
description: "Chain metrics hook (OPT-IN via `CHAIN_METRICS=1`; inert by default). Load when testing this class or chaining a finding toward higher impact."
---

This hook only WRITES one JSON line for measurement. It NEVER changes analysis,
routing, disconfirmation, negative-control logic, triage, or report formats. If
`CHAIN_METRICS` is unset or not `1`, skip this section entirely.

When a wave finishes and BEFORE final triage/writeup, if `echo "$CHAIN_METRICS"`
== `1`, append exactly one compact JSON line to
`reports/<program>/chain-metrics.json` (append mode — never truncate; old runs
are preserved; create the file + parent dir if missing). Track these counters
from values you already hold this wave:
- `hunt_id`         : the coordinator-provided hunt/session id (else a stable slug you used for this run).
- `date`            : ISO8601 UTC, e.g. `date -u +%Y-%m-%dT%H:%M:%SZ`.
- `program`         : the confirmed program handle.
- `techniques_count_before`: techniques index size at wave start — read from `pihunt-rag stats` (`by_source.techniques`).
- `techniques_count_after` : same source after any optional local writes this wave (usually unchanged).
- `ledger_residue_count`   : number of ledger primitives appended this wave (the same ledger you read in step 1).
- `chain_hypotheses_generated`: distinct chain hypotheses you produced this wave (increment per hypothesis object created from recall/composition in step 2/4).
- `hypotheses_promoted_to_Tier1`: how many of those `strict-triager` accepted as Tier-1 THIS run (0 if triage hasn't run yet).
- `chains_recorded_via_rag_record_technique`: times you called `rag_record_technique` to store a distilled chain this wave (usually 0).

Write it atomically with one shell append (values filled from your counters):
```bash
[ "$CHAIN_METRICS" = 1 ] && { mkdir -p "reports/$PROGRAM"; printf '%s\n' \
  "{\"hunt_id\":\"$HUNT_ID\",\"date\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"program\":\"$PROGRAM\",\"techniques_count_before\":$TCB,\"techniques_count_after\":$TCA,\"ledger_residue_count\":$LRC,\"chain_hypotheses_generated\":$CHG,\"hypotheses_promoted_to_Tier1\":$HPT,\"chains_recorded_via_rag_record_technique\":$CRR}" \
  >> "reports/$PROGRAM/chain-metrics.json"; }
```
All numeric fields MUST be non-negative integers. This is a side-channel log only.

Rollback: revert this file (`git checkout -- pi-agent/agents/security-analyzer.md`)
and re-copy to `~/.pi/agent/agents/`; to drop data, delete/archive
`reports/<program>/chain-metrics.json`. No DB/RAG changes are involved.
