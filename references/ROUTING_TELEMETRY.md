# Routing Telemetry (optional, local, advisory)

Status: reference. Normative resource-routing semantics live in
[`../policies/RESOURCE_AWARE_ROUTING.md`](../policies/RESOURCE_AWARE_ROUTING.md).

This describes an **optional** local telemetry layer that lets future routing
decisions be evaluated against real operational history instead of anecdotal
quota observations. It is not required to run the workflow, and nothing in the
pack depends on it.

## Concerns stay separate

```text
Skillpack policy   = normative governance and routing semantics
Project handoff    = durable semantic project/task state
Orca runtime       = live execution / control-plane state
RESOURCE_STATE     = current resource snapshot / cache (never a history)
Telemetry (this)   = historical operational evidence, advisory only
```

Telemetry never becomes a second source of truth and never a project-state
system. `RESOURCE_STATE` stays a current snapshot; telemetry is where the
*history* lives when a runtime chooses to keep it.

## Opt-in by directory presence

Telemetry is **off** unless the directory `runtime/telemetry/` exists. It is
gitignored (`runtime/telemetry/`), append-only, and local to one machine. A
runtime that supports it writes newline-delimited JSON:

```text
runtime/telemetry/routing-events.jsonl     one line per routing decision
runtime/telemetry/capacity-snapshots.jsonl one line per resource observation
runtime/telemetry/handoff-events.jsonl     one line per handoff / recovery
```

Removing the directory disables it with no other change.

## Goal A - routing audit

Answers "which provider was selected, why, did a handoff happen, which
resource signal moved the ranking". Derived labels are sufficient; **no raw
ratios**.

`routing-events.jsonl` fields:

```yaml
timestamp:                 # ISO
project:                   # already-non-sensitive project id, or null
task_id:
workflow_stage:            # classify | route | contract | dispatch | review | ...
slot:                      # ROUTER | DEFAULT_IMPLEMENTER | ...
selected_provider:
selected_model_family:
routing_reason:            # short label
conservation_pressure:     # NONE..CRITICAL | UNKNOWN
burst_depletion_pressure:  # NONE..HIGH | UNKNOWN
pace_pressure:             # NONE..CRITICAL | UNKNOWN
pace_confidence:           # HIGH | MEDIUM | UNKNOWN
pace_reason:               # WEEKLY_OVERBURN | PROJECTED_EARLY_EXHAUSTION | null
resource_pressure_rank:    # CLEAR | SOFT_PRESSURED | BUDGET_SCARCE
router_reserve_band:       # NORMAL | ROUTER_RESERVE | ... | UNKNOWN
continuation:              # true | false
handoff:                   # true | false
handoff_reason:            # short label | null
result:                    # PASS | RETRYABLE | HUMAN_GATE | BLOCKED | null
failure_class:             # label | null
duration_s:                # integer seconds, coarse
```

## Goal B - PACE calibration

Answers "was a threshold too aggressive, how fast was quota actually consumed,
did projected exhaustion predict real exhaustion". This needs quantitative
history, but **not exact percentages**.

`capacity-snapshots.jsonl` fields:

```yaml
checked_at:                # ISO
provider:
resource_state_key:
window_role:               # BURST | BUDGET
remaining_bucket:          # one decile label: "0.0-0.1" .. "0.9-1.0"
reset_at:                  # ISO | null
reset_at_source:           # RELATIVE_PROVIDER_DURATION | absolute | null
generation_key:            # see below
```

`remaining_ratio` is stored only as a **decile bucket**, never the exact
value. That is enough to estimate a burn slope and detect a generation change
without becoming a precise account ledger.

### generation_key

`generation_key` is a **locally derived** correlation id, NOT authoritative
provider metadata. Suggested derivation:

```text
generation_key = hash(provider + "/" + resource_state_key + "/" +
                      round(reset_at to the nearest hour))
```

For a `reset_at_source: RELATIVE_PROVIDER_DURATION` window, round the *implied
remaining duration at checked_at* rather than the drifting absolute `reset_at`.
Confidence limits: two snapshots sharing a `generation_key` are only
*probably* the same generation; an upward jump in `remaining_bucket`, a
`reset_at` shift beyond the rounding tolerance, or a crossed reset boundary
breaks the correlation. This mirrors the generation-continuity rules in
`RESOURCE_AWARE_ROUTING.md`.

## Never store

Prompts, source code, diffs, credentials, tokens, auth headers, provider raw
quota payloads, personal data, employee/user data, secrets, exact provider
account identifiers, or exact `remaining_ratio` values.

## Advisory only - no self-tuning

Routing **never** reads telemetry synchronously and **never** edits its own
thresholds from it. The only supported loop is:

```text
telemetry -> offline / operator-reviewed analysis -> proposed config change
          -> human review -> versioned policy / PACE_EVIDENCE update
```

The thresholds for burst depletion, pace pressure, projection safety margin,
observation spacing and generation-continuity tolerance stay explicit,
versioned and operator-controlled (see `PACE_EVIDENCE` in
`scripts/validate-policy-pack.mjs`, overridable via the `paceConfig` option).

## Retrospective questions this enables

- How many tasks were routed to each provider, and which stages consume each?
- How often did Codex BURST or trajectory reach HIGH / CRITICAL pressure?
- How often did provider capacity cause a handoff, and how often did work
  actually stop because no eligible capacity existed?
- Did an eligible provider stay materially underused while another repeatedly
  hit its short-window limit?
- How often did the projected exhaustion match the real exhaustion, i.e. was
  `pace_pressure` too aggressive or too conservative?
- How many provider switches occurred, and how often was repository discovery
  repeated after a handoff?

Token-exact accounting is out of scope unless a provider exposes authoritative
usage data; prefer observable routing / runtime metrics.
