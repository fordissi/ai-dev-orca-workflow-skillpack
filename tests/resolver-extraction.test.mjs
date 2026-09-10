/**
 * Proves the pure-resolver extraction (scripts/lib/resource-routing.mjs) is
 * refactor-only:
 *   - the conformance checker and the shared library expose the SAME function
 *     objects (no duplicate copy);
 *   - the Operational Router adapter imports the shared library, never the
 *     conformance checker;
 *   - representative resolver outputs are unchanged (before/after anchors).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as checker from "../scripts/validate-policy-pack.mjs";
import * as lib from "../scripts/lib/resource-routing.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-09-10T09:00:00.000Z");

const SHARED_NAMES = [
  "resolvePace",
  "resolveConservationPressure",
  "resolveBurstDepletion",
  "resolveStrandedCapacity",
  "resolveResourceAcquisition",
  "resolveRouterReserve",
  "resolveActiveRouterResourcePool",
  "selectCandidate",
  "resetProximity",
  "strandedCapacityRisk",
  "conservationPressure",
  "budgetExpiryOpportunity",
  "burstResetProximity",
  "burstDepletionPressure",
  "resetExpired",
  "refreshRequired",
  "resourceWindows",
  "parseRelativeDuration",
  "relativeResetAt",
  "separateQuotaEvidence",
  "PROVIDER_RESOURCE_STATES",
  "ORCA_INTEGRATION_STATES",
];

test("the checker re-exports the identical implementation objects from the shared library", () => {
  for (const name of SHARED_NAMES) {
    assert.ok(name in lib, `library is missing ${name}`);
    assert.ok(name in checker, `checker is missing ${name}`);
    assert.equal(checker[name], lib[name], `${name} is not the same reference (a duplicate copy exists)`);
  }
});

test("the Operational Router adapter imports the shared library, not the conformance checker", () => {
  const files = [
    "scripts/operational-router/resource-adapter.mjs",
    "scripts/operational-router/resource-evidence.mjs",
    "scripts/operational-router/evidence-provider.mjs",
  ];
  for (const rel of files) {
    const src = readFileSync(join(HERE, "..", rel), "utf8");
    assert.ok(!/validate-policy-pack/.test(src), `${rel} must not import the conformance checker`);
  }
  const adapter = readFileSync(join(HERE, "..", "scripts/operational-router/resource-adapter.mjs"), "utf8");
  assert.ok(/from "\.\.\/lib\/resource-routing\.mjs"/.test(adapter), "adapter must import the shared library");
});

test("before/after anchors: BUDGET conservation is unchanged", () => {
  const entry = {
    checked_at: new Date(NOW - 60_000).toISOString(),
    available: true,
    state: "GREEN",
    source: "ORCA_RUNTIME",
    windows: [{ role: "BUDGET", remaining_ratio: 0.08, reset_at: new Date(NOW + 5 * 24 * 3600_000).toISOString() }],
  };
  const r = lib.resolveConservationPressure(entry, { now: NOW });
  assert.equal(r.conservation_pressure, "CRITICAL");
  assert.equal(r.budget_expiry_opportunity, "LOW");
});

test("before/after anchors: BURST depletion is unchanged and needs no history", () => {
  const entry = {
    checked_at: new Date(NOW - 60_000).toISOString(),
    available: true,
    state: "GREEN",
    source: "ORCA_RUNTIME",
    windows: [{ role: "BURST", remaining_ratio: 0.03, reset_at: new Date(NOW + 5 * 3600_000).toISOString() }],
  };
  assert.equal(lib.resolveBurstDepletion(entry, { now: NOW }).burst_depletion_pressure, "HIGH");
  assert.equal(lib.resolveStrandedCapacity(entry, { now: NOW }).stranded_capacity_risk, "LOW");
});

test("before/after anchors: a single snapshot yields PACE UNKNOWN; a 3-point series does not", () => {
  assert.equal(lib.resolvePace({ observations: [{ checked_at: new Date(NOW).toISOString(), remaining_ratio: 0.5 }] }, { now: NOW }).pace_pressure, "UNKNOWN");

  const t0 = NOW - 2 * 3600_000;
  const series = [
    { checked_at: new Date(t0).toISOString(), remaining_ratio: 0.60, reset_at: new Date(NOW + 5 * 24 * 3600_000).toISOString() },
    { checked_at: new Date(t0 + 3600_000).toISOString(), remaining_ratio: 0.40, reset_at: new Date(NOW + 5 * 24 * 3600_000).toISOString() },
    { checked_at: new Date(t0 + 2 * 3600_000).toISOString(), remaining_ratio: 0.20, reset_at: new Date(NOW + 5 * 24 * 3600_000).toISOString() },
  ];
  const p = lib.resolvePace({ observations: series }, { now: NOW });
  assert.notEqual(p.pace_pressure, "UNKNOWN");
  assert.equal(p.pace_confidence, "MEDIUM");
});

test("before/after anchors: Router reserve reads BUDGET remaining_ratio on flat bands", () => {
  const entry = {
    checked_at: new Date(NOW - 60_000).toISOString(),
    available: true,
    state: "GREEN",
    source: "ORCA_RUNTIME",
    windows: [{ role: "BUDGET", remaining_ratio: 0.12, reset_at: new Date(NOW + 5 * 24 * 3600_000).toISOString() }],
  };
  assert.equal(lib.resolveRouterReserve(entry, { now: NOW }).router_reserve_band, "ROUTER_RESERVE");
});

test("before/after anchors: resource-acquisition precedence and UNKNOWN neutrality", () => {
  const stale = { state: "UNKNOWN", source: "UNKNOWN", checked_at: null, available: null };
  const acq = lib.resolveResourceAcquisition({ current: stale });
  assert.equal(acq.acquisition_source, "UNKNOWN");
  assert.equal(acq.entry.state, "UNKNOWN");
});
