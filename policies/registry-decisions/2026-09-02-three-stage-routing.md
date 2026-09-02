# Registry Decision Note — 2026-09-02 three-stage capability routing

Template: [`templates/REGISTRY_DECISION_NOTE_TEMPLATE.md`](../../templates/REGISTRY_DECISION_NOTE_TEMPLATE.md)
Registry: [`policies/MODEL_REGISTRY.yaml`](../MODEL_REGISTRY.yaml) — `0.4 -> 0.5`
Routing policy: [`policies/MODEL_ROUTING_POLICY.md`](../MODEL_ROUTING_POLICY.md) — `0.3 -> 0.5`
Evidence: [`references/MODEL_EVIDENCE.md`](../../references/MODEL_EVIDENCE.md)
Supersedes nothing; builds on [`2026-09-02-rebalance-implementer-tiers.md`](2026-09-02-rebalance-implementer-tiers.md).

```yaml
note_id: RDN-2026-09-02-02
written_at: "2026-09-02"
written_by: operational-router (Claude Code session, on human instruction)
registry_version_before: "0.4"
registry_version_after: "0.5"
change_type: [add_stage_layer, reorder, tier_change, status_change, reasoning_default_change]

evidence_sample_size: 0            # for the forced parts
external_evidence_ids: [E3, E4, E7, E8]
local_smoke_cases: E5 (Luna only), E6 (Gemini partial - 4 of ~8 checks)
regressions_observed: none run under the new mapping

approved_by:               # BLANK — human approval pending
reviewer:                  # BLANK — independent reviewer not assigned
reviewer_verdict:          # BLANK
effective_date:            # BLANK until approved + reviewed
next_revalidation_due: "2026-10-02"
```

## Why

The `CHEAP < DEFAULT < STRONG < DEEP` ladder let task **risk / importance /
production-relatedness** be conflated with **model capability**, which pushed
Sol (the strongest Codex model) into far too many routes. The fix is a
capability **stage** that only capability difficulty can raise.

## What changed

### PART A — three-stage model (additive, no schema break)

- New `stages:` block in the registry partitions the four tiers:
  `STAGE_1_DEFAULT = {CHEAP, DEFAULT}`, `STAGE_2_ADVANCED = {STRONG}`,
  `STAGE_3_FLAGSHIP = {DEEP}`. `capability_tier_order` is unchanged.
- Every slot and candidate gained a `stage:` field that the checker verifies
  against its `minimum_tier` / `capability_tier`. Legacy `minimum_tier`-only
  contracts map deterministically (CHEAP/DEFAULT -> Stage 1, STRONG -> Stage 2,
  DEEP -> Stage 3), so no v0.3 contract breaks.

### PART B/C — risk separated from capability; stage admission

`MODEL_ROUTING_POLICY.md` now states the hard invariant
`Risk does not equal capability requirement` and an executable `admitStage()`:
Stage 1 is the default; Stage 2 needs an advanced signal (high complexity /
ambiguity, structural change, architecture reasoning, security *semantics*,
adversarial verification, or a failed Stage 1); Stage 3 needs exceptional
evidence (Stage 2 failed to converge, reviewer deadlock, irreversible +
materially ambiguous, adversarial security, exceptional execution, or explicit
human authorization). Risk, production-relatedness and test volume are never
inputs. 11 `stage_admission` conformance cases pin this, including the three
negative proofs (`high_risk_alone`, `production_but_mechanically_simple`,
`test_volume_is_not_a_stage_input`).

### PART D — target mapping (slot names kept)

| Slot | stage | candidates (ordered) | default reasoning |
|---|---|---|---|
| ROUTER | 1 | luna, AUTO_GEMINI* | max / low |
| CHEAP_GENERALIST | 1 | luna, AUTO_GEMINI* | low / low |
| DEFAULT_IMPLEMENTER | 1 | luna, AUTO_GEMINI* | max / low |
| STRONG_IMPLEMENTER | 2 | terra, sonnet, AUTO_GEMINI* | high / high / high |
| DEEP_REASONER | 2 | sonnet, terra, AUTO_GEMINI* | high / high / high |
| LONG_CONTEXT_DISCOVERY | 1 | AUTO_GEMINI*, sonnet | low / provider_default |
| INDEPENDENT_REVIEWER | 1..2 | AUTO_GEMINI*, luna, sonnet, terra | low / medium / high / high |
| REGRESSION_HUNTER | 1 | AUTO_GEMINI*, luna | low / medium |
| ESCALATION_MODEL | 3 | sol, opus | medium / medium |

`*` = `status: experimental` (see PART G). Sol and Opus appear **only** in
`ESCALATION_MODEL`. `capability_tier` changes: sonnet `DEEP -> STRONG`
(it is a Stage 2 peer); terra stays `STRONG` (from 0.4). Sol stays `DEEP` but
its **default reasoning is lowered from the 0.4 forced value to `medium`** and
is never defaulted to `max`. Opus default reasoning `provider_default -> medium`.

### PART E — role vs stage in the selection algorithm

`selectCandidate()` gained a stage gate as ordering layer 2 (a candidate must
meet the required stage, and a STAGE_3 candidate is admitted only when the
required stage IS STAGE_3) and a `rolePreference` tie-break as layer 9 (after
conservation and burst opportunity, before registry order). `INDEPENDENT_REVIEWER`
no longer implies any stage; the caller passes `requiredStage`.

### PART F — reviewer disjointness unchanged

Provider AND model-family disjointness stays a hard filter above resource
optimisation. 4 new disjointness cases, including
`reviewer_shares_model_family_through_another_provider_is_excluded` and
`reviewer_disjointness_survives_a_stranded_quota_pull`.

### PART I — flagship frequency guard

Any `kind: selection` case that selects a `STAGE_3_FLAGSHIP` slot must carry
`flagship_reason.escalation_reason` + `.why_stage_2_insufficient` or the
checker rejects it. The contract template gained a `flagship_admission` block.

### PART J/K/L — reasoning-exact dispatch + attestation

`reasoning_effort` is declared part of the execution identity.
`checkReasoningDispatch()` + 5 `reasoning_dispatch` cases enforce: a Codex
launch command missing explicit `-m` / `model_reasoning_effort` is
`INVALID_DISPATCH`; observed model matching but effort differing is
`DISPATCH_CONTRACT_MISMATCH` (the Company Platform incident); explicit dispatch
effort wins over local config. `OFFICIAL_COMMANDS.md` documents the two Orca
dispatch paths (`worker-start --model/--effort` vs existing-terminal + inject),
the per-provider reasoning mechanisms (Codex `-c model_reasoning_effort`,
Claude `--effort`, `agy --effort` / effort-in-id), and the attestation
capability gap (only `/status` is a verified read; `worker-show` is
unverified). `WORKFLOW_POLICY.md` gained the `DISPATCH_CONTRACT_MISMATCH`
lifecycle outcome and its safe handling (never `ROUTING_UNAVAILABLE`, never
pretend a match).

## PART G — Gemini qualification result: INCOMPLETE

`antigravity / AUTO_GEMINI` is **returned to `status: experimental`** across all
slots, reversing the 0.4 forced promotion. The smallest-appropriate local
qualification (E6) passed 4 checks (resolver returns
`gemini-3.7-flash-{low,medium,high}`; low-reasoning path works; identity
resolves as `Gemini`/`Google` for disjointness; output formatting stable) but
**could not complete** the read-only reviewer / repo-discovery /
permission-compliance checks: `agy` headless mode fail-closes on any tool
needing the `command` permission. Blocker and the two ways to clear it are in
`MODEL_EVIDENCE.md` E6. Gemini routes only under `allow_experimental: true`
until this is resolved. This is deliberate: "do not fake stability".

## What this evidence cannot show

- **Zero smoke cases** back Terra as a stable Stage 2 implementer or Sol at
  DEEP. E3/E7/E8 are model-only benchmark journalism, not "CLI + harness +
  permissions + model".
- `admitStage()` is a deterministic encoding of the Markdown admission rules,
  not a validated predictor of real task difficulty. It will mis-stage tasks
  whose difficulty is not captured by the six dimensions + the signal flags.
- The reasoning-attestation path is best-effort only; no non-interactive Orca
  surface reports a worker's actual reasoning effort.

## Rollback condition

Revert `MODEL_REGISTRY.yaml` and `MODEL_ROUTING_POLICY.md` to `0.4` / `0.3`
(recoverable from git history) if any of:

- **Stage mis-routing**: two consecutive tasks that a human judges Stage 1 are
  routed to a Stage 2/3 slot by `admitStage()`, or vice-versa. -> tighten or
  loosen the admission predicate; do not widen `selectCandidate`'s stage gate.
- **Terra**: two consecutive `STRONG_IMPLEMENTER` dispatches to terra end with
  `failed_repair_count >= 2`. -> restore sol as `STRONG_IMPLEMENTER` head,
  return terra to `experimental`.
- **Flagship over-use returns**: `ESCALATION_MODEL` is selected for a task with
  no valid Stage 3 admission reason (the checker should already block this; if
  it slips through in practice). -> audit the admission path.
- **Reasoning drift**: a dispatched worker is observed running at an effort the
  contract did not specify, twice, despite an explicit command. -> the
  attestation step is not sufficient; escalate the Orca upstream request.

rollback_owner:            # BLANK — assign with approval

## Open follow-ups

1. 3-5 local smoke cases per forced candidate (Terra, Sol) -> E5.
2. Clear the `agy` headless permission blocker (E6) and finish Gemini
   qualification for the reviewer / discovery roles.
3. Assign a disjoint reviewer for this note and record a verdict before
   `effective_date`.
4. Verify `codex` accepts `model_reasoning_effort="max"` for `gpt-5.6-luna` on
   the target host via `--dry-run` or post-dispatch `/status`, or downgrade the
   Luna default to `high`.
5. Push the pack so the web strategic router can read the updated policies.
