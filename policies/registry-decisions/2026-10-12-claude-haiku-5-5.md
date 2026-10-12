# 2026-10-12 — Claude Haiku 5.5: alias update, then Stage 1 quota relief (registry 0.8)

Two steps on the same day:

1. Documentation only (commit 1ea9559, registry stayed 0.7): the `haiku`
   alias now resolves to Haiku 5.5.
2. Human decision (operator, 2026-10-12): add Haiku 5.5 as a Stage 1
   quota-relief candidate placed **after Gemini** (registry 0.8).

## Changes in 0.8

`claude / haiku / medium`, `capability_tier: DEFAULT`, `stage: STAGE_1_DEFAULT`,
`model_family: claude-haiku`, appended after the Gemini candidate in:

| Slot | Before (0.7) | After (0.8) |
|---|---|---|
| CHEAP_GENERALIST | Luna max → Gemini low | Luna max → Gemini low → **Haiku medium** |
| DEFAULT_IMPLEMENTER | Luna max → Gemini low | Luna max → Gemini low → **Haiku medium** (last resort) |
| LONG_CONTEXT_DISCOVERY | Gemini low → Sonnet (Stage 2) | Gemini low → **Haiku medium** → Sonnet (Stage 2) |
| INDEPENDENT_REVIEWER | Gemini low → Luna max → Sonnet high → Sol low | Gemini low → Luna max → **Haiku medium** → Sonnet high → Sol low |
| REGRESSION_HUNTER | Gemini low → Luna max | Gemini low → Luna max → **Haiku medium** |

Not added to ROUTER (the control plane stays on Luna / Gemini), or to any
Stage 2 / Stage 3 slot.

- Effort `medium`, not `max`: Haiku 5.5 at max effort uses far more output
  tokens (about 3x GPT-6 Luna per task in third-party measurement).
- Haiku shares the `claude` resource pool with Sonnet 5.5 (Stage 2) and
  Opus 5.5 (Stage 3). Putting it after Gemini means Claude quota is spent on
  Stage 1 work only when Gemini cannot take it. The existing defensive
  resource signals (conservation / burst depletion / pace) still demote it
  when the Claude pool is short.

### Routing-case changes

- `reviewer_disjointness_survives_a_stranded_quota_pull` and
  `router_reserve_never_weakens_reviewer_disjointness`: with Codex excluded
  by disjointness and Gemini not selected, the reviewer is now Stage 1 Haiku
  instead of Stage 2 Sonnet. Disjointness is unchanged (provider `claude`).
- `router_reserve_exhausting_every_alternative_blocks_rather_than_burns_reserve`:
  now disables both `AUTO_GEMINI` and `haiku`, so it still tests "no valid
  alternative → BLOCKED".
- New: `router_reserve_on_codex_hands_stage1_work_to_haiku` (Codex at
  reserve, Gemini unavailable → Haiku) and
  `router_reserve_on_codex_prefers_gemini_before_haiku` (Codex at reserve,
  Gemini healthy → Gemini).

## Evidence

- Local probe, Claude Code 2.1.296: `claude -p --model haiku --output-format json`
  reported `claude-haiku-5-5` in `modelUsage` (`contextWindow` 1000000,
  `maxOutputTokens` 128000, `provider` firstParty). No local smoke case yet
  (evidence limitation, not a gate).
- Anthropic announcement (2026-10-07), https://www.anthropic.com/claude-haiku-5-5:
  first Haiku with adjustable effort (low…max), adaptive thinking on by
  default. Pricing per 1M tokens: $0.10 input / $0.50 output for ≤100k input,
  and $0.50 / $2.50 above 100k. Benchmarks vs Haiku 4.5: OSWorld 2.1 72.4% vs
  15.7%, Terminal-Bench 4.0 39.2% vs 0.0%. Positioned for summaries,
  compaction, classification, coding subagents, browser/computer use.
- Third-party reviews (informational): eesel.ai, MindStudio, DataCamp,
  BenchLM.
  - Roughly 86–88% of Sonnet 5.5 on knowledge work and computer use, but
    Terminal-Bench 4.0 39.2% vs Sonnet 5.5 70.6%.
  - Artificial Analysis Intelligence Index 43, about 5 points above GPT-6
    Luna. There is no head-to-head coding benchmark with Luna; comparisons
    are directional.
  - The new tokenizer counts about 25–30% more tokens, so real savings vs
    Haiku 4.5 are about 75%, not 90%.
  - API breaking changes: `temperature: 0` and assistant prefill return
    errors. Some reviewers saw over-refusal in early tests.
  - Hands-on: found a real logic bug in a multi-tier app, but was weaker than
    Sonnet on long autonomous builds.

## Rollback

Remove the five `claude / haiku` candidates, restore the three edited routing
cases, delete the two new ones, and set `version` back to `"0.7"`. To also
undo step 1, set `haiku.display` back to `"Haiku 4.5"`.
