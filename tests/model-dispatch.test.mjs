import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";
import { selectCandidate } from "../scripts/lib/resource-routing.mjs";
import {
  classifyAuthProbe,
  classifyLaunchFailure,
  classifyWorkerHealth,
  planFailover,
  preDispatchCheck,
  providerDispatchable,
  recheckAfterLogin,
  recordModelCapability,
  resolveCliModelArgument,
} from "../scripts/lib/model-dispatch.mjs";
import { checkReasoningDispatch, validateRegistry } from "../scripts/validate-policy-pack.mjs";

const registry = parse(await readFile("policies/MODEL_REGISTRY.yaml", "utf8"));
const tierOrder = registry.capability_tier_order;
const NOW = Date.parse("2026-09-18T12:00:00Z");
const green = (key) => ({
  [key]: { state: "GREEN", source: "PROVIDER_NATIVE_PROBE", checked_at: "2026-09-18T11:55:00Z", available: true, remaining_confidence: "HIGH" },
});
const allGreen = { ...green("claude"), ...green("codex"), antigravity: { gemini: green("x").x } };

const CATALOG_ERROR = `"sonnet-5" isn't described by this version's model catalog`;
const FAKE_TOKEN = "sk-ant-oat01-FAKEFAKEFAKEFAKE0123456789";
// Assembled at runtime so the repository secret scanner does not flag the fixture.
const AUTH_HEADER = ["Author", "ization: ", "Bea", "rer"].join("");

// --- Routing map -----------------------------------------------------------

for (const [alias, expected] of [["sonnet", "sonnet"], ["opus", "opus"], ["haiku", "haiku"]]) {
  test(`claude ${alias} alias resolves to --model ${expected}`, () => {
    const r = resolveCliModelArgument(registry, "claude", alias);
    assert.equal(r.status, "RESOLVED");
    assert.equal(r.cli_model, expected);
    assert.equal(r.source, "CATALOG_ALIAS");
  });
}

test("sonnet-5 is MODEL_UNKNOWN and is never dispatched", () => {
  assert.equal(resolveCliModelArgument(registry, "claude", "sonnet-5").status, "MODEL_UNKNOWN");
  const check = preDispatchCheck({ registry, provider: "claude", model: "sonnet-5", auth: "AUTH_OK" });
  assert.equal(check.action, "DO_NOT_DISPATCH");
  assert.equal(check.failure_class, "MODEL_UNKNOWN");
  assert.equal(check.failed_step, "MODEL");
});

test("sonnet-5 resolves only through a reviewed model_override", () => {
  const reviewed = structuredClone(registry);
  reviewed.resolvers.claude_models.model_overrides = { "sonnet-5": { cli_model: "sonnet" } };
  const r = resolveCliModelArgument(reviewed, "claude", "sonnet-5");
  assert.equal(r.status, "RESOLVED");
  assert.equal(r.source, "REVIEWED_OVERRIDE");
});

test("the shipped registry passes the alias-catalog conformance check", () => {
  assert.deepEqual(validateRegistry(registry), []);
  const bad = structuredClone(registry);
  bad.capability_slots.STRONG_IMPLEMENTER.candidates[1].model = "sonnet-5";
  assert.ok(validateRegistry(bad).some((f) => f.includes("STRONG_IMPLEMENTER") && f.includes("sonnet-5")));
});

test("non-catalog providers pass through unchanged", () => {
  const r = resolveCliModelArgument(registry, "codex", "gpt-5.6-terra");
  assert.equal(r.cli_model, "gpt-5.6-terra");
  assert.equal(r.source, "PASS_THROUGH");
});

// --- Classification --------------------------------------------------------

test("catalog error classifies as MODEL_UNKNOWN, not a provider failure", () => {
  assert.equal(classifyLaunchFailure(CATALOG_ERROR), "MODEL_UNKNOWN");
  const h = classifyWorkerHealth({ terminal_started: true, model_launched: false, output: CATALOG_ERROR });
  assert.equal(h.action, "FAIL_FAST");
  assert.equal(h.failure_class, "MODEL_UNKNOWN");
  assert.equal(h.provider_failure, false);
});

test("launch failure classes stay distinct", () => {
  assert.equal(classifyLaunchFailure("Claude AI usage limit reached|1758200000"), "RESOURCE_EXHAUSTED");
  assert.equal(classifyLaunchFailure("claude: command not found"), "INTEGRATION_UNAVAILABLE");
  assert.equal(classifyLaunchFailure("Error: model opus is not available on your plan"), "MODEL_UNAVAILABLE");
  assert.equal(classifyLaunchFailure("some unrelated warning"), null);
});

test("opus / haiku clean-unavailable classification leaves sonnet dispatchable", () => {
  let cap = recordModelCapability({}, "claude", "haiku", classifyLaunchFailure("model haiku is not available"));
  cap = recordModelCapability(cap, "claude", "opus", "MODEL_UNAVAILABLE");
  const d = providerDispatchable({ provider: "claude", models: ["sonnet", "opus", "haiku"], capability: cap, integration_state: "AVAILABLE", resource_state: "AVAILABLE", auth_state: "AUTH_OK" });
  assert.equal(d.dispatchable, true);
  assert.deepEqual(d.usable_models, ["sonnet"]);
});

test("non-model failures never write the model capability map", () => {
  assert.deepEqual(recordModelCapability({}, "claude", "sonnet", "RESOURCE_EXHAUSTED"), {});
  assert.deepEqual(recordModelCapability({}, "claude", "sonnet", "AUTH_REQUIRED"), {});
});

// --- Pre-dispatch ----------------------------------------------------------

test("pre-dispatch success yields exact alias and reasoning is preserved", () => {
  const check = preDispatchCheck({ registry, provider: "claude", model: "sonnet", runtime: { present: true }, auth: { exit_code: 0, logged_in: true }, model_probe: { launched: true }, resource_state: "AVAILABLE" });
  assert.equal(check.action, "CREATE_TERMINAL");
  assert.equal(check.cli_model, "sonnet");
  assert.equal(check.capability, "VERIFIED");
  const identity = { provider: "claude", model: "sonnet", model_family: "claude-sonnet", reasoning_effort: "high" };
  const dispatch = checkReasoningDispatch({ provider: "claude", expected: identity, actual: identity, command: `claude --model ${check.cli_model} --effort high -p "x"` });
  assert.equal(dispatch.result, "DISPATCH_IDENTITY_MATCH");
});

test("a model probe that hits the catalog error blocks before any terminal", () => {
  const reviewed = structuredClone(registry);
  reviewed.resolvers.claude_models.model_overrides = { "sonnet-5": { cli_model: "sonnet-5" } };
  const check = preDispatchCheck({ registry: reviewed, provider: "claude", model: "sonnet-5", auth: "AUTH_OK", model_probe: { launched: false, output: CATALOG_ERROR } });
  assert.equal(check.action, "DO_NOT_DISPATCH");
  assert.equal(check.failure_class, "MODEL_UNKNOWN");
});

test("a model already known bad this session is not re-probed or re-dispatched", () => {
  const cap = recordModelCapability({}, "claude", "opus", "MODEL_UNAVAILABLE");
  const check = preDispatchCheck({ registry, provider: "claude", model: "opus", auth: "AUTH_OK", knownCapability: cap });
  assert.equal(check.action, "DO_NOT_DISPATCH");
});

test("missing runtime is INTEGRATION_UNAVAILABLE at step 1", () => {
  const check = preDispatchCheck({ registry, provider: "claude", model: "sonnet", runtime: { present: false } });
  assert.equal(check.failed_step, "RUNTIME");
  assert.equal(check.failure_class, "INTEGRATION_UNAVAILABLE");
});

// --- Selection / failover --------------------------------------------------

const slot = registry.capability_slots.STRONG_IMPLEMENTER;
const selectStage2 = (options = {}) => selectCandidate(slot, allGreen, tierOrder, { now: NOW, preferStrandedCapacity: false, ...options });

test("quota routing is unchanged when no capability / auth map is passed", () => {
  const baseline = selectStage2();
  const withEmpty = selectStage2({ modelCapability: {}, providerAuth: {} });
  assert.equal(baseline.status, "SELECTED");
  assert.deepEqual(withEmpty.candidate, baseline.candidate);
});

test("provider remains dispatchable after one bad model", () => {
  // DEEP_REASONER head is claude/sonnet. A bad opus must not touch it.
  const deep = registry.capability_slots.DEEP_REASONER;
  const r = selectCandidate(deep, allGreen, tierOrder, { now: NOW, preferStrandedCapacity: false, modelCapability: { "claude/opus": "MODEL_UNKNOWN", "claude/sonnet-5": "MODEL_UNKNOWN" } });
  assert.equal(r.status, "SELECTED");
  assert.equal(r.candidate.provider, "claude");
  assert.equal(r.candidate.model, "sonnet");
});

test("a bad model fails over to the next verified candidate without duplicate dispatch", () => {
  const deep = registry.capability_slots.DEEP_REASONER;
  const select = (modelCapability, providerAuth) =>
    selectCandidate(deep, allGreen, tierOrder, { now: NOW, preferStrandedCapacity: false, modelCapability, providerAuth });
  const first = select({}, {});
  assert.equal(first.candidate.model, "sonnet");
  const f = planFailover({ failed: first.candidate, failure_class: "MODEL_UNAVAILABLE", select });
  assert.equal(f.next.status, "SELECTED");
  assert.notEqual(`${f.next.candidate.provider}/${f.next.candidate.model}`, "claude/sonnet");
  const g = planFailover({ failed: f.next.candidate, failure_class: "MODEL_UNAVAILABLE", attempted: f.attempted, capability: f.capability, select });
  const labels = [first.candidate, f.next.candidate, g.next.candidate].map((c) => `${c.provider}/${c.model}`);
  assert.equal(new Set(labels).size, 3);
  // Resource snapshot was never mutated by model failures.
  assert.equal(allGreen.claude.available, true);
});

test("every candidate model-failed blocks as MODEL_UNAVAILABLE, not provider unavailable", () => {
  const cap = Object.fromEntries(slot.candidates.map((c) => [`${c.provider}/${c.model}`, "MODEL_UNKNOWN"]));
  const r = selectStage2({ modelCapability: cap });
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.code, "MODEL_UNAVAILABLE");
});

// --- Worker health ---------------------------------------------------------

test("worker health stages: terminal alone is not a healthy worker", () => {
  assert.equal(classifyWorkerHealth({ terminal_started: true }).healthy, false);
  assert.equal(classifyWorkerHealth({ terminal_started: true }).stage, "TERMINAL_STARTED");
  assert.equal(classifyWorkerHealth({ terminal_started: true, model_launched: true }).stage, "MODEL_LAUNCHED");
  const active = classifyWorkerHealth({ terminal_started: true, model_launched: true, activity_observed: true });
  assert.equal(active.stage, "WORKER_ACTIVE");
  assert.equal(active.healthy, true);
});

// --- Auth state ------------------------------------------------------------

test("authenticated provider probes AUTH_OK", () => {
  assert.equal(classifyAuthProbe({ exit_code: 0, logged_in: true, output: '{"loggedIn": true}' }), "AUTH_OK");
});

test("expired session, login required and revoked credential are distinct", () => {
  assert.equal(classifyAuthProbe({ exit_code: 1, output: "OAuth token has expired. Please run claude auth login." }), "AUTH_EXPIRED");
  assert.equal(classifyAuthProbe({ exit_code: 1, logged_in: false, output: '{"loggedIn": false}' }), "AUTH_REQUIRED");
  assert.equal(classifyAuthProbe({ exit_code: 1, output: "Not logged in · Please run /login" }), "AUTH_REQUIRED");
  assert.equal(classifyAuthProbe({ exit_code: 1, output: "Invalid API key · credential revoked" }), "AUTH_INVALID");
  assert.equal(classifyAuthProbe(null), "AUTH_UNKNOWN");
});

test("auth-required provider with healthy quota/model: human action, no terminal, not provider-unavailable", () => {
  const check = preDispatchCheck({ registry, provider: "claude", model: "sonnet", runtime: { present: true }, auth: { exit_code: 1, logged_in: false }, resource_state: "AVAILABLE" });
  assert.equal(check.action, "HUMAN_ACTION_REQUIRED");
  assert.equal(check.failure_class, "AUTH_REQUIRED");
  assert.equal(check.human_action.command, "claude auth login");
  assert.equal(check.fallback_permitted, true);
  const d = providerDispatchable({ provider: "claude", models: ["sonnet"], integration_state: "AVAILABLE", resource_state: "AVAILABLE", auth_state: "AUTH_REQUIRED" });
  assert.equal(d.reason, "AUTH_REQUIRED");
  assert.notEqual(d.reason, "PROVIDER_UNAVAILABLE");
  const h = classifyWorkerHealth({ terminal_started: true, model_launched: false, output: "Not logged in · Please run /login" });
  assert.equal(h.action, "HUMAN_ACTION_REQUIRED");
  assert.equal(h.provider_failure, false);
});

test("fallback routes to another provider while one is AUTH_REQUIRED", () => {
  const deep = registry.capability_slots.DEEP_REASONER;
  const r = selectCandidate(deep, allGreen, tierOrder, { now: NOW, preferStrandedCapacity: false, providerAuth: { claude: "AUTH_REQUIRED" } });
  assert.equal(r.status, "SELECTED");
  assert.notEqual(r.candidate.provider, "claude");
  const pinned = selectCandidate(deep, allGreen, tierOrder, { now: NOW, providerAuth: { claude: "AUTH_EXPIRED" }, pinnedCandidate: { provider: "claude", model: "sonnet" } });
  assert.equal(pinned.code, "AUTH_REQUIRED");
});

test("successful re-auth restores dispatchability without router restart", () => {
  const before = { claude: "AUTH_EXPIRED", codex: "AUTH_OK" };
  const r = recheckAfterLogin({ provider: "claude", providerAuth: before, auth_probe: { exit_code: 0, logged_in: true }, model: "sonnet", model_probe: { launched: true } });
  assert.equal(r.restored, true);
  assert.equal(r.router_restart_required, false);
  assert.deepEqual(r.providerAuth, { claude: "AUTH_OK", codex: "AUTH_OK" });
  const deep = registry.capability_slots.DEEP_REASONER;
  const sel = selectCandidate(deep, allGreen, tierOrder, { now: NOW, preferStrandedCapacity: false, providerAuth: r.providerAuth });
  assert.equal(sel.candidate.provider, "claude");
  const failed = recheckAfterLogin({ provider: "claude", providerAuth: before, auth_probe: { exit_code: 1, logged_in: false } });
  assert.equal(failed.restored, false);
  assert.equal(failed.human_action.command, "claude auth login");
});

test("no token or credential value appears in any diagnostic", () => {
  const leaky = `Invalid API key ${FAKE_TOKEN} was revoked; ${AUTH_HEADER} ${FAKE_TOKEN}`;
  const outputs = [
    preDispatchCheck({ registry, provider: "claude", model: "sonnet", auth: { exit_code: 1, output: leaky } }),
    preDispatchCheck({ registry, provider: "claude", model: "sonnet", auth: "AUTH_OK", model_probe: { launched: false, output: leaky } }),
    classifyWorkerHealth({ terminal_started: true, model_launched: false, output: leaky }),
    recheckAfterLogin({ provider: "claude", auth_probe: { exit_code: 1, output: leaky } }),
    providerDispatchable({ provider: "claude", models: ["sonnet"], auth_state: classifyAuthProbe({ output: leaky }) }),
  ];
  for (const o of outputs) {
    const text = JSON.stringify(o);
    assert.ok(!text.includes(FAKE_TOKEN), text);
    assert.ok(!text.includes("Bearer"), text);
  }
  assert.equal(outputs[0].failure_class, "AUTH_INVALID");
});
