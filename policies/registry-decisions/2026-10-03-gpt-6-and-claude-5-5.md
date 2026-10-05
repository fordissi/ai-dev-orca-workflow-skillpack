# 2026-10-03 — GPT-6 Luna/Sol, Terra removal, Luna-first Stage 2, Claude 5.5 (registry 0.7)

Human decision (operator, 2026-10-03): move Codex to the GPT-6 generation,
remove Terra, and give Terra's work to GPT-6 Sol. Claude aliases now resolve
to the 5.5 generation.

## Changes

| Slot | Before (0.6) | After (0.7) |
|---|---|---|
| ROUTER | `codex / gpt-5.6-luna / max` | `codex / gpt-6-luna / max` |
| CHEAP_GENERALIST | `codex / gpt-5.6-luna / low` | `codex / gpt-6-luna / max` |
| DEFAULT_IMPLEMENTER | `codex / gpt-5.6-luna / max` | `codex / gpt-6-luna / max` |
| STRONG_IMPLEMENTER | `codex / gpt-5.6-terra / high` (STRONG) | **head:** `codex / gpt-6-luna / max` (STRONG, Stage 2); then `codex / gpt-6-sol / low` (STRONG, Stage 2) |
| DEEP_REASONER | `codex / gpt-5.6-terra / high` (STRONG) | `codex / gpt-6-sol / low` (STRONG, Stage 2) |
| INDEPENDENT_REVIEWER | `codex / gpt-5.6-luna / medium`, `codex / gpt-5.6-terra / high` | `codex / gpt-6-luna / max`, `codex / gpt-6-sol / low` |
| REGRESSION_HUNTER | `codex / gpt-5.6-luna / medium` | `codex / gpt-6-luna / max` |
| ESCALATION_MODEL | `codex / gpt-5.6-sol / medium` (DEEP) | `codex / gpt-6-sol / medium` (DEEP, Stage 3) |

- `model_family` for every Codex candidate: `gpt-5.6` → `gpt-6`.
- Stage and tier are unchanged in every existing position. The former Terra
  positions run Sol at `low` (human decision: Sol needs less effort than
  Terra did at `high`).
- Luna: every Luna candidate runs at `max` (human decision: Luna is cheap),
  and Luna max is added as the HEAD of STRONG_IMPLEMENTER so Stage 2
  implementation goes to Luna first.
- New routing rule: when Stage 2 is admitted because a Stage 1 attempt
  failed, the exact model that failed is excluded via
  `selectCandidate(..., { excludeFailedModels: ["provider/model"] })`, so a
  failed Luna Stage 1 attempt falls through to Sol / Sonnet instead of
  re-running Luna. Covered by two routing cases.
- Claude: `claude_models.catalog_aliases` keep the same aliases; display
  `Sonnet 5` → `Sonnet 5.5`, `Opus 5` → `Opus 5.5`.

## Consequence: Sol now appears at two stages

`gpt-6-sol` is a Stage 2 / STRONG / `low` candidate (former Terra slots) and
a Stage 3 / DEEP / `medium` flagship candidate (ESCALATION_MODEL). The stage
gate and flagship admission are per slot, so this does not let Stage 2 work
into a flagship slot, and the flagship guard still applies to
ESCALATION_MODEL. Reviewer disjointness is unaffected: provider `codex` is
still excluded for any Codex implementer.

## Evidence (informational)

- codex-cli 0.156.1: `~/.codex/models_cache.json` lists `gpt-6-luna`,
  `gpt-6-sol` (also `gpt-6-astra`, not adopted). `codex exec -m gpt-6-luna`
  and `-m gpt-6-sol` with `model_reasoning_effort="low"` launched and the
  banner reported the requested model.
- Claude Code 2.1.288: `claude -p --model sonnet --output-format json`
  reported `claude-sonnet-5-5` in `modelUsage`; `--model opus` reported
  `claude-opus-5-5`. Haiku not re-probed.
- Not yet re-probed: Orca `worker-start --agent codex --model gpt-6-*`
  (the 2026-09-24 live probe used `gpt-5.6-luna`).

## Rollback

Restore 0.6 `policies/MODEL_REGISTRY.yaml` from git history.
