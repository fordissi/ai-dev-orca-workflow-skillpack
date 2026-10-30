# 2026-10-30 — GPT-6.1 Terra not adopted; Gemini 4 Carbon on watch (no registry change)

Human decision (operator, 2026-10-30): record both evaluations and leave the
registry at 0.10. No slot, candidate or resolver changes.

## GPT-6.1 Terra — evaluated, not adopted

- Local: codex-cli 0.165.0; `~/.codex/models_cache.json` lists
  `gpt-6.1-terra` ("GPT-6.1 Terra Codex model", effort low…max plus `ultra`,
  default low). Not live-probed.
- Vendor and third-party (launched 2026-10-26/27; secondary sources relaying
  OpenAI material): $1 input / $5 output per 1M tokens, half of GPT-6.1 Sol.
  Terminal-Bench 4.0 50.3% at max (GPT-5.6 Terra 21.5%); one source reports
  Sol at 52.7% already at medium. Artificial Analysis coding-agent index as
  reported: Sol 54, Terra 48, Luna 31. OpenAI positions Terra for computer
  use, visual reasoning and writing, and says Sol and Astra remain the better
  choice for the hardest coding.

Why not adopted:

- **No quota relief.** Terra draws from the same `codex` pool as Luna and Sol.
  It cannot take load off when Codex is short, unlike Haiku or Gemini.
- **No gap to fill.** Luna max covers cheap work and heads Stage 2; Sol low is
  the stronger Stage 2 coder at a probably similar quota cost per task. Terra
  would only ever be reached after Luna fails, where Sol is the better pick.
- **Its strengths have no slot.** The pack has no computer-use or visual slot.

Revisit if: Stage 2 attempts on Sol low fail noticeably more often than
expected and a mid-cost Codex step is wanted, or a computer-use / visual
capability slot is added. Adoption then needs a live `codex exec -m
gpt-6.1-terra` probe and a `worker-start` receipt, like Sol (0.9).

## Gemini 4 Carbon — watch, not yet available

- Announced 2026-10-28. Access is limited to a subset of cyber defenders via
  the Fairwind program; no public API, no plan tiers announced.
- Local 2026-10-30: `agy models` (agy 1.4.9) has no Carbon id; `agy /usage`
  has no Carbon bucket (groups: Gemini Models, Claude and GPT models, Gemini 4
  Argon).
- Reported (secondary): Artificial Analysis Intelligence Index 59 (first);
  coding-agent index 59 in Antigravity CLI vs Claude Code + Opus 5.5 at 62;
  Terminal-Bench about 64–65%. Introductory price $2/$10 per 1M tokens
  (later $4/$20); about $7.76 per index task vs Opus 5.5 max $10.04.
- `AUTO_GEMINI` cannot pick it up by accident: the resolver only matches
  `gemini-<n>-flash` base ids.

Intended use once it is in the agy catalog: Stage 3 only (ESCALATION_MODEL),
most likely replacing Argon as the third, non-Codex/non-Claude flagship. Keep
it out of busy slots until its Pro quota is measured.

Steps when it appears:

1. `agy models` — record the id and effort suffixes.
2. `agy --print "/usage" --output-format json` from PowerShell — find whether
   it has its own bucket or shares Argon's; map it in
   `runtime_adapters.antigravity.model_resource_pools`.
3. One `worker-start --agent antigravity --model gemini-4-carbon-medium`
   probe; check `launch.effective`.
4. Human decision on replacing or joining Argon → registry 0.11.
