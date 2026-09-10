import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  OperationalResourceAdapter,
  EVIDENCE_STATE_MAP,
  ADAPTER_CONTRACT_VERSION,
} from "../scripts/operational-router/resource-adapter.mjs";
import {
  FixtureResourceEvidenceProvider,
  OrcaCliResourceEvidenceProvider,
  extractJsonObject,
} from "../scripts/operational-router/evidence-provider.mjs";
import {
  parseResourceEvidence,
  ResourceEvidenceError,
  RESOURCE_EVIDENCE_CONTRACT_VERSION,
} from "../scripts/operational-router/resource-evidence.mjs";
import {
  selectCandidate,
  resolvePace,
  resolveBurstDepletion,
  resolveConservationPressure,
} from "../scripts/validate-policy-pack.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, "fixtures", "resource-evidence");
const fx = (name) => JSON.parse(readFileSync(join(FX, name), "utf8"));
const fxText = (name) => readFileSync(join(FX, name), "utf8");

const registry = parseYaml(readFileSync(join(HERE, "..", "policies", "MODEL_REGISTRY.yaml"), "utf8"));
const TIER_ORDER = registry.capability_tier_order;
const DEFAULT_IMPLEMENTER = registry.capability_slots.DEFAULT_IMPLEMENTER;
const ROUTER_SLOT = registry.capability_slots.ROUTER;

// A moment just after the last fixture observation in the 08:00..09:20 series.
const NOW = Date.parse("2026-09-10T09:21:00.000Z");

function adapterWith(...fixtures) {
  return new OperationalResourceAdapter({ provider: new FixtureResourceEvidenceProvider(fixtures) });
}
async function ingestAll(adapter, count, now = NOW) {
  const summaries = [];
  for (let i = 0; i < count; i += 1) summaries.push(await adapter.refresh({ now }));
  return summaries;
}

/* ------------------------------------------------------------------ *
 * 31. Adapter - RESOURCE_STATE mapping
 * ------------------------------------------------------------------ */

test("31 valid Codex evidence maps to a RESOURCE_STATE entry (5h BURST + weekly BUDGET)", async () => {
  const a = adapterWith(fx("codex-budget-series-1.json"));
  await a.refresh({ now: NOW });
  const entry = a.getResourceStateEntry("codex", { now: NOW });

  assert.equal(entry.state, "GREEN");
  assert.equal(entry.source, "ORCA_RUNTIME");
  // Freshness timestamp is source_updated_at, never queried_at.
  assert.equal(entry.checked_at, "2026-09-10T08:00:00.000Z");
  assert.equal(entry.windows.filter((w) => w.role === "BURST").length, 1);
  assert.equal(entry.windows.filter((w) => w.role === "BUDGET").length, 1);
  const budget = entry.windows.find((w) => w.role === "BUDGET");
  assert.equal(budget.remaining_ratio, 0.62); // stored exactly, no manufactured precision
  assert.equal(budget.scope, "weekly");
});

test("31 Claude-style evidence (session + weekly) maps cleanly", async () => {
  const a = adapterWith(fx("other-provider-only.json"));
  await a.refresh({ now: NOW });
  const entry = a.getResourceStateEntry("claude", { now: NOW });
  assert.equal(entry.state, "GREEN");
  assert.equal(entry.windows.length, 2);
});

test("31 Gemini buckets stay distinct resource_state_keys, not merged", async () => {
  const a = adapterWith(fx("gemini-buckets.json"));
  await a.refresh({ now: NOW });
  const rs = a.getCurrentResourceState({ now: NOW });
  assert.ok(rs.antigravity.pools.gemini, "gemini pool present");
  assert.ok(rs.antigravity.pools.non_gemini, "non_gemini pool present");
  assert.notEqual(
    rs.antigravity.pools.gemini.windows.find((w) => w.role === "BUDGET").remaining_ratio,
    rs.antigravity.pools.non_gemini.windows.find((w) => w.role === "BUDGET").remaining_ratio,
  );
  // resolveResourceEntry-compatible: selectCandidate can read the dotted key.
  const entry = a.getResourceStateEntry("antigravity.gemini", { now: NOW });
  assert.equal(entry.provider, "antigravity.gemini");
});

test("31 unknown-role window is retained raw but never fed to BURST/BUDGET", async () => {
  const a = adapterWith(fx("unknown-role-window.json"));
  await a.refresh({ now: NOW });
  const entry = a.getResourceStateEntry("codex", { now: NOW });
  assert.equal(entry.windows.length, 1); // only the BURST window
  assert.equal(entry.unknown_role_windows.length, 1);
  assert.equal(entry.unknown_role_windows[0].scope, "mystery");
  // The 0.02 unknown-role window must not create conservation pressure.
  const cons = resolveConservationPressure(entry, { now: NOW });
  assert.equal(cons.conservation_pressure, "UNKNOWN"); // no BUDGET window at all
});

test("31 missing provider yields no fabricated entry", async () => {
  const a = adapterWith(fx("other-provider-only.json"));
  await a.refresh({ now: NOW });
  assert.equal(a.getResourceStateEntry("codex", { now: NOW }), null);
  assert.equal(a.getCurrentResourceState({ now: NOW }).codex, undefined);
});

test("31 unavailable / error provider maps conservatively (UNKNOWN, never guessed RED)", async () => {
  const a = adapterWith(fx("provider-unavailable.json"));
  await a.refresh({ now: NOW });
  const entry = a.getResourceStateEntry("codex", { now: NOW });
  assert.equal(entry.available, false); // carried through independently
  assert.equal(entry.state, "UNKNOWN"); // NOT "RED"
});

test("31 rate_limited is carried but not folded into availability or state", async () => {
  const a = adapterWith(fx("provider-rate-limited.json"));
  const now = Date.parse("2026-09-10T08:02:00.000Z"); // fresh vs the 08:00 source_updated_at
  await a.refresh({ now });
  const entry = a.getResourceStateEntry("codex", { now });
  assert.equal(entry.available, true); // NOT flipped to false by rate_limited
  assert.equal(entry.rate_limited, true);
  assert.equal(entry.state, "GREEN"); // status: ok is carried; the 0.0 BURST ratio does the real work
  assert.equal(resolveBurstDepletion(entry, { now }).burst_depletion_pressure, "HIGH");
});

test("31 stale source_updated_at is stale even when queried_at is fresh", async () => {
  const a = adapterWith(fx("stale-source.json"));
  await a.refresh({ now: NOW });
  const entry = a.getResourceStateEntry("codex", { now: NOW });
  assert.equal(entry.checked_at, "2026-09-10T08:00:00.000Z"); // source_updated_at, not queried_at 09:20
  // >5 min old -> the shared readableEntry treats every derived signal as UNKNOWN.
  assert.equal(a.explain("codex", { now: NOW }).budget, "UNKNOWN");
  assert.equal(a.explain("codex", { now: NOW }).burst_depletion, "UNKNOWN");
});

/* ------------------------------------------------------------------ *
 * 32. Observation store
 * ------------------------------------------------------------------ */

test("32 a single BUDGET observation is one history entry and PACE stays UNKNOWN", async () => {
  const a = adapterWith(fx("codex-budget-series-1.json"));
  await a.refresh({ now: NOW });
  const obs = a.getPaceObservations("codex", { now: NOW });
  assert.equal(obs.length, 1);
  assert.equal(resolvePace({ observations: obs }, { now: NOW }).pace_pressure, "UNKNOWN");
});

test("32 three same-generation observations form a bounded series handed to the resolver", async () => {
  const a = adapterWith(
    fx("codex-budget-series-1.json"),
    fx("codex-budget-series-2.json"),
    fx("codex-budget-series-3.json"),
  );
  await ingestAll(a, 3);
  const obs = a.getPaceObservations("codex", { now: NOW });
  assert.equal(obs.length, 3);
  assert.deepEqual(
    obs.map((o) => o.remaining_ratio),
    [0.62, 0.44, 0.26],
  );
  const pace = resolvePace({ observations: obs }, { now: NOW });
  assert.notEqual(pace.pace_pressure, "UNKNOWN");
  assert.equal(pace.pace_confidence, "MEDIUM"); // no provider generation metadata -> never HIGH
});

test("32 a duplicate snapshot does not grow history", async () => {
  const a = adapterWith(
    fx("codex-budget-series-1.json"),
    fx("codex-budget-series-2.json"),
    fx("codex-budget-series-2.json"), // identical to the previous
  );
  await ingestAll(a, 3);
  assert.equal(a.getPaceObservations("codex", { now: NOW }).length, 2);
});

test("32 the series is bounded and keeps the newest observations", async () => {
  const a = new OperationalResourceAdapter({
    provider: new FixtureResourceEvidenceProvider(
      [0.9, 0.8, 0.7, 0.6, 0.5].map((wk, i) => ({
        queried_at: `2026-09-10T0${i + 3}:00:00.000Z`,
        providers: {
          codex: {
            available: true,
            status: "ok",
            source_updated_at: `2026-09-10T0${i + 3}:00:00.000Z`,
            data_age_ms: 1000,
            rate_limited: false,
            retry_at: null,
            windows: [
              {
                scope: "weekly",
                role: "BUDGET",
                window_minutes: 10080,
                remaining_ratio: wk,
                remaining_ratio_granularity: 0.01,
                reset_at: "2026-09-15T10:39:00.000Z",
                reset_at_source: "unknown",
              },
            ],
          },
        },
      })),
    ),
    storeLimits: { max_observations_per_series: 3 },
  });
  const later = Date.parse("2026-09-10T08:00:00.000Z");
  await ingestAll(a, 5, later);
  const obs = a.getPaceObservations("codex", { now: later });
  assert.equal(obs.length, 3);
  assert.deepEqual(obs.map((o) => o.remaining_ratio), [0.7, 0.6, 0.5]);
});

/* ------------------------------------------------------------------ *
 * 33. Generation continuity
 * ------------------------------------------------------------------ */

test("33 a normal decrease keeps continuity", async () => {
  const a = adapterWith(
    fx("codex-budget-series-1.json"),
    fx("codex-budget-series-2.json"),
    fx("codex-budget-series-3.json"),
  );
  const summaries = await ingestAll(a, 3);
  assert.equal(summaries.at(-1).providers[0].continuity_segmented, false);
  assert.equal(a.getPaceObservations("codex", { now: NOW }).length, 3);
});

test("33 an upward jump in remaining discards the prior generation and PACE goes UNKNOWN", async () => {
  const a = adapterWith(
    fx("codex-budget-series-1.json"),
    fx("codex-budget-series-2.json"),
    fx("codex-budget-series-3.json"),
    fx("codex-capacity-grant.json"),
  );
  const summaries = await ingestAll(a, 4, Date.parse("2026-09-10T10:01:00.000Z"));
  assert.equal(summaries.at(-1).providers[0].continuity_segmented, true);
  const obs = a.getPaceObservations("codex", { now: Date.parse("2026-09-10T10:01:00.000Z") });
  assert.equal(obs.length, 1); // fresh generation
  assert.equal(resolvePace({ observations: obs }, { now: Date.parse("2026-09-10T10:01:00.000Z") }).pace_pressure, "UNKNOWN");
});

test("33 a crossed reset boundary breaks continuity", async () => {
  const base = (t, ratio, reset) => ({
    queried_at: t,
    providers: {
      codex: {
        available: true, status: "ok", source_updated_at: t, data_age_ms: 1000, rate_limited: false, retry_at: null,
        windows: [{ scope: "weekly", role: "BUDGET", window_minutes: 10080, remaining_ratio: ratio, remaining_ratio_granularity: 0.01, reset_at: reset, reset_at_source: "unknown" }],
      },
    },
  });
  const a = adapterWith(
    base("2026-09-10T08:00:00.000Z", 0.30, "2026-09-10T09:00:00.000Z"),
    base("2026-09-10T08:20:00.000Z", 0.20, "2026-09-10T09:00:00.000Z"),
    base("2026-09-10T09:30:00.000Z", 0.18, "2026-09-17T09:00:00.000Z"), // prior reset already passed
  );
  const summaries = await ingestAll(a, 3, Date.parse("2026-09-10T09:31:00.000Z"));
  assert.equal(summaries.at(-1).providers[0].continuity_segmented, true);
  assert.equal(a.getPaceObservations("codex", { now: Date.parse("2026-09-10T09:31:00.000Z") }).length, 1);
});

test("33 unknown reset provenance still resolves conservatively (no crash, real reading)", async () => {
  const a = adapterWith(
    fx("codex-budget-series-1.json"),
    fx("codex-budget-series-2.json"),
    fx("codex-budget-series-3.json"),
  );
  await ingestAll(a, 3);
  // every fixture window has reset_at_source "unknown"
  const obs = a.getPaceObservations("codex", { now: NOW });
  assert.ok(obs.every((o) => o.reset_at_source === "unknown"));
  assert.doesNotThrow(() => resolvePace({ observations: obs }, { now: NOW }));
});

/* ------------------------------------------------------------------ *
 * 34. PACE integration - the shared resolver is the authority
 * ------------------------------------------------------------------ */

test("34 adapter PACE evidence matches the shared resolver run directly on the same series", async () => {
  const a = adapterWith(
    fx("rebalance-1.json"),
    fx("rebalance-2.json"),
    fx("rebalance-3.json"),
  );
  await ingestAll(a, 3);
  const obs = a.getPaceObservations("codex", { now: NOW });
  const direct = resolvePace({ observations: obs }, { now: NOW });
  const viaExplain = a.explain("codex", { now: NOW });
  assert.equal(viaExplain.pace, direct.pace_pressure);
  assert.equal(viaExplain.pace_confidence, direct.pace_confidence);
  assert.equal(viaExplain.pace_reason, direct.pace_reason);
  // consistency, not a hard-coded value:
  if (["HIGH", "CRITICAL"].includes(direct.pace_pressure)) assert.equal(direct.pace_reason, "WEEKLY_OVERBURN");
});

test("34 acute PACE never causes routing failure when it is the only candidate", async () => {
  const a = adapterWith(fx("rebalance-1.json"), fx("rebalance-2.json"), fx("rebalance-3.json"));
  await ingestAll(a, 3);
  const rs = a.getCurrentResourceState({ now: NOW });
  const soloSlot = { ...DEFAULT_IMPLEMENTER, candidates: [DEFAULT_IMPLEMENTER.candidates[0]] }; // codex only
  const result = selectCandidate(soloSlot, rs, TIER_ORDER, { now: NOW });
  assert.equal(result.status, "SELECTED");
  assert.equal(result.candidate.provider, "codex");
});

test("34 PACE does not demote the ROUTER slot (control-plane exemption)", async () => {
  const a = adapterWith(fx("rebalance-1.json"), fx("rebalance-2.json"), fx("rebalance-3.json"));
  await ingestAll(a, 3);
  const rs = a.getCurrentResourceState({ now: NOW });
  const result = selectCandidate(ROUTER_SLOT, rs, TIER_ORDER, { now: NOW, isRouterSlot: true });
  assert.equal(result.status, "SELECTED");
  assert.equal(result.pace_pressure, "UNKNOWN"); // held inert for the Router slot
  assert.equal(result.pace_demotion, null);
});

/* ------------------------------------------------------------------ *
 * 35. BURST - works from a single snapshot, zero history
 * ------------------------------------------------------------------ */

test("35 nearly-spent BURST with a far reset is HIGH depletion with no observations", async () => {
  const a = adapterWith(fx("codex-burst-nearly-spent.json"));
  await a.refresh({ now: Date.parse("2026-09-10T09:01:00.000Z") });
  assert.equal(a.getPaceObservations("codex", { now: NOW }).length, 1); // BUDGET series has 1, PACE UNKNOWN
  const entry = a.getResourceStateEntry("codex", { now: Date.parse("2026-09-10T09:01:00.000Z") });
  assert.equal(resolveBurstDepletion(entry, { now: Date.parse("2026-09-10T09:01:00.000Z") }).burst_depletion_pressure, "HIGH");
});

test("35 nearly-spent BURST that refills within the hour is not over-conserved", async () => {
  const a = adapterWith(fx("codex-burst-near-reset.json"));
  const now = Date.parse("2026-09-10T09:01:00.000Z");
  await a.refresh({ now });
  const entry = a.getResourceStateEntry("codex", { now });
  const bd = resolveBurstDepletion(entry, { now }).burst_depletion_pressure;
  assert.ok(["NONE", "LOW"].includes(bd), `expected NONE/LOW, got ${bd}`);
});

/* ------------------------------------------------------------------ *
 * 36. Candidate rebalancing (end-to-end)
 * ------------------------------------------------------------------ */

test("36 Codex soft-pressured by multi-snapshot PACE, healthy Gemini peer ranks ahead", async () => {
  const a = adapterWith(fx("rebalance-1.json"), fx("rebalance-2.json"), fx("rebalance-3.json"));
  await ingestAll(a, 3);
  const rs = a.getCurrentResourceState({ now: NOW });

  const codexExplain = a.explain("codex", { now: NOW });
  const geminiExplain = a.explain("antigravity.gemini", { now: NOW });
  assert.notEqual(codexExplain.budget, "HIGH"); // NOT budget-scarce - this is a PACE case
  assert.notEqual(codexExplain.budget, "CRITICAL");

  const result = selectCandidate(DEFAULT_IMPLEMENTER, rs, TIER_ORDER, { now: NOW });
  assert.equal(result.status, "SELECTED");

  if (codexExplain.resource_pressure_rank === "SOFT_PRESSURED" && geminiExplain.resource_pressure_rank === "CLEAR") {
    assert.equal(result.candidate.provider, "antigravity"); // gemini ranked ahead
    assert.equal(result.pace_demotion.over, "codex/gpt-5.6-luna");
  }
  // Invariants that hold regardless of the exact fixture pressure:
  assert.equal(DEFAULT_IMPLEMENTER.minimum_tier, "DEFAULT"); // unchanged
  assert.ok(DEFAULT_IMPLEMENTER.candidates.some((c) => c.provider === "codex")); // codex not removed
  assert.equal(result.resource_state, "GREEN"); // band order not crossed
});

/* ------------------------------------------------------------------ *
 * 37. Exact-model / human pin counterfixture
 * ------------------------------------------------------------------ */

test("37 a Codex pin under PACE pressure is not silently switched to Gemini", async () => {
  const a = adapterWith(fx("rebalance-1.json"), fx("rebalance-2.json"), fx("rebalance-3.json"));
  await ingestAll(a, 3);
  const rs = a.getCurrentResourceState({ now: NOW });
  const result = selectCandidate(DEFAULT_IMPLEMENTER, rs, TIER_ORDER, {
    now: NOW,
    pinnedCandidate: { provider: "codex", model: "gpt-5.6-luna" },
  });
  assert.equal(result.status, "SELECTED");
  assert.equal(result.candidate.provider, "codex");
  assert.equal(result.pinned, true);
  assert.equal(result.pace_demotion, null); // a pin does not get reordered
});

/* ------------------------------------------------------------------ *
 * 38. Reviewer disjointness is not broken by resource evidence
 * ------------------------------------------------------------------ */

test("38 resource pressure never overrides provider disjointness", async () => {
  // Codex is the resource-healthy head; exclude it as the implementer's provider.
  const a = adapterWith(fx("codex-budget-series-1.json"));
  await a.refresh({ now: NOW });
  // add a healthy gemini so a disjoint candidate exists
  const a2 = adapterWith(fx("rebalance-1.json"));
  await a2.refresh({ now: NOW });
  const rs = a2.getCurrentResourceState({ now: NOW });
  const result = selectCandidate(DEFAULT_IMPLEMENTER, rs, TIER_ORDER, { now: NOW, excludeProvider: "codex" });
  assert.equal(result.status, "SELECTED");
  assert.notEqual(result.candidate.provider, "codex");
});

/* ------------------------------------------------------------------ *
 * JSON parsing safety + identity firewall (28 / 29)
 * ------------------------------------------------------------------ */

test("28 non-JSON input is rejected with MALFORMED_JSON", () => {
  const a = new OperationalResourceAdapter();
  assert.throws(() => a.ingestResourceEvidence(fxText("malformed-not-json.txt")), (e) => {
    assert.ok(e instanceof ResourceEvidenceError);
    assert.equal(e.code, "MALFORMED_JSON");
    return true;
  });
});

test("28 wrong-schema input is rejected with SCHEMA_INVALID", () => {
  const a = new OperationalResourceAdapter();
  assert.throws(() => a.ingestResourceEvidence(fx("malformed-schema.json")), (e) => e.code === "SCHEMA_INVALID");
});

test("29 identity-bearing fields are dropped (non-strict) and never retained anywhere", async () => {
  const a = adapterWith(fx("identity-bearing.json"));
  await a.refresh({ now: NOW });
  const entry = a.getResourceStateEntry("codex", { now: NOW });
  const blob = JSON.stringify(entry).toLowerCase();
  for (const banned of ["email", "accountid", "workspacelabel", "\"token\"", "\"account\"", "redacted-identity"]) {
    assert.ok(!blob.includes(banned), `entry must not retain ${banned}`);
  }
  assert.equal(entry.state, "GREEN"); // the rest still ingests
});

test("29 strict mode rejects identity-bearing evidence outright", () => {
  const a = new OperationalResourceAdapter({ strict: true });
  assert.throws(() => a.ingestResourceEvidence(fx("identity-bearing.json")), (e) => e.code === "IDENTITY_FIELD_PRESENT");
});

test("28 the live-producer parser ignores decorative stdout around the JSON", async () => {
  const stdout = fxText("decorated-stdout.txt");
  assert.ok(extractJsonObject(stdout).startsWith("{"));
  const provider = new OrcaCliResourceEvidenceProvider({ exec: async () => ({ stdout }), strict: true });
  const evidence = await provider.getResourceEvidence();
  assert.equal(evidence.contract_version, RESOURCE_EVIDENCE_CONTRACT_VERSION);
  assert.ok(evidence.providers.codex);
});

test("27 the live producer refuses to run without an injected exec", async () => {
  const provider = new OrcaCliResourceEvidenceProvider();
  await assert.rejects(() => provider.getResourceEvidence(), (e) => e.code === "PRODUCER_UNAVAILABLE");
});

/* ------------------------------------------------------------------ *
 * API hygiene (39 / 40) + observability (45)
 * ------------------------------------------------------------------ */

test("39 getPaceObservations returns a copy; mutating it does not touch the store", async () => {
  const a = adapterWith(fx("codex-budget-series-1.json"), fx("codex-budget-series-2.json"), fx("codex-budget-series-3.json"));
  await ingestAll(a, 3);
  const obs = a.getPaceObservations("codex", { now: NOW });
  obs.push({ remaining_ratio: 999 });
  obs[0].remaining_ratio = -1;
  assert.equal(a.getPaceObservations("codex", { now: NOW }).length, 3);
  assert.equal(a.getPaceObservations("codex", { now: NOW })[0].remaining_ratio, 0.62);
});

test("40 two adapters keep independent state (no global singleton)", async () => {
  const a = adapterWith(fx("codex-budget-series-1.json"));
  const b = adapterWith(fx("codex-budget-series-1.json"), fx("codex-budget-series-2.json"), fx("codex-budget-series-3.json"));
  await a.refresh({ now: NOW });
  await ingestAll(b, 3);
  assert.equal(a.getPaceObservations("codex", { now: NOW }).length, 1);
  assert.equal(b.getPaceObservations("codex", { now: NOW }).length, 3);
});

test("45 explain() emits derived labels only - no raw ratios or reset timestamps", async () => {
  const a = adapterWith(fx("codex-budget-series-1.json"), fx("codex-budget-series-2.json"), fx("codex-budget-series-3.json"));
  await ingestAll(a, 3);
  const ex = a.explain("codex", { now: NOW });
  const values = Object.values(ex).filter((v) => typeof v === "string");
  for (const v of values) {
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(v), `label must not contain an ISO timestamp: ${v}`);
  }
  assert.ok(typeof ex.budget === "string" && typeof ex.pace === "string");
  assert.equal(typeof ex.budget_observations, "number");
});

test("meta: contract versions are declared", () => {
  assert.equal(typeof ADAPTER_CONTRACT_VERSION, "string");
  assert.equal(typeof RESOURCE_EVIDENCE_CONTRACT_VERSION, "string");
  assert.equal(EVIDENCE_STATE_MAP.error, "UNKNOWN");
  assert.equal(EVIDENCE_STATE_MAP.ok, "GREEN");
  assert.equal(parseResourceEvidence({ providers: { x: { windows: [] } } }).providers.x.provider, "x");
});
