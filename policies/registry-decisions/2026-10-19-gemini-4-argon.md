# 2026-10-19 — Gemini 4 Argon as a third Stage 3 flagship (registry 0.10)

Human decision (operator, 2026-10-19): add Gemini 4 Argon now, conservatively.

## Change

| Slot | Before (0.9) | After (0.10) |
|---|---|---|
| ESCALATION_MODEL | `codex / gpt-6.1-sol / medium`, `claude / opus / medium` | same, then **`antigravity / gemini-4-argon / medium`** (DEEP, Stage 3, third) |

- New registry field `runtime_adapters.antigravity.model_resource_pools:
  { gemini-4-argon: antigravity.argon }`. The dispatch resolver and the
  registry validator use it so an Argon dispatch is charged to its own pool,
  not `antigravity.gemini`.
- `AUTO_GEMINI` is unchanged: it still resolves to the newest Gemini **Flash**,
  never to Argon.
- No other slot changes. Argon is kept out of implementation, review,
  discovery and regression slots.

## Why only Stage 3

- **Quota:** on Google AI Pro, Argon has its own bucket, separate from Gemini
  Flash/Pro. It is weekly-only (no 5-hour window), so once it is spent it stays
  empty until the weekly reset. Its size is not published. `agy /usage`
  2026-10-19: "For paid Pro plans, Argon quota is separate. Higher Argon quota
  (included as part of the larger Gemini quota bucket) is available on Ultra
  plans."
- **Role:** the only flagship outside Codex and Claude, so it is the natural
  third opinion when qualified Codex and Claude reviewers disagree (a listed
  Stage 3 admission reason).
- **Capability (informational, vendor table only, not reproduced):** Google
  DeepMind's table lists Argon ahead of Opus 5.5 on Vals Index (68.9 vs 67.0)
  and AutomationBench (51.3 vs 42.5), behind Opus 5.5 on Terminal-Bench 4.0
  (57.4 vs 66.4) and behind GPT-6 Astra on FrontierSWE v2 (55.0 vs 65.5).

## Evidence

- `agy models` (live, 2026-10-19): `gemini-4-argon-{low,medium,high}`.
- `agy --print "/usage" --output-format json` (2026-10-19): group
  "Gemini 4 Argon", bucket `gemini-argon-wtu-weekly`, remaining 100%.
- Not yet done: a launch probe through `worker-start --agent antigravity
  --model gemini-4-argon-medium`, and a quota measurement (one representative
  task, read `remaining_fraction` before and after) to estimate tasks per week.

## Revisit

If the quota measurement shows room for more than rare use, consider Argon
for DEEP_REASONER. Roll back by removing the candidate and the
`model_resource_pools` entry.
