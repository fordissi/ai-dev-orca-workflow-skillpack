/**
 * Weekly Balance — consume a weekly (BUDGET) allowance evenly over its cycle by
 * comparing remaining_ratio with time_remaining_ratio. Ranking-only: it never
 * blocks a provider and never crosses a hard gate.
 *
 * RESOURCE_AWARE_ROUTING.md "Weekly Balance" owns the semantics.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveWeeklyBalance,
  selectCandidate,
  WEEKLY_BALANCE,
} from "../scripts/validate-policy-pack.mjs";

const NOW = Date.parse("2026-09-10T00:00:00.000Z");
const H = 3_600_000;
const D = 24 * H;

const iso = (ms) => new Date(ms).toISOString();

// A resource-state entry with one weekly BUDGET window (and optionally a 5h
// BURST window). window_minutes defaults to a 7-day nominal horizon.
function entry({ state = "GREEN", remaining, resetInMs, windowDays = 7, burst, burstResetInMs } = {}) {
  const windows = [
    {
      role: "BUDGET",
      remaining_ratio: remaining,
      window_minutes: windowDays * 24 * 60,
      reset_at: resetInMs === null ? null : iso(NOW + resetInMs),
    },
  ];
  if (burst !== undefined) {
    windows.push({
      role: "BURST",
      remaining_ratio: burst,
      window_minutes: 300,
      reset_at: iso(NOW + (burstResetInMs ?? 5 * H)),
    });
  }
  return { checked_at: iso(NOW - 60_000), available: true, state, source: "ORCA_RUNTIME", windows };
}

const TIER_ORDER = ["CHEAP", "DEFAULT", "STRONG", "DEEP"];
const cand = (provider, model = `${provider}-model`, key = provider) => ({
  provider,
  resource_state_key: key,
  model,
  model_family: model,
  reasoning: "medium",
  capability_tier: "DEFAULT",
  status: "stable",
});
// Codex is the registry-order head; gemini is the peer.
const SLOT = {
  role: "IMPLEMENTATION",
  minimum_tier: "DEFAULT",
  max_repair_attempts: 2,
  candidates: [cand("codex"), cand("gemini")],
};
const pick = (states, options = {}) => selectCandidate(SLOT, states, TIER_ORDER, { now: NOW, ...options });

/* ---------------------------------------------------------------- *
 * The core balance model (Section 14, Cases A / B / C + reserve)
 * ---------------------------------------------------------------- */

test("Case A — 1 day to reset, 40% left → BOOST (aggressively prefer)", () => {
  const wb = resolveWeeklyBalance(entry({ remaining: 0.4, resetInMs: 1 * D }), { now: NOW });
  assert.equal(wb.state, "BOOST");
  assert.ok(wb.budget_surplus > 0.2);
});

test("Case B — 6 days to reset, 60% left → STRONG_CONSERVE (over-consuming)", () => {
  const wb = resolveWeeklyBalance(entry({ remaining: 0.6, resetInMs: 6 * D }), { now: NOW });
  assert.equal(wb.state, "STRONG_CONSERVE");
  assert.ok(wb.budget_surplus <= -0.2);
});

test("Case C — remaining ≈ time remaining → NORMAL (healthy trajectory)", () => {
  // 3 of 7 days left => time_remaining_ratio ≈ 0.4286; match it.
  const wb = resolveWeeklyBalance(entry({ remaining: 3 / 7, resetInMs: 3 * D }), { now: NOW });
  assert.equal(wb.state, "NORMAL");
  assert.ok(Math.abs(wb.budget_surplus) < 0.05);
});

test("band boundaries are deterministic and monotonic", () => {
  // reset 3d, window 7d => time_remaining_ratio = 3/7; remaining = 3/7 + surplus
  // (a 1e-3 offset keeps the assertion clear of float noise at the thresholds).
  const at = (surplus) =>
    resolveWeeklyBalance(entry({ remaining: 3 / 7 + surplus, resetInMs: 3 * D }), { now: NOW }).state;
  assert.equal(at(0.201), "BOOST");
  assert.equal(at(0.199), "PREFER");
  assert.equal(at(0.051), "PREFER");
  assert.equal(at(0.049), "NORMAL");
  assert.equal(at(0), "NORMAL");
  assert.equal(at(-0.049), "NORMAL");
  assert.equal(at(-0.051), "CONSERVE");
  assert.equal(at(-0.199), "CONSERVE");
  assert.equal(at(-0.201), "STRONG_CONSERVE");
});

/* ---------------------------------------------------------------- *
 * Reserve floor (Section 5, Case H)
 * ---------------------------------------------------------------- */

test("Case H — 3h to reset but only 4% left → CRITICAL_RESERVE, not BOOST", () => {
  const wb = resolveWeeklyBalance(entry({ remaining: 0.04, resetInMs: 3 * H }), { now: NOW });
  assert.equal(wb.state, "CRITICAL_RESERVE");
  assert.equal(wb.reason, "RESERVE_FLOOR");
});

test("remaining below 0.15 → RESERVE; RESERVE alone (reset near, conservation not HIGH) demotes to SOFT_PRESSURED", () => {
  // reset in 3h softens conservation_pressure to LOW, so the demotion here is
  // attributable to the Weekly Balance reserve floor, not BUDGET scarcity.
  const codex = entry({ remaining: 0.12, resetInMs: 3 * H });
  assert.equal(resolveWeeklyBalance(codex, { now: NOW }).state, "RESERVE");
  const result = pick({ codex, gemini: entry({ remaining: 0.9, resetInMs: 4 * D }) });
  assert.equal(result.status, "SELECTED");
  assert.equal(result.candidate.provider, "gemini");
  assert.equal(result.conservation_demotion, null); // not BUDGET-scarce
  assert.equal(result.weekly_balance_demotion.over, "codex/codex-model");
  assert.equal(result.weekly_balance_demotion.weekly_balance_state, "RESERVE");
});

/* ---------------------------------------------------------------- *
 * Expiry corrections (Section 6)
 * ---------------------------------------------------------------- */

test("near reset with room left is boosted even from the PREFER band (EXPIRY_BOOST)", () => {
  // surplus ≈ +0.17 → PREFER band; reset 8h ≤ 12h and remaining 0.22 ≥ 0.20 → BOOST.
  const wb = resolveWeeklyBalance(entry({ remaining: 0.22, resetInMs: 8 * H }), { now: NOW });
  assert.equal(wb.state, "BOOST");
  assert.equal(wb.reason, "EXPIRY_BOOST");
});

test("EXPIRY_PREFER lifts a sub-PREFER band to PREFER within 24h of reset", () => {
  // surplus ≈ +0.12: reset 20h from now, remaining chosen so remaining - 20h/7d ≈ 0.12.
  const e = entry({ remaining: 0.12 + 20 / (7 * 24), resetInMs: 20 * H });
  // With prefer_surplus raised to 0.20 the base band is NORMAL; disabling the
  // expiry window (expiry_prefer_hours: 0) keeps it NORMAL...
  assert.equal(
    resolveWeeklyBalance(e, { now: NOW, weeklyBalanceConfig: { prefer_surplus: 0.2, expiry_prefer_hours: 0 } }).state,
    "NORMAL",
  );
  // ...and re-enabling it lifts NORMAL -> PREFER because reset ≤ 24h and surplus ≥ 0.10.
  const wb = resolveWeeklyBalance(e, { now: NOW, weeklyBalanceConfig: { prefer_surplus: 0.2 } });
  assert.equal(wb.state, "PREFER");
  assert.equal(wb.reason, "EXPIRY_PREFER");
});

/* ---------------------------------------------------------------- *
 * Hysteresis (Section 11, Cases D / E)
 * ---------------------------------------------------------------- */

test("Case D — a tiny balance gap does not reorder", () => {
  const result = pick({
    codex: entry({ remaining: 3 / 7 + 0.02, resetInMs: 3 * D }), // +0.02 NORMAL
    gemini: entry({ remaining: 3 / 7 + 0.07, resetInMs: 3 * D }), // +0.07 PREFER, gap 0.05 < 0.10
  });
  assert.equal(result.candidate.provider, "codex"); // registry order preserved
  assert.equal(result.weekly_balance_promotion, null);
});

test("Case E — a meaningful imbalance reorders eligible candidates", () => {
  const result = pick({
    codex: entry({ remaining: 3 / 7 - 0.12, resetInMs: 3 * D }), // -0.12 CONSERVE
    gemini: entry({ remaining: 3 / 7 + 0.08, resetInMs: 3 * D }), // +0.08 PREFER, gap 0.20 ≥ 0.10
  });
  assert.equal(result.candidate.provider, "gemini");
  assert.equal(result.weekly_balance_promotion.over, "codex/codex-model");
  assert.equal(result.weekly_balance_promotion.weekly_balance_state, "PREFER");
});

/* ---------------------------------------------------------------- *
 * Scenario A / B end-to-end product requirement
 * ---------------------------------------------------------------- */

test("Scenario A — 1d/>40% ⇒ actively consume: a BOOST peer outranks a worse-balance head", () => {
  const result = pick({
    codex: entry({ remaining: 3 / 7 - 0.05, resetInMs: 3 * D }), // ≈ NORMAL/CONSERVE head
    gemini: entry({ remaining: 0.4, resetInMs: 1 * D }), // BOOST (surplus ≈ +0.26)
  });
  assert.equal(result.candidate.provider, "gemini");
  assert.equal(result.weekly_balance.state, "BOOST");
  assert.equal(result.weekly_balance_promotion.over, "codex/codex-model");
});

test("Scenario B — 6d/60% ⇒ conserve: head demoted, healthy eligible peer preferred for new work", () => {
  const result = pick({
    codex: entry({ remaining: 0.6, resetInMs: 6 * D }), // STRONG_CONSERVE
    gemini: entry({ remaining: 0.85, resetInMs: 6 * D }), // NORMAL-ish, CLEAR
  });
  assert.equal(result.candidate.provider, "gemini");
  assert.equal(result.resource_pressure_rank, "CLEAR");
  assert.equal(result.weekly_balance_demotion.over, "codex/codex-model");
  assert.equal(result.weekly_balance_demotion.weekly_balance_state, "STRONG_CONSERVE");
  // codex is demoted, never blocked
  assert.ok(SLOT.candidates.some((c) => c.provider === "codex"));
});

/* ---------------------------------------------------------------- *
 * BURST interaction (Section 8, Cases F / G)
 * ---------------------------------------------------------------- */

test("Case F — weekly BOOST but 5h BURST depleted with a far reset → BURST demotion wins", () => {
  const codex = entry({ remaining: 0.5, resetInMs: 1 * D, burst: 0.03, burstResetInMs: 4 * H });
  const result = pick({ codex, gemini: entry({ remaining: 0.9, resetInMs: 4 * D }) });
  assert.equal(result.candidate.provider, "gemini");
  assert.equal(result.burst_depletion_demotion.over, "codex/codex-model");
  // weekly did NOT rescue codex across the burst-depletion demotion
  assert.equal(result.weekly_balance_promotion, null);
});

test("Case G — weekly BOOST and 5h BURST reset imminent → weekly BOOST stays effective", () => {
  const codex = entry({ remaining: 0.5, resetInMs: 1 * D, burst: 0.03, burstResetInMs: 20 * 60_000 });
  const worseGemini = entry({ remaining: 3 / 7 - 0.05, resetInMs: 3 * D });
  const result = pick({ codex, gemini: worseGemini });
  assert.equal(result.candidate.provider, "codex"); // near-reset burst → no HIGH depletion
  assert.equal(result.burst_depletion_demotion, null);
});

/* ---------------------------------------------------------------- *
 * PACE coexistence (Section 9)
 * ---------------------------------------------------------------- */

test("PACE still demotes when weekly balance is only NORMAL; weekly balance is not required", () => {
  const t0 = NOW - 2 * H;
  const paced = {
    ...entry({ remaining: 3 / 7, resetInMs: 5 * D }), // weekly NORMAL
    pace_observations: [
      { checked_at: iso(t0), remaining_ratio: 0.6, reset_at: iso(NOW + 5 * D) },
      { checked_at: iso(t0 + H), remaining_ratio: 0.4, reset_at: iso(NOW + 5 * D) },
      { checked_at: iso(t0 + 2 * H), remaining_ratio: 0.2, reset_at: iso(NOW + 5 * D) },
    ],
  };
  const result = pick({ codex: paced, gemini: entry({ remaining: 0.9, resetInMs: 5 * D }) });
  assert.equal(result.candidate.provider, "gemini");
  assert.equal(result.pace_demotion.over, "codex/codex-model");
});

/* ---------------------------------------------------------------- *
 * Hard-gate invariants (Section 15)
 * ---------------------------------------------------------------- */

test("exact pin counterfixture — a STRONG_CONSERVE pin is still selected, not reordered", () => {
  const result = pick(
    { codex: entry({ remaining: 0.6, resetInMs: 6 * D }), gemini: entry({ remaining: 0.9, resetInMs: 6 * D }) },
    { pinnedCandidate: { provider: "codex", model: "codex-model" } },
  );
  assert.equal(result.status, "SELECTED");
  assert.equal(result.candidate.provider, "codex");
  assert.equal(result.pinned, true);
  assert.equal(result.weekly_balance_promotion, null);
  assert.equal(result.weekly_balance_demotion, null);
  assert.equal(result.weekly_balance.state, "STRONG_CONSERVE"); // reported for audit
});

test("reviewer-disjoint counterfixture — weekly BOOST does not defeat provider exclusion", () => {
  const result = pick(
    { codex: entry({ remaining: 0.4, resetInMs: 1 * D }), gemini: entry({ remaining: 3 / 7 - 0.05, resetInMs: 3 * D }) },
    { excludeProvider: "codex" }, // codex has the BOOST but is excluded
  );
  assert.equal(result.status, "SELECTED");
  assert.notEqual(result.candidate.provider, "codex");
});

test("minimum tier / stage are untouched by weekly balance", () => {
  const strong = { ...SLOT, minimum_tier: "STRONG", candidates: [cand("codex"), cand("gemini")] };
  // both candidates are DEFAULT tier → below STRONG → blocked regardless of a great weekly balance
  const result = selectCandidate(strong, { codex: entry({ remaining: 0.4, resetInMs: 1 * D }) }, TIER_ORDER, { now: NOW });
  assert.equal(result.status, "BLOCKED");
});

/* ---------------------------------------------------------------- *
 * UNKNOWN neutrality (Section 16)
 * ---------------------------------------------------------------- */

test("missing window_minutes / reset_at / stale evidence → weekly_balance UNKNOWN and neutral", () => {
  const noWindowMinutes = { checked_at: iso(NOW - 60_000), available: true, state: "GREEN", source: "ORCA_RUNTIME", windows: [{ role: "BUDGET", remaining_ratio: 0.4, reset_at: iso(NOW + 1 * D) }] };
  assert.equal(resolveWeeklyBalance(noWindowMinutes, { now: NOW }).state, "UNKNOWN");

  const noReset = entry({ remaining: 0.4, resetInMs: null });
  assert.equal(resolveWeeklyBalance(noReset, { now: NOW }).state, "UNKNOWN");

  const stale = { ...entry({ remaining: 0.4, resetInMs: 1 * D }), checked_at: iso(NOW - 30 * 60_000) };
  assert.equal(resolveWeeklyBalance(stale, { now: NOW }).state, "UNKNOWN");

  // Neutral: registry order preserved when the head's balance is UNKNOWN.
  const result = pick({ codex: noWindowMinutes, gemini: entry({ remaining: 0.9, resetInMs: 1 * D }) });
  assert.equal(result.candidate.provider, "codex");
  assert.equal(result.weekly_balance_promotion, null);
});

test("thresholds are operator-configurable (no self-tuning) — and default config is frozen", () => {
  assert.equal(Object.isFrozen(WEEKLY_BALANCE), true);
  const e = entry({ remaining: 0.4, resetInMs: 1 * D });
  assert.equal(resolveWeeklyBalance(e, { now: NOW }).state, "BOOST");
  // raise the boost threshold so the same surplus is only PREFER
  assert.equal(resolveWeeklyBalance(e, { now: NOW, weeklyBalanceConfig: { boost_surplus: 0.9 } }).state, "PREFER");
});
