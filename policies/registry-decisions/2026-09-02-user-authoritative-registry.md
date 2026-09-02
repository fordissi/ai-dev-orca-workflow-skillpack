# Registry Decision Note — 2026-09-02 registry authority correction

Template: [`templates/REGISTRY_DECISION_NOTE_TEMPLATE.md`](../../templates/REGISTRY_DECISION_NOTE_TEMPLATE.md)
Registry: [`policies/MODEL_REGISTRY.yaml`](../MODEL_REGISTRY.yaml) — `0.5 -> 0.6`
Routing policy: [`policies/MODEL_ROUTING_POLICY.md`](../MODEL_ROUTING_POLICY.md) — `0.5 -> 0.6`
Evidence: [`references/MODEL_EVIDENCE.md`](../../references/MODEL_EVIDENCE.md) — `0.3 -> 0.4`
Builds on [`2026-09-02-three-stage-routing.md`](2026-09-02-three-stage-routing.md) and
[`2026-09-02-rebalance-implementer-tiers.md`](2026-09-02-rebalance-implementer-tiers.md); preserves both.

```yaml
note_id: RDN-2026-09-02-03
written_at: "2026-09-02"
written_by: operational-router (Claude Code session, on human instruction)
registry_version_before: "0.5"
registry_version_after: "0.6"
change_type: [authority_model_change, schema_add, semantic_correction]

approved_by:               # BLANK — human approval pending
reviewer:                  # BLANK
reviewer_verdict:          # BLANK
effective_date:            # BLANK until approved + reviewed
next_revalidation_due: "2026-10-02"
```

## Statement of change

`Registry authority changed from evidence-gated AI eligibility to
human-authoritative configuration.`

Before 0.6, `status: experimental` + `allow_experimental: false` (the default)
made a user-listed model **unroutable**, so the operator's Gemini choice sat
inert behind an AI qualification verdict. That is the wrong authority model.

## What changed

### Schema (additive, backward compatible)

- Every candidate gained `enabled: true`. `enabled: false` is the operator
  saying "do not route here" and is now the **only** config gate.
- A candidate with **no** `enabled` field is treated as enabled (legacy
  contracts and registries keep working).
- `status` / `evidence_status` / `confidence` / `source` are now explicitly
  **informational** and never gate routing.

### `selectCandidate()`

- The `status === "experimental" && !allowExperimental` exclusion is **removed**.
- New exclusion: `candidate.enabled === false`.
- `allowExperimental` is still accepted (backward compat) and is inert for
  registry-enabled candidates.
- New option `pinnedCandidate: {provider, model}` — an explicit human model
  selection. If the pinned model is in the slot and clears hard execution
  eligibility (enabled, stage, tier, disjointness, availability, source trust)
  it is returned directly, bypassing quota / conservation / opportunity /
  role-preference ordering. If it is not in the slot -> `CONFIG_INVALID`; if it
  is rejected -> that candidate's own honest blocked code (`ROUTING_UNAVAILABLE`
  for availability, `POLICY_BLOCKED` for disjointness or `enabled: false`).

### `MODEL_ROUTING_POLICY.md` (0.6)

- New hard invariant: *Registry membership and enabled status are
  human-authoritative configuration, not an AI-generated capability verdict.*
- New *Routing precedence (overall)* — 10 layers, top: explicit human model
  pin, then hard runtime/execution eligibility, then the existing stage /
  role / permission / disjointness / resource algorithm. **Evidence /
  benchmark are not in the chain.**
- New *Hard execution eligibility* list — the only grounds on which the AI may
  refuse a user-enabled model.
- New *Human explicit model selection* section — pin precedence and its four
  honest failure modes.
- *Execution failure vs task-quality failure* — a first-attempt mistake or a
  missed review finding runs the normal `failed_repair_count` / escalation
  path and never disables a model or edits the registry.
- `allow_experimental` redefined as backward-compat-only with no routing effect
  on enabled candidates.

### `MODEL_EVIDENCE.md` (0.4)

Reframed as observational only: `Evidence informs the human; it does not
override human registry configuration.` `evidence_status: provisional`,
incomplete smoke cases and benchmark scores are stated to have no routing
effect.

### Contract / return templates

`human_model_directive` (strategic contract) and `selection_mode:
human_pinned | autonomous` (operational resolution) added; `allow_experimental`
annotated as compat-only.

## Gemini effect (PART R)

`antigravity / AUTO_GEMINI` stays `status: experimental` (E6 qualification is
genuinely incomplete — informational) but is `enabled: true` everywhere it is
listed. It is now selectable by autonomous quota routing and by an explicit
human pin. The E6 headless-permission blocker is a **runtime capability limit
for specific task shapes** (headless read-only reviewer / discovery), not
global model ineligibility — model eligibility is evaluated per execution task,
and a dispatch that genuinely cannot run returns an honest blocked outcome at
that point.

## Terra effect (PART S)

`codex / gpt-5.6-terra` stays `status: stable` and `enabled: true`. Zero local
smoke cases is recorded as an evidence limitation, **not** a reason to exclude
it. Its rollback condition (2 consecutive `STRONG_IMPLEMENTER` dispatches with
`failed_repair_count >= 2`) is unchanged from the 0.5 note.

## What this does NOT change (PART U)

Three-stage architecture, stage admission criteria, risk != capability,
flagship guard, reasoning-exact dispatch, dispatch attestation, continuation
freshness, session lifecycle, permission model, reviewer disjointness, and the
hierarchical quota windows are all untouched. Reviewer disjointness in
particular still overrides a human pin.

## What this evidence cannot show

- `admitStage()` and `enabled`-based eligibility are policy encodings, not
  validated predictors of good outcomes.
- Making Gemini and Terra routable without completing qualification means the
  first real dispatches to them are also the first evidence — the observations
  belong in `MODEL_EVIDENCE.md` E5/E6, not in a silent registry edit.

## Rollback condition

Revert `MODEL_REGISTRY.yaml` and `MODEL_ROUTING_POLICY.md` to `0.5` (git
history) if:

- Removing the `experimental` gate causes an enabled-but-genuinely-broken model
  to be dispatched repeatedly with no honest execution-eligibility failure
  raised (i.e. hard eligibility checks are too weak) — tighten the eligibility
  checks, do not restore the evidence gate.
- The `pinnedCandidate` path is observed bypassing a check it must not bypass
  (stage, disjointness, `enabled: false`) — fix the bypass; the pin must clear
  every hard-eligibility gate.

rollback_owner:            # BLANK — assign with approval

## Validation

`npm test` 101/101, `npm run validate` passes, `git diff --check` clean.
84 routing cases (15 new for user-authoritative registry + pin precedence);
2 new engine unit tests (legacy-no-enabled default, pin outranks quota not
eligibility).

## Open follow-ups

1. Assign a disjoint reviewer for this note; record a verdict before
   `effective_date`.
2. First dispatches to Gemini / Terra: capture the observations into E5/E6.
3. Confirm `codex` accepts `model_reasoning_effort="max"` for `gpt-5.6-luna`
   (carried over from the 0.5 note).
