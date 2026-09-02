# Registry Decision Note — 2026-09-02 implementer-tier rebalance

Template: [`templates/REGISTRY_DECISION_NOTE_TEMPLATE.md`](../../templates/REGISTRY_DECISION_NOTE_TEMPLATE.md)
Registry: [`policies/MODEL_REGISTRY.yaml`](../MODEL_REGISTRY.yaml)
Routing policy: [`policies/MODEL_ROUTING_POLICY.md`](../MODEL_ROUTING_POLICY.md)
Evidence basket: [`references/MODEL_EVIDENCE.md`](../../references/MODEL_EVIDENCE.md)

This is one coordinated change touching several candidates, so the per-candidate
template is folded into one note with a move table. Every row is a
`MODEL_REGISTRY.yaml` mapping/tier/status change and nothing else — no stable
Markdown policy was edited.

```yaml
note_id: RDN-2026-09-02-01
written_at: "2026-09-02"
written_by: operational-router (Claude Code session, on human instruction)
registry_version_before: "0.3"
registry_version_after: "0.4"
change_type: [remove_candidate, add_candidate, reorder, status_change, tier_change]
slots_touched:
  - DEFAULT_IMPLEMENTER
  - STRONG_IMPLEMENTER
  - DEEP_REASONER
  - LONG_CONTEXT_DISCOVERY
  - INDEPENDENT_REVIEWER
  - REGRESSION_HUNTER
  - ESCALATION_MODEL

evidence_sample_size: 0            # zero comparable runs for the forced changes
benchmark_record_ids: []
external_evidence_ids: [E3, E4]    # see references/MODEL_EVIDENCE.md
local_smoke_cases_passed:
  gpt-5.6-luna:  1   # T2S1, 2026-09-01, at medium effort (not max)
  gpt-5.6-terra: 0
  gpt-5.6-sol:   0
  AUTO_GEMINI (antigravity, gemini): 0
regressions_observed: none checked — no runs were made under the new mapping

approved_by:               # BLANK — human approval pending
approval_recorded_at:      # BLANK
reviewer:                  # BLANK — independent reviewer not yet assigned
reviewer_provider:         # BLANK
reviewer_verdict:          # BLANK
reviewer_conditions:       # BLANK
effective_date:            # BLANK until approved + reviewed
next_revalidation_due: "2026-10-02"
```

## What changed

| # | Slot | Candidate | Before | After | change_type |
|---|---|---|---|---|---|
| 1 | DEFAULT_IMPLEMENTER | `codex / gpt-5.6-luna` | reasoning `medium`, tier `DEFAULT`, `stable` | reasoning **`max`**, tier `DEFAULT`, `stable` | reorder-into-sole-head + reasoning bump |
| 2 | DEFAULT_IMPLEMENTER | `codex / gpt-5.6-sol` | candidate #2, tier `STRONG` | **removed from this slot** | remove_candidate |
| 3 | DEFAULT_IMPLEMENTER | `antigravity / AUTO_GEMINI` (gemini) | not present | **added #2**, reasoning `high`, tier `STRONG`, `stable` | add_candidate + status_change |
| 4 | STRONG_IMPLEMENTER | `codex / gpt-5.6-sol` | candidate #1, tier `STRONG`, `stable` | **removed from this slot** | remove_candidate |
| 5 | STRONG_IMPLEMENTER | `codex / gpt-5.6-terra` | (was DEEP_REASONER #2) reasoning `high`, tier `DEEP`, **`experimental`** | **moved here as #1**, reasoning `high`, tier **`STRONG`**, **`stable`** | reorder + tier_change (DEEP→STRONG) + status_change (experimental→stable) |
| 6 | STRONG_IMPLEMENTER | `claude / sonnet` | reasoning `provider_default`, tier `DEEP`, `stable` | reasoning **`high`**, tier `DEEP`, `stable` | reasoning bump |
| 7 | DEEP_REASONER | `codex / gpt-5.6-terra` | candidate #2 | **removed** (moved to STRONG_IMPLEMENTER, row 5) | remove_candidate |
| 8 | DEEP_REASONER | `codex / gpt-5.6-sol` | not present | **added #2**, reasoning `high`, tier **`DEEP`**, `stable` | add_candidate + tier_change (STRONG→DEEP) |
| 9 | DEEP_REASONER | `claude / sonnet` | reasoning `provider_default` | reasoning **`high`** | reasoning bump |
| 10 | LONG_CONTEXT_DISCOVERY | `antigravity / AUTO_GEMINI` | reasoning `medium`, **`experimental`** | reasoning **`high`**, **`stable`** | status_change |
| 11 | INDEPENDENT_REVIEWER | `antigravity / AUTO_GEMINI` | reasoning `medium`, **`experimental`** | reasoning **`high`**, **`stable`** | status_change |
| 12 | INDEPENDENT_REVIEWER | `codex / gpt-5.6-sol` | tier `STRONG` | tier **`DEEP`** (aligned with row 8), reasoning `high` | tier_change |
| 13 | REGRESSION_HUNTER | `antigravity / AUTO_GEMINI` | reasoning `medium`, **`experimental`** | reasoning **`high`**, **`stable`** | status_change |
| 14 | ESCALATION_MODEL | `codex / gpt-5.6-sol` | not present | **added #2**, reasoning `high`, tier `DEEP`, `stable` | add_candidate |

Net picture of the ladder after this change:

```
CHEAP_GENERALIST       luna (low)
DEFAULT_IMPLEMENTER     luna (max)          -> gemini flash 3.7 (high)
STRONG_IMPLEMENTER      terra (high)        -> sonnet 5 (high)
DEEP_REASONER           sonnet 5 (high)     -> sol (high)
ESCALATION_MODEL        opus 5              -> sol (high)
LONG_CONTEXT_DISCOVERY  gemini flash 3.7 (high) -> sonnet 5
INDEPENDENT_REVIEWER    gemini flash 3.7 (high) -> sonnet 5 -> sol
REGRESSION_HUNTER       gemini flash 3.7 (high) -> luna
```

## Rationale

- **Sol does not belong on the default path.** External evidence E3
  (Terminal-Bench 2.1 aggregate) reports GPT-5.6 Sol as the strongest Codex
  model at high effort. Pairing it with `luna` inside `DEFAULT_IMPLEMENTER`
  meant the slot's two candidates sat two tiers apart and the resource overlay
  could swing routine bounded work onto the most expensive Codex model. Sol is
  now reachable only through `DEEP_REASONER` and `ESCALATION_MODEL` — "genuinely
  hard work only", per the instruction.
- **Terra is the structural implementer.** It was previously the Codex entry in
  `DEEP_REASONER` but never exercised. Moving it to `STRONG_IMPLEMENTER` opposite
  `sonnet 5 (high)` gives that slot a real cross-provider pair for structural
  repair / migration work, and keeps the deep-reasoning slot for `sonnet` +
  `sol`.
- **Gemini was carrying almost no load.** It appeared only in three slots and
  only as `experimental`, so with `allow_experimental` defaulting to `false` it
  was never actually selected. It is now the first choice in
  `LONG_CONTEXT_DISCOVERY`, `INDEPENDENT_REVIEWER` and `REGRESSION_HUNTER`, and a
  second bounded-implementation option in `DEFAULT_IMPLEMENTER`. E4 (AA-LCR)
  supports the long-context role; the `agy models` resolver was re-checked
  2026-09-02 and returns `gemini-3.7-flash-high`.
- **`luna` reasoning `max`** as the sole `DEFAULT_IMPLEMENTER` head: instructed,
  to give bounded default work the most headroom that model has now that it has
  no STRONG stablemate to escalate to inside the slot.
- **`sonnet` pinned to `high`** wherever it sits in a STRONG-or-deeper slot, so
  its effort is explicit rather than provider-default.

## What this evidence cannot show

- **Zero local smoke cases** back the forced promotions. `terra`, `sol` at DEEP,
  and `antigravity/AUTO_GEMINI` at `stable` have never been dispatched through
  this pack's contract and permission ceiling. E3 and E4 measure bare models on
  benchmarks, not "CLI + harness + model + permission" as
  [`references/MODEL_EVIDENCE.md`](../../references/MODEL_EVIDENCE.md) states.
- E3 is a **second-hand aggregator**; its primary Terminal-Bench leaderboard URL
  is still an open action in the evidence basket.
- Nothing here speaks to `terra`'s or `sol`'s **failure modes under ambiguity**,
  their sandbox-flag compliance, or their repair-count behaviour.
- `gemini flash 3.7`'s **review catch rate** as an independent reviewer is
  untested; its long-context benchmark score does not imply it catches
  regressions in a diff.
- The candidates keep `evidence_status: provisional` and low/medium `confidence`
  precisely because `status: stable` here is a routing decision, not an evidence
  conclusion.

## Rollback condition

Revert row-by-row to registry `0.3` (the pre-change mapping, recoverable from
git history of [`policies/MODEL_REGISTRY.yaml`](../MODEL_REGISTRY.yaml)) if any of:

- **terra**: two consecutive `STRONG_IMPLEMENTER` dispatches to
  `codex / gpt-5.6-terra` end with `failed_repair_count >= 2`, or any dispatch
  produces an unrequested structural change outside the contract's allowed-changes
  list. → put `sol` back as `STRONG_IMPLEMENTER` head, return `terra` to
  `experimental`.
- **sol at DEEP**: a `DEEP_REASONER` dispatch to `sol` is escalated to
  `ESCALATION_MODEL` for capability reasons (not resource) twice. → return `sol`
  to `STRONG`.
- **gemini flash 3.7**: two consecutive `INDEPENDENT_REVIEWER` runs miss a
  regression that the paired `sonnet` reviewer or the diff's own tests then catch,
  or a `DEFAULT_IMPLEMENTER` dispatch to it needs `>= 2` repairs. → return the
  antigravity Gemini entries to `experimental`.
- **luna max**: two consecutive bounded `DEFAULT_IMPLEMENTER` runs show
  `repair_count >= 2` or a quota-efficiency regression versus the `medium`
  baseline (T2S1: 30040 tokens). → return reasoning to `medium`.

rollback_owner:            # BLANK — assign with approval

## Open follow-ups

1. Run the 3–5 local smoke cases per forced candidate
   ([`references/MODEL_EVIDENCE.md`](../../references/MODEL_EVIDENCE.md) rules) and
   record them in evidence basket E5.
2. Rewrite the `tests/routing-cases.yaml` fixtures that pin
   `STRONG_IMPLEMENTER -> codex / gpt-5.6-sol` (see the failing-case list handed
   over with this change) to the new slot model.
3. Assign an independent reviewer (disjoint from the change author) and record a
   verdict before `effective_date` is filled in.
4. Confirm `codex` accepts `model_reasoning_effort="max"` for `gpt-5.6-luna` on
   the target host, or downgrade row 1 to `high`.
