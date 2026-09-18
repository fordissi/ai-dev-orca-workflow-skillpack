import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";
import { selectCandidate } from "../scripts/lib/resource-routing.mjs";
import {
  classifyWorkerHealth,
  familyDispatchable,
  parseAntigravityModels,
  preDispatchCheck,
  resolveDispatchTarget,
  runtimePathsForFamily,
} from "../scripts/lib/model-dispatch.mjs";
import { validateRegistry } from "../scripts/validate-policy-pack.mjs";

const registry = parse(await readFile("policies/MODEL_REGISTRY.yaml", "utf8"));
// Verbatim `agy models` output captured 2026-09-18.
const AGY = await readFile("tests/fixtures/agy-models.txt", "utf8");

// --- Adapter table ---------------------------------------------------------

test("runtime adapters codex_cli, claude_cli and antigravity are declared", () => {
  assert.deepEqual(Object.keys(registry.runtime_adapters).sort(), ["antigravity", "claude_cli", "codex_cli"]);
  assert.deepEqual(registry.runtime_adapters.antigravity.provider_families, ["gemini", "claude", "gpt-oss"]);
});

test("live catalog parses all seven picker models and their effort variants", () => {
  const catalog = parseAntigravityModels(AGY);
  assert.equal(catalog.length, 14);
  const bases = [...new Set(catalog.map((e) => e.base_display))];
  assert.deepEqual(bases, [
    "Gemini 3.8 Flash",
    "Gemini 3.7 Flash",
    "Gemini 3.6 Flash",
    "Gemini 3.1 Pro",
    "Claude Sonnet 4.6 (Thinking)",
    "Claude Opus 4.6 (Thinking)",
    "GPT-OSS 120B",
  ]);
});

// --- Target resolution -----------------------------------------------------

test("Gemini is routed through Antigravity with exact id and effort", () => {
  const t = resolveDispatchTarget({ registry, runtime_adapter: "antigravity", provider_family: "gemini", model: "Gemini 3.8 Flash", effort: "high", live_catalog: AGY });
  assert.equal(t.status, "RESOLVED");
  assert.equal(t.runtime_adapter, "antigravity");
  assert.equal(t.provider_family, "gemini");
  assert.equal(t.cli_model, "gemini-3.8-flash-high");
  assert.equal(t.effort_mode, "ID_SUFFIX");
  assert.equal(t.resource_state_key, "antigravity.gemini");
  assert.deepEqual(t.launch_args, ["--model", "gemini-3.8-flash-high", "--effort", "high"]);
});

test("AUTO_GEMINI resolves to the newest Gemini Flash generation for the effort", () => {
  const t = resolveDispatchTarget({ registry, provider: "antigravity", model: "AUTO_GEMINI", effort: "low", live_catalog: AGY });
  assert.equal(t.cli_model, "gemini-3.8-flash-low");
  assert.equal(t.provider_family, "gemini");
});

test("Claude is routed through Claude CLI with a catalog alias", () => {
  const t = resolveDispatchTarget({ registry, runtime_adapter: "claude_cli", provider_family: "claude", model: "sonnet", effort: "high" });
  assert.equal(t.status, "RESOLVED");
  assert.equal(t.runtime_adapter, "claude_cli");
  assert.equal(t.provider_family, "claude");
  assert.equal(t.cli_model, "sonnet");
  assert.equal(t.resource_state_key, "claude");
  assert.deepEqual(t.launch_args, ["--model", "sonnet", "--effort", "high"]);
});

test("Claude is routed through Antigravity on its own resource pool", () => {
  const t = resolveDispatchTarget({ registry, runtime_adapter: "antigravity", provider_family: "claude", model: "Claude Sonnet 4.6 (Thinking)", effort: "high", live_catalog: AGY });
  assert.equal(t.status, "RESOLVED");
  assert.equal(t.cli_model, "claude-sonnet-4-6");
  assert.equal(t.provider_family, "claude");
  assert.equal(t.effort_mode, "SESSION_FLAG");
  assert.equal(t.resource_state_key, "antigravity.non_gemini");
  assert.deepEqual(t.launch_args, ["--model", "claude-sonnet-4-6", "--effort", "high"]);
});

test("provider=gemini has no direct adapter; Antigravity is offered instead", () => {
  const t = resolveDispatchTarget({ registry, provider: "gemini", model: "Gemini 3.8 Flash", effort: "high" });
  assert.equal(t.status, "INTEGRATION_UNAVAILABLE");
  assert.deepEqual(t.alternative_runtime_paths, [{ runtime_adapter: "antigravity", registry_provider: "antigravity" }]);
  const check = preDispatchCheck({ registry, provider: "gemini", model: "Gemini 3.8 Flash", effort: "high" });
  assert.equal(check.action, "DO_NOT_DISPATCH");
  assert.equal(check.failed_step, "RUNTIME");
  assert.deepEqual(registry.direct_adapters_absent, ["gemini"]);
  // Same model through the Antigravity path is dispatchable.
  const via = preDispatchCheck({ registry, provider: "antigravity", model: "Gemini 3.8 Flash", effort: "high", live_catalog: AGY, auth: "AUTH_OK" });
  assert.equal(via.action, "CREATE_TERMINAL");
});

test("registry conformance rejects a provider=gemini candidate and a family the runtime does not serve", () => {
  assert.deepEqual(validateRegistry(registry), []);
  const bad = structuredClone(registry);
  bad.capability_slots.LONG_CONTEXT_DISCOVERY.candidates[0].provider = "gemini";
  assert.ok(validateRegistry(bad).some((f) => f.includes("no verified runtime adapter")));
  const wrongFamily = structuredClone(registry);
  wrongFamily.capability_slots.STRONG_IMPLEMENTER.candidates[1].model_family = "gemini";
  assert.ok(validateRegistry(wrongFamily).some((f) => f.includes("claude_cli does not serve provider family gemini")));
});

test("a model can exist in one runtime but not another", () => {
  // Claude Sonnet 4.6 is an Antigravity catalog entry, not a Claude CLI alias.
  assert.equal(resolveDispatchTarget({ registry, runtime_adapter: "claude_cli", model: "Claude Sonnet 4.6 (Thinking)", effort: "high" }).status, "MODEL_UNKNOWN");
  assert.equal(resolveDispatchTarget({ registry, runtime_adapter: "claude_cli", model: "claude-sonnet-4-6", effort: "high" }).status, "MODEL_UNKNOWN");
  // `sonnet` (Sonnet 5) is a Claude CLI alias, not an Antigravity model.
  assert.equal(resolveDispatchTarget({ registry, runtime_adapter: "antigravity", model: "sonnet", effort: "high", live_catalog: AGY }).status, "MODEL_UNKNOWN");
  // Gemini is not served by Claude CLI at all.
  assert.equal(resolveDispatchTarget({ registry, runtime_adapter: "claude_cli", model: "gemini-3.8-flash-high" }).status, "MODEL_UNKNOWN");
});

test("unknown Antigravity model is MODEL_UNKNOWN, not a runtime or provider failure", () => {
  const check = preDispatchCheck({ registry, provider: "antigravity", model: "Gemini 9 Ultra", effort: "high", live_catalog: AGY, auth: "AUTH_OK" });
  assert.equal(check.failure_class, "MODEL_UNKNOWN");
  assert.equal(check.failed_step, "MODEL");
});

test("Antigravity without a live catalog requires a probe, never a guessed id", () => {
  const check = preDispatchCheck({ registry, provider: "antigravity", model: "AUTO_GEMINI", effort: "low", auth: "AUTH_OK" });
  assert.equal(check.action, "PROBE_REQUIRED");
  assert.equal(check.probe_command, "agy models");
});

// --- Effort ----------------------------------------------------------------

for (const effort of ["low", "medium", "high"]) {
  test(`Gemini 3.8 Flash effort ${effort} resolves to its id variant`, () => {
    const t = resolveDispatchTarget({ registry, runtime_adapter: "antigravity", model: "Gemini 3.8 Flash", effort, live_catalog: AGY });
    assert.equal(t.cli_model, `gemini-3.8-flash-${effort}`);
  });
}

test("effort resolution honours the variants the catalog actually lists", () => {
  const pro = resolveDispatchTarget({ registry, runtime_adapter: "antigravity", model: "Gemini 3.1 Pro", effort: "medium", live_catalog: AGY });
  assert.equal(pro.status, "EFFORT_UNSUPPORTED");
  assert.deepEqual(pro.supported_efforts, ["high", "low"]);
  const oss = resolveDispatchTarget({ registry, runtime_adapter: "antigravity", model: "GPT-OSS 120B", effort: "high", live_catalog: AGY });
  assert.equal(oss.status, "EFFORT_UNSUPPORTED");
  assert.equal(resolveDispatchTarget({ registry, runtime_adapter: "antigravity", model: "GPT-OSS 120B", effort: "medium", live_catalog: AGY }).cli_model, "gpt-oss-120b-medium");
  // Antigravity accepts only low|medium|high; Claude CLI accepts max.
  assert.equal(resolveDispatchTarget({ registry, runtime_adapter: "antigravity", model: "Claude Opus 4.6 (Thinking)", effort: "max", live_catalog: AGY }).status, "EFFORT_UNSUPPORTED");
  assert.equal(resolveDispatchTarget({ registry, runtime_adapter: "claude_cli", model: "opus", effort: "max" }).status, "RESOLVED");
  const check = preDispatchCheck({ registry, provider: "antigravity", model: "Gemini 3.1 Pro", effort: "medium", live_catalog: AGY, auth: "AUTH_OK" });
  assert.equal(check.failed_step, "EFFORT");
  assert.equal(check.action, "DO_NOT_DISPATCH");
});

test("a declared family that the resolved model does not belong to is CONFIG_INVALID", () => {
  const t = resolveDispatchTarget({ registry, runtime_adapter: "antigravity", provider_family: "gemini", model: "Claude Sonnet 4.6 (Thinking)", effort: "high", live_catalog: AGY });
  assert.equal(t.status, "CONFIG_INVALID");
});

// --- Runtime auth / availability ------------------------------------------

test("Antigravity runtime auth required: human action, no reviewed login invented", () => {
  const check = preDispatchCheck({ registry, provider: "antigravity", model: "AUTO_GEMINI", effort: "low", live_catalog: AGY, auth: "AUTH_REQUIRED" });
  assert.equal(check.action, "HUMAN_ACTION_REQUIRED");
  assert.equal(check.failure_class, "AUTH_REQUIRED");
  assert.equal(check.human_action.command, null);
});

test("Antigravity runtime unavailable is INTEGRATION_UNAVAILABLE at step 1", () => {
  const check = preDispatchCheck({ registry, provider: "antigravity", model: "AUTO_GEMINI", effort: "low", runtime: { present: false } });
  assert.equal(check.failure_class, "INTEGRATION_UNAVAILABLE");
  assert.equal(check.failed_step, "RUNTIME");
  const h = classifyWorkerHealth({ terminal_started: true, model_launched: false, output: "agy: command not found" });
  assert.equal(h.failure_class, "INTEGRATION_UNAVAILABLE");
});

test("no false family-wide outage when one runtime path fails", () => {
  assert.deepEqual(runtimePathsForFamily(registry, "claude").map((p) => p.runtime_adapter), ["claude_cli", "antigravity"]);

  const claudeCliDown = familyDispatchable(registry, "claude", { providerAuth: { claude: "AUTH_EXPIRED", antigravity: "AUTH_OK" } });
  assert.equal(claudeCliDown.dispatchable, true);
  assert.deepEqual(claudeCliDown.paths.map((p) => [p.runtime_adapter, p.dispatchable]), [["claude_cli", false], ["antigravity", true]]);

  const agyDown = familyDispatchable(registry, "claude", { integration: { antigravity: "UNAVAILABLE" } });
  assert.equal(agyDown.dispatchable, true);
  assert.equal(agyDown.paths.find((p) => p.runtime_adapter === "claude_cli").dispatchable, true);

  // Gemini has a single runtime path, so its outage is real but named as the runtime's.
  const gemini = familyDispatchable(registry, "gemini", { integration: { antigravity: "UNAVAILABLE" } });
  assert.equal(gemini.dispatchable, false);
  assert.equal(gemini.paths[0].reason, "INTEGRATION_UNAVAILABLE");
});

test("Antigravity auth failure does not remove Claude CLI candidates from selection", () => {
  const green = { state: "GREEN", source: "PROVIDER_NATIVE_PROBE", checked_at: "2026-09-18T11:55:00Z", available: true, remaining_confidence: "HIGH" };
  const states = { claude: green, codex: green, antigravity: { gemini: green } };
  const r = selectCandidate(registry.capability_slots.LONG_CONTEXT_DISCOVERY, states, registry.capability_tier_order, {
    now: Date.parse("2026-09-18T12:00:00Z"),
    providerAuth: { antigravity: "AUTH_REQUIRED" },
  });
  assert.equal(r.status, "SELECTED");
  assert.equal(r.candidate.provider, "claude");
});
