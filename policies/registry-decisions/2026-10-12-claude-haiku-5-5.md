# 2026-10-12 — Claude `haiku` alias now resolves to Haiku 5.5 (registry 0.7, no slot change)

Documentation and evidence update only. No slot, stage, tier or candidate
changed; `version` stays `"0.7"`.

## Changes

- `resolvers.claude_models.catalog_aliases.haiku.display`: `Haiku 4.5` →
  `Haiku 5.5`; `claude_models.verified_at` → `2026-10-12`.
- `references/OFFICIAL_COMMANDS.md`: new "Haiku 5.5 使用建議" subsection.
- `policies/RESOURCE_AWARE_ROUTING.md`: runtime adapter table display name.

## Evidence

- Local probe, Claude Code 2.1.296: `claude -p --model haiku --output-format json`
  reported `claude-haiku-5-5` in `modelUsage` (`contextWindow` 1000000,
  `maxOutputTokens` 128000, `provider` firstParty).
- Anthropic announcement (2026-10-07), https://www.anthropic.com/claude-haiku-5-5:
  first Haiku with adjustable effort (low…max), adaptive thinking on by
  default. Pricing per 1M tokens: $0.10 input / $0.50 output for ≤100k input,
  and $0.50 / $2.50 above 100k. Benchmarks vs Haiku 4.5: OSWorld 2.1 72.4% vs
  15.7%, Terminal-Bench 4.0 39.2% vs 0.0%. Positioned for summaries,
  compaction, classification, coding subagents, browser/computer use.
- Third-party reviews (informational): eesel.ai, MindStudio, DataCamp.
  - Roughly 86–88% of Sonnet 5.5 on knowledge work and computer use, but
    Terminal-Bench 4.0 39.2% vs Sonnet 5.5 70.6%.
  - The new tokenizer counts about 25–30% more tokens, so real savings vs
    Haiku 4.5 are about 75%, not 90%. Effort `max` uses a lot of output tokens.
  - API breaking changes: `temperature: 0` and assistant prefill return
    errors. Some reviewers saw over-refusal in early tests.
  - Hands-on: found a real logic bug in a multi-tier app, but was weaker than
    Sonnet on long autonomous builds.

## Proposal (NOT adopted — needs a human decision)

Haiku 5.5 is cheaper than Sonnet and is built to be driven by an orchestrator.
It could be added as a non-head CHEAP candidate for read-only, bounded work,
for example `LONG_CONTEXT_DISCOVERY` (only while each request stays under 100k
input) or `CHEAP_GENERALIST` after `gpt-6-luna`. It should not be added to
STRONG_IMPLEMENTER, DEEP_REASONER or ESCALATION_MODEL. No change is made here,
because slot membership is human-authoritative
(2026-09-02-user-authoritative-registry.md).

## Rollback

Set `haiku.display` back to `"Haiku 4.5"` and remove the OFFICIAL_COMMANDS
subsection.
