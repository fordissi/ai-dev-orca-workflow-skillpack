import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ORCA_INTEGRATION_STATES,
  PROVIDER_RESOURCE_STATES,
  resolveRouterReserve,
  separateQuotaEvidence,
} from "../scripts/validate-policy-pack.mjs";

const NOW = "2026-09-04T12:00:00Z";
const at = (ms) => new Date(Date.parse(NOW) + ms).toISOString();
const HOUR = 60 * 60 * 1000;

// A fresh, trust-valid provider-native reading. Both pools full unless overridden.
const probeEntry = (over = {}) => ({
  state: "GREEN",
  source: "PROVIDER_NATIVE_PROBE",
  available: true,
  checked_at: NOW,
  weekly_window: { role: "BUDGET", remaining_ratio: 1.0, reset_at: at(160 * HOUR) },
  short_window: { role: "BURST", remaining_ratio: 1.0, reset_at: at(3 * HOUR) },
  ...over,
});

const okProbe = (over) => ({ probe_status: "PROBE_OK", entry: probeEntry(over) });

test("the two axes are enumerated and never merged", () => {
  assert.deepEqual(PROVIDER_RESOURCE_STATES, ["AVAILABLE", "PRESSURED", "EXHAUSTED", "UNKNOWN"]);
  assert.deepEqual(ORCA_INTEGRATION_STATES, ["AVAILABLE", "UNAVAILABLE", "DEGRADED", "UNKNOWN"]);
});

// 1
test("agy /usage AVAILABLE + Orca Antigravity unavailable -> provider AVAILABLE, integration UNAVAILABLE", () => {
  const r = separateQuotaEvidence(
    { provider_probe: okProbe(), orca_integration: { visibility: "UNAVAILABLE" } },
    { now: NOW },
  );
  assert.equal(r.provider_resource_state, "AVAILABLE");
  assert.equal(r.orca_integration_state, "UNAVAILABLE");
  assert.equal(r.quota_available, "YES");
  assert.equal(r.resource_evidence_source, "PROVIDER_NATIVE_PROBE");
});

// 2
test("a successful provider-native probe is never overridden by Orca aggregate state", () => {
  for (const visibility of ["UNAVAILABLE", "DEGRADED", "UNKNOWN", "AVAILABLE"]) {
    const r = separateQuotaEvidence(
      { provider_probe: okProbe(), orca_integration: { visibility } },
      { now: NOW },
    );
    assert.equal(r.provider_resource_state, "AVAILABLE", `orca ${visibility} moved the provider axis`);
    assert.equal(r.aggregate_overrode_probe, false);
    assert.equal(r.orca_integration_state, visibility === "UNKNOWN" ? "UNKNOWN" : visibility);
  }
});

// 3
test("probe fails + Orca unavailable -> provider UNKNOWN, never EXHAUSTED", () => {
  for (const status of ["PROBE_TIMEOUT", "PROBE_AUTH_REQUIRED", "PROBE_PARSE_FAILED", "PROBE_PERMISSION_BLOCKED"]) {
    const r = separateQuotaEvidence(
      {
        // Even an entry that *would* read RED/exhausted must be ignored when the probe did not succeed.
        provider_probe: { probe_status: status, entry: probeEntry({ state: "RED", available: false }) },
        orca_integration: { visibility: "UNAVAILABLE" },
      },
      { now: NOW },
    );
    assert.equal(r.provider_resource_state, "UNKNOWN", status);
    assert.notEqual(r.provider_resource_state, "EXHAUSTED");
    assert.equal(r.quota_available, "UNKNOWN");
    assert.equal(r.refresh_before_dispatch, true);
  }
});

// 4
test("provider quota available + dispatch runtime unavailable stay distinct", () => {
  const r = separateQuotaEvidence(
    {
      provider_probe: okProbe(),
      orca_integration: { visibility: "UNAVAILABLE" },
      dispatch_runtime: { available: "NO" },
    },
    { now: NOW },
  );
  assert.equal(r.quota_available, "YES");
  assert.equal(r.dispatch_runtime_available, "NO");

  // Absent an explicit runtime check, dispatchability is UNKNOWN - not NO,
  // and not conflated with the Orca integration axis.
  const r2 = separateQuotaEvidence(
    { provider_probe: okProbe(), orca_integration: { visibility: "UNAVAILABLE" } },
    { now: NOW },
  );
  assert.equal(r2.quota_available, "YES");
  assert.equal(r2.dispatch_runtime_available, "UNKNOWN");
});

// 5
test("agy models and agy /usage resolve independently - quota evidence carries no generation", () => {
  const r = separateQuotaEvidence({ provider_probe: okProbe() }, { now: NOW });
  for (const key of Object.keys(r)) {
    assert.ok(
      !/model|generation|gemini|stage|candidate|effort|reasoning|registry/i.test(key),
      `quota evidence must not carry routing key ${key}`,
    );
  }
  // A caller-supplied model-catalog outcome is simply not consumed here.
  const r2 = separateQuotaEvidence(
    { provider_probe: okProbe(), agy_models: { status: "OK", newest: "gemini-3.8-flash-high" } },
    { now: NOW },
  );
  assert.deepEqual(r, r2);
});

// 6
test("probe unavailable + Orca aggregate available -> fallback evidence allowed, not a confident reading", () => {
  const r = separateQuotaEvidence(
    { provider_probe: { probe_status: "PROBE_PERMISSION_BLOCKED" }, orca_integration: { visibility: "AVAILABLE" } },
    { now: NOW },
  );
  assert.equal(r.provider_resource_state, "UNKNOWN");
  assert.equal(r.orca_integration_state, "AVAILABLE");
  assert.equal(r.orca_fallback_usable, true);
  assert.equal(r.quota_available, "UNKNOWN"); // available integration is not a quota figure
});

// 7
test("an explicit human quota question requires provider-native probes", () => {
  const r = separateQuotaEvidence(
    { orca_integration: { visibility: "AVAILABLE" }, human_quota_query: true },
    { now: NOW },
  );
  assert.equal(r.provider_native_probe_required, true);

  const r2 = separateQuotaEvidence({ provider_probe: okProbe(), human_quota_query: true }, { now: NOW });
  assert.equal(r2.provider_native_probe_required, true);

  // No explicit question and a fresh probe already in hand: nothing more required.
  const r3 = separateQuotaEvidence({ provider_probe: okProbe() }, { now: NOW });
  assert.equal(r3.provider_native_probe_required, false);
});

// 8
test("quota resolution does not alter registry membership", async () => {
  const r = separateQuotaEvidence({ provider_probe: okProbe() }, { now: NOW });
  assert.ok(!/registry|slot|candidate|membership|enabled/i.test(JSON.stringify(Object.keys(r))));
  const policy = await readFile("policies/RESOURCE_AWARE_ROUTING.md", "utf8");
  assert.ok(policy.includes("純證據解析"));
  assert.ok(policy.includes("membership"));
});

// 9
test("quota resolution does not alter requested reasoning effort", async () => {
  const r = separateQuotaEvidence({ provider_probe: okProbe() }, { now: NOW });
  assert.equal("reasoning_effort" in r, false);
  assert.equal("effort" in r, false);
  const policy = await readFile("policies/RESOURCE_AWARE_ROUTING.md", "utf8");
  assert.ok(policy.includes("reasoning effort"));
});

// 10
test("Router Capacity Reserve still applies after corrected quota resolution", () => {
  // The probe corrects the provider to a usable reading, but its BUDGET window
  // is thin: the reserve band is unchanged by the quota-evidence layer.
  const thin = probeEntry({
    weekly_window: { role: "BUDGET", remaining_ratio: 0.12, reset_at: at(120 * HOUR) },
  });
  const q = separateQuotaEvidence({ provider_probe: { probe_status: "PROBE_OK", entry: thin } }, { now: NOW });
  assert.equal(q.provider_resource_state, "PRESSURED"); // tightest window 0.12

  const reserve = resolveRouterReserve(thin, { now: NOW });
  assert.equal(reserve.router_reserve_band, "ROUTER_RESERVE"); // 0.12 <= 0.15
});

// 11
test("a successful provider-native reset_at wins over a stale aggregate reset", () => {
  const freshReset = at(120 * HOUR);
  const entry = probeEntry({ weekly_window: { role: "BUDGET", remaining_ratio: 0.9, reset_at: freshReset } });
  const r = separateQuotaEvidence(
    {
      provider_probe: { probe_status: "PROBE_OK", entry },
      orca_integration: { visibility: "UNAVAILABLE", reset_at: at(-48 * HOUR) },
    },
    { now: NOW },
  );
  assert.equal(r.provider_reset_at, freshReset);
  assert.notEqual(r.provider_reset_at, at(-48 * HOUR));
});

// 12
test("unknown or stale provider evidence triggers a refresh before new dispatch", () => {
  const staleEntry = probeEntry({ checked_at: at(-30 * 60 * 1000) }); // 30 min old, past the 5-min TTL
  const r = separateQuotaEvidence({ provider_probe: { probe_status: "PROBE_OK", entry: staleEntry } }, { now: NOW });
  assert.equal(r.provider_resource_state, "UNKNOWN");
  assert.equal(r.refresh_before_dispatch, true);

  const r2 = separateQuotaEvidence({}, { now: NOW });
  assert.equal(r2.provider_resource_state, "UNKNOWN");
  assert.equal(r2.orca_integration_state, "UNKNOWN");
  assert.equal(r2.refresh_before_dispatch, true);
});

test("provider-native quota precedence is documented and owned in one place", async () => {
  const policy = await readFile("policies/RESOURCE_AWARE_ROUTING.md", "utf8");
  const probes = await readFile("references/RESOURCE_PROBES.md", "utf8");
  const commands = await readFile("references/OFFICIAL_COMMANDS.md", "utf8");
  const skill = await readFile("skills/orca-multi-agent-dev/SKILL.md", "utf8");

  for (const phrase of [
    "Provider-native quota probe precedence",
    "provider_resource_state",
    "orca_integration_state",
    "MUST NOT override a successful provider-native",
    "quota_available",
    "dispatch_runtime_available",
    "separateQuotaEvidence()",
    'agy --print "/usage" --output-format json',
    "orca account list",
    "不得把 `UNKNOWN` 轉成 `EXHAUSTED`",
  ]) {
    assert.ok(policy.includes(phrase), `RESOURCE_AWARE_ROUTING.md must state: ${phrase}`);
  }

  assert.ok(probes.includes('agy --print "/usage" --output-format json'));
  assert.ok(probes.includes("is not a quota source"));
  assert.ok(commands.includes("integration evidence only — never a quota source"));
  assert.ok(skill.includes("orca account list"));

  // The registry file is still present and untouched by this fix.
  const registry = await readFile("policies/MODEL_REGISTRY.yaml", "utf8");
  assert.ok(registry.length > 0);
});
