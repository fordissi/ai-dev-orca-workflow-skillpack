# 2026-10-03 — GPT-6 Luna/Sol, Terra removal, Claude 5.5 (registry 0.7)

Human decision (operator, 2026-10-03): move Codex to the GPT-6 generation,
remove Terra, and give Terra's work to GPT-6 Sol. Claude aliases now resolve
to the 5.5 generation.

## Changes

| Slot | Before (0.6) | After (0.7) |
|---|---|---|
| ROUTER | `codex / gpt-5.6-luna / max` | `codex / gpt-6-luna / max` |
| CHEAP_GENERALIST | `codex / gpt-5.6-luna / low` | `codex / gpt-6-luna / low` |
| DEFAULT_IMPLEMENTER | `codex / gpt-5.6-luna / max` | `codex / gpt-6-luna / max` |
| STRONG_IMPLEMENTER | `codex / gpt-5.6-terra / high` (STRONG) | `codex / gpt-6-sol / low` (STRONG, Stage 2) |
| DEEP_REASONER | `codex / gpt-5.6-terra / high` (STRONG) | `codex / gpt-6-sol / low` (STRONG, Stage 2) |
| INDEPENDENT_REVIEWER | `codex / gpt-5.6-luna / medium`, `codex / gpt-5.6-terra / high` | `codex / gpt-6-luna / medium`, `codex / gpt-6-sol / low` |
| REGRESSION_HUNTER | `codex / gpt-5.6-luna / medium` | `codex / gpt-6-luna / medium` |
| ESCALATION_MODEL | `codex / gpt-5.6-sol / medium` (DEEP) | `codex / gpt-6-sol / medium` (DEEP, Stage 3) |

- `model_family` for every Codex candidate: `gpt-5.6` → `gpt-6`.
- Candidate order, stage and tier are unchanged in every slot. Reasoning is
  unchanged except in the former Terra positions: Sol runs there at `low`
  (human decision: Sol needs less effort than Terra did at `high`).
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
